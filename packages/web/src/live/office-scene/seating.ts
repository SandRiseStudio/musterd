import { DESK_SLOTS } from './layout';

/** The minimal member shape seating needs — satisfied by both `MemberSummary` and `OfficeNode`. */
export interface Seatable {
  name: string;
  presence: 'online' | 'away' | 'offline';
  availability?: { status: 'available' | 'away' | 'dnd' | 'off_hours' } | null | undefined;
}

/** Where a member is rendered this frame. */
export type Placement =
  | { kind: 'desk'; slot: number }
  | { kind: 'nook' }
  | { kind: 'strip'; index: number }
  | { kind: 'gone' };

/** FNV-ish name hash — same idiom as `memberColor`, so seat + colour derive from one stable source. */
function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

/** A member reads as "away" from explicit presence or a self-set away/dnd availability. */
export function isAway(m: Seatable): boolean {
  return (
    m.presence === 'away' ||
    m.availability?.status === 'away' ||
    m.availability?.status === 'dnd'
  );
}

/**
 * Deterministic, stable seat assignment — **independent of roster array order**. Present-and-working
 * members compete for a desk (hash → linear-probe to the first free slot); `away` members go to the
 * break nook; `offline` members are gone (empty desk / exited); overflow beyond the 12 desks queues on
 * the entrance strip. The sort-by-name + deterministic probe guarantee the same roster always yields
 * the same seating, so avatars don't teleport between reloads or presence pings.
 */
export function assignSeats(members: Seatable[]): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const N = DESK_SLOTS.length;
  const taken = new Array<boolean>(N).fill(false);

  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
  const present = sorted.filter((m) => m.presence !== 'offline');
  const away = present.filter((m) => isAway(m));
  const desking = present.filter((m) => !isAway(m));

  let overflow = 0;
  for (const m of desking) {
    const start = hash(m.name) % N;
    let placed = false;
    for (let i = 0; i < N; i++) {
      const j = (start + i) % N;
      if (!taken[j]) {
        taken[j] = true;
        out.set(m.name, { kind: 'desk', slot: j });
        placed = true;
        break;
      }
    }
    if (!placed) out.set(m.name, { kind: 'strip', index: overflow++ });
  }
  for (const m of away) out.set(m.name, { kind: 'nook' });
  for (const m of sorted) if (m.presence === 'offline') out.set(m.name, { kind: 'gone' });
  return out;
}
