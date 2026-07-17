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
}

/** Where a member is rendered this frame. */
export type Placement =
  | { kind: 'desk'; slot: number }
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

/** A member reads as "away" from the composed posture, explicit presence, or a self-set away/dnd. */
export function isAway(m: Seatable): boolean {
  return (
    m.posture === 'away' ||
    m.presence === 'away' ||
    m.availability?.status === 'away' ||
    m.availability?.status === 'dnd'
  );
}

/** A member is out of the room entirely — gone from the floor, not merely resting on it. */
function isGone(m: Seatable): boolean {
  return m.presence === 'offline' || m.posture === 'offline';
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

  // Idle first — they have first call on the leisure furniture, and the desks they'd otherwise hold.
  const spilled: Seatable[] = [];
  for (const m of rest.filter((m) => m.posture === 'idle')) {
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
  for (const m of rest) if (m.posture !== 'idle') toDesk(m);
  for (const m of spilled) toDesk(m);

  for (const m of away) out.set(m.name, { kind: 'nook' });
  for (const m of sorted) if (isGone(m)) out.set(m.name, { kind: 'gone' });
  return out;
}
