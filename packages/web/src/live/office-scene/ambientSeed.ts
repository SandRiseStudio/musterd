/**
 * The shared ambient seed (E1 spec §2): every viewer of the same team computes the same idle life,
 * because every ambient decision is a pure function of inputs each browser already holds — the team
 * slug, the wall-clock slot, and a purpose tag. No PRNG stream exists to desync: a viewer that
 * skips a slot (hidden tab, mid-afterglow) reconverges on the next one by construction.
 *
 * Key material is deliberately only `team + slot + purpose`. `daemonEpoch` was considered and
 * rejected — it arrives from a best-effort async fetch, so mixing it in would make convergence
 * contingent on a race (spec §2).
 *
 * The mix is the same FNV-1a + fmix32 shape `appearance.ts` uses, and the finalizer is just as
 * load-bearing here: without the avalanche, structured keys ("revive\0…\0fire") produce correlated
 * draws and the weighted beat picks collapse into a few buckets.
 */

/** Wall-clock time divides into fixed slots; the slot is the ambient scheduling quantum. */
export const AMBIENT_SLOT_MS = 20_000;

/** The slot containing `nowMs` — `Date.now()` on any viewer's clock lands in the same slot barring boundary-grade skew. */
export function slotAt(nowMs: number, slotMs: number = AMBIENT_SLOT_MS): number {
  return Math.floor(nowMs / slotMs);
}

/** FNV-1a over the key string, finished with murmur3's fmix32 avalanche → [0, 1). */
function mix(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * One shared draw in [0, 1). `purpose` is a free string tag (`'fire'`, `'actor'`, `'beat'`,
 * `'pet-follow'`…) so a single slot yields as many independent rolls as a beat needs.
 */
export function roll(team: string, slot: number, purpose: string): number {
  return mix(`${team}\u0000${slot}\u0000${purpose}`);
}

/**
 * A slot-scoped sequence for beat interiors (walk hops, pause lengths) — drop-in for the `rng`
 * params `pet.ts` already takes. Counter state lives only inside this closure, so nothing survives
 * the slot: a viewer that never ran this slot's beat is not behind, just absent for one beat.
 */
export function slotRng(team: string, slot: number, purpose: string): () => number {
  let n = 0;
  return () => roll(team, slot, `${purpose}#${n++}`);
}

/**
 * The shared candidate pool: desk-seated present members and row-mate pairs, both derived from
 * roster + the shared envelope list — never from local scene state (walks, gestures, pending).
 * A pool input only one browser can see is how divergence persists past one slot; a browser whose
 * local state can't play the chosen beat declines it and skips the slot instead.
 */
export interface AmbientPool {
  members: string[];
  pairs: Array<[string, string]>;
}

export type AmbientDecision =
  | { kind: 'none' }
  | { kind: 'pet' }
  | { kind: 'pair'; a: string; b: string }
  | { kind: 'member'; who: string };

/** Per-slot fire probability. The old timer fired once per 30–70 s (mean 50 s); one 20 s slot at 0.4 keeps that rate. */
export const AMBIENT_FIRE_P = AMBIENT_SLOT_MS / 50_000;

/**
 * The whole per-slot decision: fire?, whose beat is it, which pair/member. Pure over
 * (team, slot, pool) — and the pool is canonicalized here (sorted members, ordered pairs) so a
 * caller's array order can never leak into the pick.
 */
export function decideAmbient(team: string, slot: number, pool: AmbientPool): AmbientDecision {
  const members = [...pool.members].sort();
  if (members.length === 0) return { kind: 'none' };
  if (roll(team, slot, 'fire') >= AMBIENT_FIRE_P) return { kind: 'none' };
  // The category split the timer scheduler used: pet 0.35, then pair 0.22 among the rest.
  if (roll(team, slot, 'pet') < 0.35) return { kind: 'pet' };
  const pairs = pool.pairs
    .map(([a, b]) => (a < b ? [a, b] : [b, a]) as [string, string])
    .sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1));
  if (pairs.length && roll(team, slot, 'pair') < 0.22) {
    const [a, b] = pairs[Math.floor(roll(team, slot, 'pair-pick') * pairs.length)]!;
    return { kind: 'pair', a, b };
  }
  return { kind: 'member', who: members[Math.floor(roll(team, slot, 'actor') * members.length)]! };
}
