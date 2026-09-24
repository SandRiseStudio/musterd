/**
 * The doorbell's validator-free half (ADR 443): the sink vocabulary and the ring rule, plain
 * TypeScript so `/live` can ask "does this act ring me?" without pulling zod into the bundle. The
 * zod module (`doorbell.ts`) builds its enum from this tuple and re-exports every name here.
 */

/** The four sinks, in route order. `live` is always on (ADR 443 §3). */
export const DOORBELL_SINKS = ['live', 'os', 'slack', 'webhook'] as const;
export type DoorbellSink = (typeof DOORBELL_SINKS)[number];

/** The sinks the daemon POSTs to — the off-machine ones ADR 155's present-admin quiet applies to. */
export const OFF_MACHINE_SINKS: ReadonlySet<DoorbellSink> = new Set(['slack', 'webhook']);

/** The acts that ring a human when **directed** to one (spec §1). */
const DIRECTED_RINGS = new Set(['ask', 'request_help', 'handoff']);

/** Can this act ring anyone at all? The cheap pre-check before {@link ringTargets} reads members. */
export function actMayRing(act: string): boolean {
  return DIRECTED_RINGS.has(act);
}

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
