import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { memberPosture } from '../format';
import { DESK_SLOTS, LEISURE_SPOTS } from './layout';
import { assignSeats, audiblyWorking, carriesLaptop, workingAtDesk, type Seatable } from './seating';

/** A working member by default — desks are for members with a task in hand. */
function member(name: string, over: Partial<MemberSummary> = {}): Seatable {
  const m: MemberSummary = {
    id: `id-${name}`,
    team: 'ritual',
    name,
    kind: 'agent',
    role: '',
    roles: [],
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

describe('assignSeats — away/dnd floor split (presence-honesty §4 lane 4)', () => {
  it('dnd sits at their own desk — working, do not interrupt', () => {
    const seats = assignSeats([member('focused', { availability: { status: 'dnd' } })]);
    expect(seats.get('focused')).toMatchObject({ kind: 'desk' });
    expect((seats.get('focused') as { owned?: boolean }).owned).toBeUndefined();
  });

  it('away leaves the floor: their desk stays theirs, jacket not body', () => {
    const seats = assignSeats([member('stepped', { availability: { status: 'away' } })]);
    expect(seats.get('stepped')).toMatchObject({ kind: 'desk', owned: true });
  });

  it('presence away reads the same as declared away', () => {
    const seats = assignSeats([member('gone-a-min', { presence: 'away' })]);
    expect(seats.get('gone-a-min')).toMatchObject({ kind: 'desk', owned: true });
  });
});

describe('assignSeats — owned desks (presence-honesty §4)', () => {
  const offline = (name: string, over: Partial<Seatable> = {}): Seatable => ({
    ...member(name, { presence: 'offline', activity: 'offline' }),
    posture: 'offline',
    ...over,
  });

  it('an offline member keeps an owned desk — the room never empties', () => {
    const seats = assignSeats([member('busy'), offline('sleeper')]);
    expect(seats.get('sleeper')).toMatchObject({ kind: 'desk', owned: true });
    expect(seats.get('busy')).toMatchObject({ kind: 'desk' });
    expect((seats.get('busy') as { owned?: boolean }).owned).toBeUndefined();
  });

  it('left_team members leave the room entirely — left_at is the line, not presence', () => {
    const seats = assignSeats([offline('quit', { offline_reason: 'left_team' })]);
    expect(seats.get('quit')).toEqual({ kind: 'gone' });
  });

  it('legacy signed_off reads as a release, not a departure — the desk stays owned', () => {
    const seats = assignSeats([offline('old', { offline_reason: 'signed_off' })]);
    expect(seats.get('old')).toMatchObject({ kind: 'desk', owned: true });
  });

  it('present members claim desks first; when desks run out, longest-gone lose theirs first', () => {
    const now = Date.now();
    const roster = [
      ...Array.from({ length: DESK_SLOTS.length - 1 }, (_, i) => member(`w${i}`)),
      offline('fresh', { last_seen_at: now - 60_000 }),
      offline('ancient', { last_seen_at: now - 7 * 24 * 3_600_000 }),
    ];
    const seats = assignSeats(roster);
    for (let i = 0; i < DESK_SLOTS.length - 1; i++)
      expect(seats.get(`w${i}`)!.kind).toBe('desk');
    // One desk left for two owners: the freshest-gone keeps it, the longest-gone loses theirs.
    expect(seats.get('fresh')).toMatchObject({ kind: 'desk', owned: true });
    expect(seats.get('ancient')).toEqual({ kind: 'gone' });
  });
});

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

  it('splits the non-working ways to be present: away keeps a bodiless desk, dnd sits at theirs, offline owns theirs', () => {
    const roster = [
      member('here'),
      member('resting', { presence: 'away' }),
      member('dnd', { availability: { status: 'dnd' } }),
      member('left', { presence: 'offline', offline_reason: 'left_team' }),
      member('dark', { presence: 'offline' }),
    ];
    const seats = assignSeats(roster);
    expect(seats.get('here')?.kind).toBe('desk');
    // Away is declared absence: desk kept, body off the floor (presence-honesty §4 lane 4).
    expect(seats.get('resting')).toMatchObject({ kind: 'desk', owned: true });
    // dnd is working-don't-interrupt: at their own desk, body present.
    expect(seats.get('dnd')).toMatchObject({ kind: 'desk' });
    expect((seats.get('dnd') as { owned?: boolean }).owned).toBeUndefined();
    expect(seats.get('left')?.kind).toBe('gone');
    // An offline member who has not left keeps an owned desk (presence-honesty §4).
    expect(seats.get('dark')).toMatchObject({ kind: 'desk', owned: true });
  });

  it('sends idle members to the leisure furniture, not to a desk', () => {
    const roster = [member('busy'), member('slacking', { activity: 'active' })];
    const seats = assignSeats(roster);
    expect(seats.get('busy')?.kind).toBe('desk');
    expect(seats.get('slacking')?.kind).toBe('leisure');
  });

  it('gives every idle member a distinct leisure spot (no two on one cushion)', () => {
    const roster = Array.from({ length: LEISURE_SPOTS.length }, (_, i) =>
      member(`m${i}`, { activity: 'active' }),
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
    const roster = Array.from({ length: n }, (_, i) => member(`m${i}`, { activity: 'active' }));
    const seats = assignSeats(roster);
    const kinds = roster.map((m) => seats.get(m.name)?.kind);
    expect(kinds.filter((k) => k === 'leisure')).toHaveLength(LEISURE_SPOTS.length);
    expect(kinds.filter((k) => k === 'desk')).toHaveLength(3);
  });

  it('never spills an idle member onto a desk a working member needs', () => {
    // Leisure full + every desk contested: working members win the desks, the rest queue.
    const idle = Array.from({ length: LEISURE_SPOTS.length + 6 }, (_, i) =>
      member(`i${i}`, { activity: 'active' }),
    );
    const working = Array.from({ length: DESK_SLOTS.length }, (_, i) => member(`w${i}`));
    const seats = assignSeats([...idle, ...working]);
    for (const m of working) expect(seats.get(m.name)?.kind).toBe('desk');
  });
});

describe('audiblyWorking (E2 spec §2 — one predicate for eyes, ears and the loop)', () => {
  it('keys on posture, never activity — stale activity must not drum an imaginary keyboard', () => {
    // activity says working, but the composed posture folded it to away (the lounge-couch case).
    const stale = member('stale', { availability: { status: 'away' } });
    expect(stale.posture).not.toBe('working');
    expect(audiblyWorking(stale)).toBe(false);
    // The evidenced case: posture working is what the renderer types and lights screens on.
    expect(audiblyWorking(member('busy'))).toBe(true);
  });

  it('stays quiet for idle and offline seats', () => {
    expect(audiblyWorking(member('idle', { activity: 'active' }))).toBe(false);
    expect(audiblyWorking(member('gone', { presence: 'offline', activity: 'offline' }))).toBe(false);
  });
});

describe('carriesLaptop — the biconditional (laptop/dock design §0)', () => {
  // "The laptop is docked ⟺ the member is working at their desk. Every other moment it is on their
  // person." The falsifier the design asks for: over a roster in every floor state, `docked` is true
  // exactly when `audiblyWorking` is, and on-person is its negation — never both, never neither.
  const roster: Seatable[] = [
    member('working'),
    member('focused', { availability: { status: 'dnd' } }),
    member('resting', { activity: 'active' }),
    member('stepped', { availability: { status: 'away' } }),
    member('gone', { presence: 'offline', activity: 'offline' }),
  ];

  it('on-person is exactly the negation of docked, for every member on the floor', () => {
    for (const m of roster) {
      const docked = audiblyWorking(m); // the dock and the monitor both read this one predicate
      expect(carriesLaptop(m)).toBe(!docked);
    }
  });

  it('there is no sixth state — the roster splits cleanly and both halves are non-empty', () => {
    const docked = roster.filter((m) => audiblyWorking(m));
    const onPerson = roster.filter((m) => carriesLaptop(m));
    expect(docked.length + onPerson.length).toBe(roster.length);
    expect(docked.map((m) => m.name)).toEqual(['working']);
    // `focused` is dnd, which folds to posture `away` on the wire (ADR 044) while seating keeps them
    // at their own desk. So they sit at a desk with an empty dock and the laptop in their lap — the
    // design's one known simplification, pinned here so it stays a choice rather than a surprise.
    expect(onPerson.map((m) => m.name)).toEqual(['focused', 'resting', 'stepped', 'gone']);
  });

  it('a member the floor has no node for carries it — a ghost walking out keeps their laptop', () => {
    // The leaving body is drawn after the roster has dropped it. An empty dock is what their desk
    // should say at that moment, so the laptop must be on the person, not in the slot.
    expect(carriesLaptop(undefined)).toBe(true);
  });
});

describe('workingAtDesk — one predicate for eyes, ears and the loop (E2 §2)', () => {
  // The screen, the dock, the room's typing and the park check all read this. What the roster half
  // could not say on its own is whether the body had arrived, and everything about work fired early
  // because of it (nick, 2026-09-04): a seat that came online already `working` lit its screen and
  // typed from a desk it was still walking toward.
  const busy = member('busy');

  it('is false while a working member is still crossing the floor', () => {
    expect(audiblyWorking(busy)).toBe(true); // the roster already says working…
    expect(workingAtDesk(busy, 0)).toBe(false); // …but nobody is in the chair yet
  });

  it('is still false part-way into the sit — the same 0.9 the typing hands use', () => {
    expect(workingAtDesk(busy, 0.85)).toBe(false);
    expect(workingAtDesk(busy, 0.9)).toBe(false); // strictly greater, as in skelFor
    expect(workingAtDesk(busy, 0.95)).toBe(true);
  });

  it('is true only for a member the roster ALSO calls working', () => {
    expect(workingAtDesk(member('resting', { activity: 'active' }), 1)).toBe(false);
    expect(workingAtDesk(member('focused', { availability: { status: 'dnd' } }), 1)).toBe(false);
    expect(workingAtDesk(busy, 1)).toBe(true);
  });

  it('a desk with no body at all is not at work — an offline owner keeps a dark screen', () => {
    expect(workingAtDesk(undefined, 1)).toBe(false); // no node
    expect(workingAtDesk(busy, undefined)).toBe(false); // node, but no pose on the floor
  });

  it('is exactly the negation of the laptop being on the person, for a member at their desk', () => {
    // The dock fills as the screen wakes and the arm empties: one event, read three ways.
    expect(workingAtDesk(busy, 1)).toBe(!carriesLaptop(busy));
  });
});

describe('assignSeats — the huddle gathers at the meeting table (ADR 378 inc 2)', () => {
  const meetingSpots = LEISURE_SPOTS.map((s, i) => ({ s, i })).filter(
    ({ s }) => s.zone === 'meeting',
  );
  const isMeeting = (p: ReturnType<typeof assignSeats> extends Map<string, infer P> ? P : never) =>
    p.kind === 'leisure' && meetingSpots.some(({ i }) => i === p.spot);

  it('seats a gathered member at the meeting table even though they are working', () => {
    const seats = assignSeats([member('talker')], new Set(['talker']));
    expect(isMeeting(seats.get('talker')!)).toBe(true);
  });

  it('leaves everyone else where they were — a huddle moves its own members only', () => {
    const seats = assignSeats([member('talker'), member('typer')], new Set(['talker']));
    expect(seats.get('typer')).toMatchObject({ kind: 'desk' });
  });

  it('gives the table four chairs and no more — the fifth talker stays at their desk', () => {
    const names = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const seats = assignSeats(names.map((n) => member(n)), new Set(names));
    const seated = names.filter((n) => isMeeting(seats.get(n)!));
    expect(seated).toHaveLength(meetingSpots.length);
    expect(names.filter((n) => !isMeeting(seats.get(n)!))).toHaveLength(
      names.length - meetingSpots.length,
    );
  });

  it('never drags an away member to the table — they are not in the room', () => {
    const seats = assignSeats(
      [member('stepped', { availability: { status: 'away' } })],
      new Set(['stepped']),
    );
    expect(seats.get('stepped')).toMatchObject({ kind: 'desk', owned: true });
  });

  it('is deterministic — the same gathering seats the same way twice', () => {
    const names = ['zoe', 'ada', 'bo'];
    const first = assignSeats(names.map((n) => member(n)), new Set(names));
    const second = assignSeats(shuffle(names, 7).map((n) => member(n)), new Set(names));
    for (const n of names) expect(second.get(n)).toEqual(first.get(n));
  });
});
