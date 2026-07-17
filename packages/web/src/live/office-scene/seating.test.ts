import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { memberPosture } from '../format';
import { DESK_SLOTS, LEISURE_SPOTS } from './layout';
import { assignSeats, type Seatable } from './seating';

/** A working member by default — desks are for members with a task in hand. */
function member(name: string, over: Partial<MemberSummary> = {}): Seatable {
  const m: MemberSummary = {
    id: `id-${name}`,
    team: 'ritual',
    name,
    kind: 'agent',
    role: '',
    lifecycle: 'forever',
    created_at: 0,
    presence: 'online',
    presences: [],
    activity: 'working',
    ...over,
  };
  // The real caller (`OfficeScene.computeData`) resolves posture exactly this way.
  return { ...m, posture: memberPosture(m) };
}

function shuffle<T>(a: T[], seed: number): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('assignSeats', () => {
  it('is deterministic regardless of roster array order', () => {
    const roster = ['ada', 'ben', 'cy', 'dee', 'ez', 'fin'].map((n) => member(n));
    const a = assignSeats(shuffle(roster, 7));
    const b = assignSeats(shuffle(roster, 999));
    for (const m of roster) {
      expect(a.get(m.name)).toEqual(b.get(m.name));
    }
  });

  it('gives each present working member a distinct desk (no collisions)', () => {
    const roster = Array.from({ length: DESK_SLOTS.length }, (_, i) => member(`m${i}`));
    const seats = assignSeats(roster);
    const slots = new Set<number>();
    for (const m of roster) {
      const p = seats.get(m.name)!;
      expect(p.kind).toBe('desk');
      if (p.kind === 'desk') slots.add(p.slot);
    }
    expect(slots.size).toBe(DESK_SLOTS.length);
  });

  it('overflows to the entrance strip past the desk count', () => {
    const n = DESK_SLOTS.length + 3;
    const roster = Array.from({ length: n }, (_, i) => member(`m${i}`));
    const seats = assignSeats(roster);
    const strip = roster.filter((m) => seats.get(m.name)?.kind === 'strip');
    const desks = roster.filter((m) => seats.get(m.name)?.kind === 'desk');
    expect(desks).toHaveLength(DESK_SLOTS.length);
    expect(strip).toHaveLength(3);
  });

  it('sends away members to the nook and offline members away', () => {
    const roster = [
      member('here'),
      member('resting', { presence: 'away' }),
      member('dnd', { availability: { status: 'dnd' } }),
      member('left', { presence: 'offline' }),
    ];
    const seats = assignSeats(roster);
    expect(seats.get('here')?.kind).toBe('desk');
    expect(seats.get('resting')?.kind).toBe('nook');
    expect(seats.get('dnd')?.kind).toBe('nook');
    expect(seats.get('left')?.kind).toBe('gone');
  });

  it('sends idle members to the leisure furniture, not to a desk', () => {
    const roster = [member('busy'), member('slacking', { activity: 'idle' })];
    const seats = assignSeats(roster);
    expect(seats.get('busy')?.kind).toBe('desk');
    expect(seats.get('slacking')?.kind).toBe('leisure');
  });

  it('gives every idle member a distinct leisure spot (no two on one cushion)', () => {
    const roster = Array.from({ length: LEISURE_SPOTS.length }, (_, i) =>
      member(`m${i}`, { activity: 'idle' }),
    );
    const seats = assignSeats(roster);
    const spots = new Set<number>();
    for (const m of roster) {
      const p = seats.get(m.name)!;
      expect(p.kind).toBe('leisure');
      if (p.kind === 'leisure') spots.add(p.spot);
    }
    expect(spots.size).toBe(LEISURE_SPOTS.length);
  });

  it('spills idle members onto desks only once the leisure furniture is full', () => {
    const n = LEISURE_SPOTS.length + 3;
    const roster = Array.from({ length: n }, (_, i) => member(`m${i}`, { activity: 'idle' }));
    const seats = assignSeats(roster);
    const kinds = roster.map((m) => seats.get(m.name)?.kind);
    expect(kinds.filter((k) => k === 'leisure')).toHaveLength(LEISURE_SPOTS.length);
    expect(kinds.filter((k) => k === 'desk')).toHaveLength(3);
  });

  it('never spills an idle member onto a desk a working member needs', () => {
    // Leisure full + every desk contested: working members win the desks, the rest queue.
    const idle = Array.from({ length: LEISURE_SPOTS.length + 6 }, (_, i) =>
      member(`i${i}`, { activity: 'idle' }),
    );
    const working = Array.from({ length: DESK_SLOTS.length }, (_, i) => member(`w${i}`));
    const seats = assignSeats([...idle, ...working]);
    for (const m of working) expect(seats.get(m.name)?.kind).toBe('desk');
  });
});
