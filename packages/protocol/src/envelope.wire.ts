import type { Act } from './acts.wire.js';
import { PROTOCOL_VERSION } from './version.js';

/**
 * The envelope's validator-free half — the recipient/eligible shapes and the constructor — so a
 * client can read and compose an act without pulling zod into its bundle (`guards.ts`).
 * `envelope.ts` layers the zod schemas over exactly these types.
 */

/** Recipient of an envelope: a specific member, the whole team, or broadcast. */
export type Recipient = { kind: 'member'; name: string } | { kind: 'team' } | { kind: 'broadcast' };

/**
 * ADR 254: the eligible set — 2–`MAX_ELIGIBLE` named seats, **any one of whom discharges the act**.
 *
 * Four is the cap for two reasons, and the second is the load-bearing one. Above four, a named set
 * is `@team` with extra steps and the sender should be made to say so. But the cap also bounds the
 * escalation tail a later increment walks: at a 5-minute hold, four seats is ~20 minutes and at most
 * four `wake_cost` charges. Uncapped, both the latency and the spend of a serial walk are unbounded.
 */
export const MAX_ELIGIBLE = 4;

/**
 * Acts that may carry an eligible set. Deliberately narrow: a `handoff` to two seats is incoherent
 * (two owners is zero owners), and accept/decline/defer/steer are structurally single-target. That
 * restriction is what earns a single global "first answer wins" rule instead of a per-act table.
 */
export const ELIGIBLE_ACTS: ReadonlySet<Act> = new Set<Act>([
  'message',
  'request_help',
  'challenge',
]);

/**
 * The eligible set on an envelope's meta, or `null` when there isn't one (or it is malformed).
 *
 * The single reader of the shape — server, MCP, CLI and the browser all come through here, so no
 * package can interpret `meta.eligible` differently from the schema that validated it. A mixed-type
 * array returns `null` rather than a filtered list: silently dropping a name would mean silently
 * dropping an obligation.
 */
export function eligibleOf(meta: Record<string, unknown> | null | undefined): string[] | null {
  const v = meta?.['eligible'];
  if (!Array.isArray(v) || !v.every((n) => typeof n === 'string')) return null;
  return v as string[];
}

/** The envelope fields a caller supplies; the rest are filled by {@link buildEnvelope}. */
export interface EnvelopeInput {
  id: string;
  team: string;
  from: string;
  to: Recipient;
  act: Act;
  body?: string;
  thread?: string | null;
  meta?: Record<string, unknown> | null;
  ts?: number;
}

/**
 * Compose an envelope — the defaults (`v`, empty body, null thread/meta, now) in one place, with
 * **no validation**. `makeEnvelope` in `envelope.ts` is this plus `EnvelopeSchema.parse`, and is
 * what every writer inside the daemon uses. A browser composing an act it is about to POST uses
 * this directly: the daemon validates every envelope on ingest (that is the boundary that matters),
 * so re-checking a literal the client just built costs a validator in the bundle and catches
 * nothing the server would let through.
 */
export function buildEnvelope(input: EnvelopeInput): {
  id: string;
  v: string;
  team: string;
  from: string;
  to: Recipient;
  act: Act;
  body: string;
  thread: string | null;
  meta: Record<string, unknown> | null;
  ts: number;
} {
  return {
    id: input.id,
    v: PROTOCOL_VERSION,
    team: input.team,
    from: input.from,
    to: input.to,
    act: input.act,
    body: input.body ?? '',
    thread: input.thread ?? null,
    meta: input.meta ?? null,
    ts: input.ts ?? Date.now(),
  };
}
