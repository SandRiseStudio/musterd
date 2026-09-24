import { z } from 'zod';
import { AskSpeciesSchema, AskTierSchema, type AskTier } from './ask.js';
import { DOORBELL_SINKS, type DoorbellSink, OFF_MACHINE_SINKS } from './doorbell.wire.js';
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

export {
  actMayRing,
  DOORBELL_SINKS,
  type DoorbellSink,
  OFF_MACHINE_SINKS,
  ringTargets,
} from './doorbell.wire.js';

export const DoorbellSinkSchema = z.enum(DOORBELL_SINKS);

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

/** The host's ring claim (`POST /teams/:slug/doorbell/rings`), authenticated like the wake-lease
 *  poll: the team agent key, or a credential scoped to exactly this host label. */
export const DoorbellRingsBodySchema = z.object({ host: z.string().min(1) }).strict();

/** One ring handed to a host to raise as an OS banner: the record, and who it rings. */
export const DoorbellHostRingSchema = z.object({
  id: z.string(),
  member: z.string(),
  record: DoorbellRecordSchema,
});
export type DoorbellHostRing = z.infer<typeof DoorbellHostRingSchema>;

export const DoorbellRingsResponseSchema = z.object({ rings: z.array(DoorbellHostRingSchema) });
export type DoorbellRingsResponse = z.infer<typeof DoorbellRingsResponseSchema>;

/** The host's report that it raised (or failed to raise) a ring's banner. */
export const DoorbellSurfacedBodySchema = z
  .object({ host: z.string().min(1), ok: z.boolean() })
  .strict();

/**
 * How long a ring with no deadline (a handoff, a `request_help`) stays worth a banner. A host that
 * was asleep for a day should not wake to a wall of stale banners: `/live` and the inbox still hold
 * every one of them.
 */
export const DOORBELL_OS_MAX_AGE_MS = 60 * 60_000;

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

/** What anyone but the owner may see of one sink pref (ADR 443 §5): whether a personal URL exists,
 *  never the URL. */
export interface MaskedSinkPref {
  on: boolean;
  tiers?: DoorbellSinkPref['tiers'];
  host?: string;
  personal: boolean;
}

/** The one mask every non-self read of a human's doorbell prefs goes through (ADR 443 §5). */
export function maskPrefs(
  prefs: DoorbellPrefs | undefined,
): Partial<Record<DoorbellSink, MaskedSinkPref>> {
  const out: Partial<Record<DoorbellSink, MaskedSinkPref>> = {};
  for (const sink of DOORBELL_SINKS) {
    const pref = prefs?.sinks[sink];
    if (!pref) continue;
    out[sink] = {
      on: pref.on,
      ...(pref.tiers ? { tiers: pref.tiers } : {}),
      ...(pref.host ? { host: pref.host } : {}),
      personal: pref.url !== undefined,
    };
  }
  return out;
}

/**
 * Why a human may not save these prefs, or null (ADR 443 §4–5): a sink turned on must be in the
 * team's allow-list; a URL rides only `slack`/`webhook` and must be `https` to a public host. The
 * reason names the sink and never echoes a URL.
 */
export function doorbellPrefsProblem(
  prefs: DoorbellPrefs,
  allow: readonly DoorbellSink[],
): string | null {
  for (const sink of DOORBELL_SINKS) {
    const pref = prefs.sinks[sink];
    if (!pref) continue;
    if (pref.on && sink !== 'live' && !allow.includes(sink))
      return `the ${sink} sink is not allowed on this team`;
    if (pref.url === undefined) continue;
    if (!OFF_MACHINE_SINKS.has(sink)) return `the ${sink} sink takes no url`;
    const problem = publicHttpsUrlProblem(pref.url);
    if (problem) return `the ${sink} url ${problem}`;
  }
  return null;
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
  // WHATWG keeps a trailing dot (`localhost.`), and it resolves like the undotted name.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
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
