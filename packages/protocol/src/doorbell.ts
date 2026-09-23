import { z } from 'zod';
import { AskSpeciesSchema, AskTierSchema, type AskTier } from './ask.js';
import type { Availability } from './member.js';

/**
 * The doorbell (ADR 443) — how a human is rung when something is addressed to them, through
 * surfaces musterd owns and never through a harness session (spec 2026-09-23 §1).
 *
 * Everything here is pure: what rings ({@link ringTargets}), the body-less record
 * ({@link DoorbellRecordSchema}), who routes where ({@link resolveRoute}), what holds
 * ({@link holdsRing}), and which sink URLs are acceptable ({@link publicHttpsUrlProblem}). The daemon
 * passes roster facts in and resolves URLs itself; the host and `/live` read the same record.
 */

/** The four sinks, in route order. `live` is always on (ADR 443 §3). */
export const DOORBELL_SINKS = ['live', 'os', 'slack', 'webhook'] as const;
export const DoorbellSinkSchema = z.enum(DOORBELL_SINKS);
export type DoorbellSink = z.infer<typeof DoorbellSinkSchema>;

/** The sinks the daemon POSTs to — the off-machine ones ADR 155's present-admin quiet applies to. */
export const OFF_MACHINE_SINKS: ReadonlySet<DoorbellSink> = new Set(['slack', 'webhook']);

/**
 * The doorbell record: structured fields only (the ADR 088 §4 discipline). **No body**, and the
 * schema is strict so a body is refused rather than silently dropped. The `slack` sink's ADR 149
 * body exception reads the body from the envelope at dispatch; it never enters this record.
 */
export const DoorbellRecordSchema = z
  .object({
    team: z.string(),
    from: z.string(),
    act: z.string(),
    species: AskSpeciesSchema.optional(),
    tier: AskTierSchema.optional(),
    act_id: z.string(),
    /** ms epoch when the ask's tier contract elapses; asks only. */
    deadline_ms: z.number().int().optional(),
    /** Where the human answers: `/live?act=<id>` (ADR 222). */
    answer_path: z.string(),
  })
  .strict();
export type DoorbellRecord = z.infer<typeof DoorbellRecordSchema>;

/**
 * Team doorbell policy (admin-set, `PolicySchema.doorbell`). `parse({})` allows every sink,
 * defaults to the on-machine ones, and configures no outbound URL — so no outbound call ever until
 * an admin or a human sets one. The URLs are secrets with `ask_slack_webhook`'s handling.
 */
export const DoorbellPolicySchema = z.object({
  allow: z.array(DoorbellSinkSchema).default([...DOORBELL_SINKS]),
  defaults: z.array(DoorbellSinkSchema).default(['live', 'os']),
  slack_url: z.string().url().optional(),
  webhook_url: z.string().url().optional(),
});
export type DoorbellPolicy = z.infer<typeof DoorbellPolicySchema>;

/** One human's override for one sink. `url` is a personal Slack/webhook URL, private to its owner;
 *  `host` is the `os` sink's machine label. */
export const DoorbellSinkPrefSchema = z.object({
  on: z.boolean(),
  tiers: z.array(AskTierSchema).optional(),
  url: z.string().url().optional(),
  host: z.string().min(1).optional(),
});
export type DoorbellSinkPref = z.infer<typeof DoorbellSinkPrefSchema>;

/** A human's own doorbell prefs (`members.doorbell_prefs`). `parse({})` = no overrides. */
export const DoorbellPrefsSchema = z.object({
  sinks: z.record(DoorbellSinkSchema, DoorbellSinkPrefSchema).default({}),
});
export type DoorbellPrefs = z.infer<typeof DoorbellPrefsSchema>;

/** The acts that ring a human when **directed** to one (spec §1). */
const DIRECTED_RINGS = new Set(['ask', 'request_help', 'handoff']);

