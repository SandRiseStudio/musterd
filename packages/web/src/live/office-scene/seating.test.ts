import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { DESK_SLOTS } from './layout';
import { assignSeats } from './seating';

function member(name: string, over: Partial<MemberSummary> = {}): MemberSummary {
  return {
    id: `id-${name}`,
    team: 'ritual',
    name,
    kind: 'agent',
    role: '',
    lifecycle: 'forever',
    created_at: 0,
    presence: 'online',
    presences: [],
    activity: 'online',
    ...over,
  };
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
});
