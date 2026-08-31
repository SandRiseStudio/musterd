import type { Posture } from '@musterd/protocol';
import { DESK_SLOTS, LEISURE_SPOTS } from './layout';

/** The minimal member shape seating needs — satisfied by both `MemberSummary` and `OfficeNode`. */
export interface Seatable {
  name: string;
  presence: 'online' | 'away' | 'offline';
  /** The composed roster posture (ADR 138) — **the same value the roster chip reads**, so the floor and
   * the rail can never disagree about who is working. Callers resolve it once (`memberPosture`). */
  posture: Posture;
  availability?: { status: 'available' | 'away' | 'dnd' | 'off_hours' } | null | undefined;
  /** Why the seat is dark (ADR 141/315) — `left_team` is the one reason that empties the desk. */
  offline_reason?: string | null | undefined;
  /** When the seat was last seen — decides who loses a desk when owners outnumber slots. */
  last_seen_at?: number | null | undefined;
}

/** Where a member is rendered this frame. */
export type Placement =
  | { kind: 'desk'; slot: number; owned?: true }
  /** An idle member, on the room's leisure furniture — index into `LEISURE_SPOTS`. */
  | { kind: 'leisure'; spot: number }
  | { kind: 'nook' }
  | { kind: 'strip'; index: number }
  | { kind: 'gone' };

/** FNV-ish name hash — same idiom as `memberColor`, so seat + colour derive from one stable source. */
function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Is this seat *audibly* working — may the room type, tap and creak from its desk?
 *
 * Keys on the composed posture, never `activity` (E2 spec §2): activity lags, and a stale
 * `activity: working` with posture folded to idle used to sit on the lounge couch drumming an
 * imaginary keyboard. This is the same predicate the renderer types and lights screens on
 * (`render.ts` `skelFor` / screen glow), and the render loop's park check shares it too — one
 * predicate for eyes, ears and the loop, so none of the three can disagree.
 */
export function audiblyWorking(m: Pick<Seatable, 'posture'>): boolean {
  return m.posture === 'working';
}

/** dnd means *working, don't interrupt* (presence-honesty §4) — they keep their desk and chair. */
export function isDnd(m: Seatable): boolean {
  return m.availability?.status === 'dnd';
}

/**
 * A member reads as "stepped away" — declared absence. Their body leaves the floor; the desk stays
 * theirs (jacket over the chair, `stepped away` on the plate). dnd is deliberately NOT this: dnd
 * folds into posture `away` on the wire (ADR 044), but on the floor it is presence at a desk.
 */
export function isAway(m: Seatable): boolean {
  return (
    !isDnd(m) &&
    (m.posture === 'away' || m.presence === 'away' || m.availability?.status === 'away')
  );
}

/** A member is dark on the roster — their desk stays owned unless they left the team. */
function isGone(m: Seatable): boolean {
  return m.presence === 'offline' || m.posture === 'offline';
}

/** Out of the room entirely: leaving the team is the line, not presence (presence-honesty §4). */
function leftTeam(m: Seatable): boolean {
  return m.offline_reason === 'left_team';
}

/** Hash → linear-probe to the first free index of a fixed-size zone. `-1` when the zone is full. */
function probe(name: string, taken: boolean[]): number {
  const n = taken.length;
  const start = hash(name) % n;
  for (let i = 0; i < n; i++) {
    const j = (start + i) % n;
    if (!taken[j]) {
      taken[j] = true;
      return j;
    }
  }
  return -1;
}

/**
 * Deterministic, stable seat assignment — **independent of roster array order**. Posture decides the
 * zone (ADR 138/140): `working` members compete for a desk, `idle` members take the room's leisure
 * furniture (couch, huddle poufs, meeting table, the shelves), `away` members go to the break nook, and
 * `offline` members are gone (empty desk / exited). Within a zone it's hash → linear-probe to the first
 * free spot; overflow past every desk queues on the entrance strip. The sort-by-name + deterministic
 * probe guarantee the same roster always yields the same seating, so avatars don't teleport between
 * reloads or presence pings.
 *
 * **Idle members claim leisure spots before working members claim desks**, and only fall back to a desk
 * when the leisure furniture is full — so a desk is never occupied by someone idle while a couch sits
 * empty. That inversion is the whole contract: on this floor, an occupied desk means work in progress.
 */
export function assignSeats(members: Seatable[]): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const desks = new Array<boolean>(DESK_SLOTS.length).fill(false);
  const spots = new Array<boolean>(LEISURE_SPOTS.length).fill(false);

  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
  const present = sorted.filter((m) => !isGone(m));
  const away = present.filter((m) => isAway(m));
  const rest = present.filter((m) => !isAway(m));

  // Active (between claims) first — they have first call on the leisure furniture, and the desks
  // they'd otherwise hold. dnd never lounges: away-posture from a dnd fold still means at-desk.
  const spilled: Seatable[] = [];
  for (const m of rest.filter((m) => m.posture === 'active' && !isDnd(m))) {
    const spot = probe(m.name, spots);
    if (spot >= 0) out.set(m.name, { kind: 'leisure', spot });
    else spilled.push(m); // lounge full — they wait it out at a desk, below
  }

  let overflow = 0;
  const toDesk = (m: Seatable): void => {
    const slot = probe(m.name, desks);
    if (slot >= 0) out.set(m.name, { kind: 'desk', slot });
    else out.set(m.name, { kind: 'strip', index: overflow++ });
  };
  for (const m of rest) if (m.posture !== 'active' || isDnd(m)) toDesk(m);
  for (const m of spilled) toDesk(m);

  // Stepped-away members keep their desk without a body (jacket over the chair): the same
  // owned-desk shape offline owners get, claimed before them — an away member is still present.
  for (const m of away) {
    const slot = probe(m.name, desks);
    if (slot >= 0) out.set(m.name, { kind: 'desk', slot, owned: true });
    else out.set(m.name, { kind: 'nook' }); // desks exhausted — the old nook keeps them visible
  }

  // Owned empty desks (presence-honesty §4): every offline member except `left_team` keeps a desk —
  // the room must not empty when the team sleeps. Present members claimed desks above (zero
  // regression); owners fill what remains by the same name-hash probe, freshest-gone first, so when
  // desks run out it is the longest-gone who lose theirs. Deterministic; normal rosters keep every desk.
  const owners = sorted
    .filter((m) => isGone(m) && !leftTeam(m))
    .sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0) || a.name.localeCompare(b.name));
  for (const m of owners) {
    const slot = probe(m.name, desks);
    if (slot >= 0) out.set(m.name, { kind: 'desk', slot, owned: true });
    else out.set(m.name, { kind: 'gone' }); // desks exhausted — the longest-gone wait outside
  }
  for (const m of sorted) if (isGone(m) && leftTeam(m)) out.set(m.name, { kind: 'gone' });
  return out;
}