/**
 * Which human members this act rings (ADR 443 §2):
 * - a directed `ask`, `request_help` or `handoff` to a human rings that human;
 * - any other `ask` — team-addressed, or directed to an agent — rings every **admin** human (ADR
 *   147 routing), never every human;
 * - a `lane_review` acceptance ask rings only when directed to a human: between agents it is peer
 *   review, and team-addressed it waits on `/live` like `request_help` and `handoff`;
 * - nothing else rings.
 */
export function ringTargets(input: {
  act: string;
  /** The directed recipient's name, or null for a team/broadcast address. */
  to: string | null;
  meta: Record<string, unknown> | null | undefined;
  humans: ReadonlySet<string>;
  admins: ReadonlySet<string>;
}): string[] {
  const { act, to, meta, humans, admins } = input;
  if (!DIRECTED_RINGS.has(act)) return [];
  if (to !== null && humans.has(to)) return [to];
  if (act !== 'ask' || isLaneReview(meta)) return [];
  return [...admins].filter((name) => humans.has(name));
}

function isLaneReview(meta: Record<string, unknown> | null | undefined): boolean {
  const review = meta?.['lane_review'];
  return typeof review === 'object' && review !== null;
}

/**
 * The sinks one human is rung on, in {@link DOORBELL_SINKS} order: always `live`, then each sink the
 * team allows that is on by the human's override or, with no override, in the team defaults —
 * filtered by the override's per-tier rule (an act with no tier passes it). Names only: URL and host
 * resolution is the daemon's job.
 */
export function resolveRoute(
  policy: DoorbellPolicy,
  prefs: DoorbellPrefs | undefined,
  tier: AskTier | undefined,
): DoorbellSink[] {
  const allow = new Set(policy.allow);
  const defaults = new Set(policy.defaults);
  return DOORBELL_SINKS.filter((sink) => {
    if (sink === 'live') return true;
    if (!allow.has(sink)) return false;
    const pref = prefs?.sinks[sink];
    if (!pref) return defaults.has(sink);
    if (!pref.on) return false;
    return !pref.tiers || tier === undefined || pref.tiers.includes(tier);
  });
}

/**
 * Does this availability hold a ring (ADR 443 §4)? A self-set `away` or `dnd` holds; `blocking`
 * pierces `dnd` (ADR 044) but not `away`. `off_hours` never holds — schedule enforcement is out of
 * scope for v1. An availability whose `until` has passed has lapsed and holds nothing.
 */
export function holdsRing(
  availability: Availability | null | undefined,
  tier: AskTier | undefined,
  now: number,
): boolean {
  if (!availability) return false;
  if (typeof availability.until === 'number' && availability.until <= now) return false;
  if (availability.status === 'away') return true;
  if (availability.status === 'dnd') return tier !== 'blocking';
  return false;
}

/**
 * Why this URL may not be a doorbell sink, or null if it may (ADR 443 §5): it must be `https` to a
 * public host. Loopback, link-local, private (RFC 1918, `fc00::/7`), unspecified and `.local` /
 * `localhost` hosts are refused, so a human's personal URL cannot make the daemon POST into the
 * local network. The check is on the literal host (the WHATWG parser already normalizes numeric
 * forms like `2130706433`); it does not resolve DNS. The reason never echoes the URL.
 */
export function publicHttpsUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid url';
  }
  if (url.protocol !== 'https:') return 'must use https';
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return 'must not point at a private, loopback or link-local host';
  return null;
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.startsWith('[')) return isPrivateIpv6(host.slice(1, -1));
  const v4 = parseIpv4(host);
  return v4 !== null && isPrivateIpv4(v4);
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  return (
    a === 0 || // unspecified / "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, RFC 6598
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(addr: string): boolean {
  if (addr === '::' || addr === '::1') return true;
  // IPv4-mapped (`::ffff:7f00:1` after WHATWG normalization): judge the embedded IPv4.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (mapped?.[1] && mapped[2]) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  const first = parseInt(addr.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}
