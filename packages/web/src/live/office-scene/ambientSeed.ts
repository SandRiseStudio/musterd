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

/**
 * Wall-clock time divides into fixed slots; the slot is the ambient scheduling quantum.
 *
 * 20 s in E1a, halved to 10 s in E1b, because the slot length is the CEILING on density and 20 s
 * could not reach the spec's number. The room plays one ambient beat at a time (ADR 086, unmoved by
 * E1) and a beat occupies the room for ~8 s on average, so the delivered rate is
 * `1 / (meanWaitForAFire + meanBeatLength)`. At 20 s slots even a probability of 1.0 — every quiet
 * slot firing, i.e. no randomness left at all — tops out near 3.3 beats/idle-min, so the 2.5–3 band
 * was only reachable by making the room metronomic. At 10 s the band sits at a probability around
 * 0.7 and the lattice stays stochastic, which is the property that makes the room read as alive
 * rather than as a clock.
 *
 * 10 s is still comfortably above NTP-grade skew (§8's concern), and shorter than a slot no longer
 * needs to be: a slot landing mid-errand is declined by the room-quiet gate and simply passes, which
 * is the same skipped-slot path a hidden tab already takes.
 */
export const AMBIENT_SLOT_MS = 10_000;

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

/**
 * Occupancy → per-slot fire probability (E1b, spec §3): a populated room reads at ~2.5–3
 * beats/idle-minute, a room of two stays near the rate it has today so a near-empty office does not
 * read as twitchy.
 *
 * **Why the numbers are what they are.** The target in the spec is *delivered* beats — what a viewer
 * sees — and that is not the fire probability. Two losses sit between them, and both are measured
 * rather than assumed (`scripts/perf/ambient-density.mjs`, numbers in
 * `docs/perf/web-live-baseline.md`):
 *
 * 1. **The room-quiet gate.** One beat at a time (ADR 086): a slot landing while any actor is still
 *    moving never reaches this decision at all. This is the dominant loss and it grows with density,
 *    which is why the curve saturates rather than climbing forever.
 * 2. **The decline loss.** A fired slot whose chosen beat this browser cannot play is spent —
 *    the lattice does NOT fall through to another category the way the pre-E1a scheduler did inside
 *    a single firing (stanley, on #1060). That fallthrough is exactly what E1 removed on purpose:
 *    which beat plays must not depend on one browser's local state. So the probability here is
 *    calibrated against the OLD scheduler's delivered rate, not against E1a's — E1a sits below the
 *    room nick signed off on, at an identical fire probability, and buying that back is part of E1b.
 *
 * **Why a ramp and not a step.** A step means one person joining or going idle visibly changes the
 * cadence of the whole room at the moment they arrive — a viewer reads that as the room reacting to
 * them, which is a claim the scene has no business making. The ramp spreads the same range over the
 * occupancies a real team actually moves through.
 */
/** At or below this many idle desk members, the room keeps today's calm. */
export const AMBIENT_QUIET_ROOM = 2;
/** At or above this many, the room is "populated" and density is at the spec's target. */
export const AMBIENT_FULL_ROOM = 8;
/** Fire probability per slot at `AMBIENT_QUIET_ROOM`. Measured 2026-08-25 (ambient-density.mjs,
 * 8 min, n=2): 1.12 beats/idle-min — within 7% of the pre-E1a analytic rate of 1.2 (0.4/20 s slot
 * with the old same-firing category fallthrough ≈ playRate 1), which is the "today's calm" the
 * spec pins the quiet room to. */
export const AMBIENT_P_QUIET = 0.27;
/** Fire probability per slot at `AMBIENT_FULL_ROOM`. Measured 2026-08-25 (8 min, n=8):
 * 2.5 beats/idle-min — the bottom of the spec's 2.5–3 target band. Observed fire rate saturates at
 * ~0.5 here (3σ below p: a playing beat holds `quiet()` false, so following slots never reach the
 * roll), so raising this buys almost nothing — self-contention, not the roll, is the ceiling. */
export const AMBIENT_P_FULL = 0.7;

/** The curve: flat below `AMBIENT_QUIET_ROOM`, linear through the middle, flat above `AMBIENT_FULL_ROOM`. */
export function ambientFireP(members: number): number {
  if (members <= AMBIENT_QUIET_ROOM) return AMBIENT_P_QUIET;
  if (members >= AMBIENT_FULL_ROOM) return AMBIENT_P_FULL;
  const t = (members - AMBIENT_QUIET_ROOM) / (AMBIENT_FULL_ROOM - AMBIENT_QUIET_ROOM);
  return AMBIENT_P_QUIET + t * (AMBIENT_P_FULL - AMBIENT_P_QUIET);
}

/**
 * The whole per-slot decision: fire?, whose beat is it, which pair/member. Pure over
 * (team, slot, pool) — and the pool is canonicalized here (sorted members, ordered pairs) so a
 * caller's array order can never leak into the pick.
 */
export function decideAmbient(team: string, slot: number, pool: AmbientPool): AmbientDecision {
  const members = [...pool.members].sort();
  if (members.length === 0) return { kind: 'none' };
  // Occupancy comes from the canonical pool, so the probability is as roster-derived as the pick it
  // gates: two viewers of the same team draw the same fire decision as well as the same beat.
  if (roll(team, slot, 'fire') >= ambientFireP(members.length)) return { kind: 'none' };
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
