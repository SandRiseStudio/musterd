import { describe, expect, it } from 'vitest';
import {
  parseSeatFile,
  parseTeamFile,
  seatNameFromPath,
  serializeSeat,
  serializeTeam,
  type SeatFile,
  type TeamFile,
} from './seatfile.js';

/**
 * The two ADR 058 §3 guards at the format layer (seat-file-format.md):
 *  - guard 1 (correctness): a *semantic* round-trip — parse → serialize → parse is the identity on
 *    structure, tolerant of hand-edit whitespace/key-order. (The full project-through-db round-trip
 *    lives in the server reconcile tests, where the projection exists.)
 *  - guard 2 (tidiness): serialize(parse(canonical)) is byte-equal, and `fmt` is idempotent.
 */

describe('seat file — guard 2: canonical byte-equality + idempotence', () => {
  const canonicalSeats: Array<[string, string]> = [
    ['olive', 'kind = "agent"\nrole = "reviewer"\n'],
    ['david', 'kind = "human"\nrole = "lead"\n'],
    ['empty-role', 'kind = "agent"\nrole = ""\n'],
    ['temp', 'kind = "agent"\nrole = "intern"\nlifecycle = "session"\n'],
    [
      'untilseat',
      'kind = "agent"\nrole = "contractor"\nlifecycle = "until"\nuntil = "2026-07-01T00:00:00Z"\n',
    ],
  ];

  it('round-trips each canonical seat file byte-for-byte', () => {
    for (const [name, text] of canonicalSeats) {
      const seat = parseSeatFile(text, name);
      expect(serializeSeat(seat)).toBe(text);
    }
  });

  it('fmt is idempotent (serialize∘parse∘serialize = serialize)', () => {
    for (const [name, text] of canonicalSeats) {
      const once = serializeSeat(parseSeatFile(text, name));
      const twice = serializeSeat(parseSeatFile(once, name));
      expect(twice).toBe(once);
    }
  });

  const canonicalTeams: string[] = [
    'slug = "alpha"\n',
    'slug = "alpha"\ndisplay = "Team Alpha"\n',
    'slug = "alpha"\ndisplay = "Team Alpha"\nlifecycle = "session"\n',
  ];

  it('round-trips each canonical team file byte-for-byte', () => {
    for (const text of canonicalTeams) {
      expect(serializeTeam(parseTeamFile(text))).toBe(text);
    }
  });
});

describe('seat file — guard 1: semantic round-trip tolerates hand-edit noise', () => {
  it('messy whitespace + reordered keys parse to the same structure as canonical', () => {
    const canonical = parseSeatFile('kind = "agent"\nrole = "reviewer"\n', 'olive');
    const messy = parseSeatFile('role="reviewer"\n\n   kind   =    "agent"  \n', 'olive');
    expect(messy).toEqual(canonical);
  });

  it('parse∘serialize is identity on seat bodies (non-forever lifecycles)', () => {
    const bodies: SeatFile[] = [
      { kind: 'agent', role: 'reviewer' },
      { kind: 'human', role: '' },
      { kind: 'agent', role: 'intern', lifecycle: 'session' },
      { kind: 'agent', role: 'contractor', lifecycle: 'until', until: '2026-07-01T00:00:00Z' },
    ];
    for (const body of bodies) {
      const back = parseSeatFile(serializeSeat(body), 'someone');
      expect(back).toEqual({ ...body, role: body.role ?? '', name: 'someone' });
    }
  });

  it('parse∘serialize is identity on team files', () => {
    const teams: TeamFile[] = [
      { slug: 'alpha', lifecycle: 'forever' },
      { slug: 'beta', display: 'Beta', lifecycle: 'forever' },
      { slug: 'gamma', display: 'Gamma', lifecycle: 'session' },
    ];
    for (const team of teams) {
      expect(parseTeamFile(serializeTeam(team))).toEqual(team);
    }
  });
});

describe('seat file — known normalization: explicit lifecycle="forever" collapses to inherit', () => {
  it('an explicit forever seat serializes to the minimal (omitted) form', () => {
    // Canonical emission drops lifecycle when forever (seat-file-format.md): a pinned-forever seat
    // and an inherit-the-team-default seat share one on-disk shape. Documented limitation: pinning
    // forever against a non-forever team default is not representable.
    const back = parseSeatFile(
      serializeSeat({ kind: 'agent', role: 'x', lifecycle: 'forever' }),
      'z',
    );
    expect(back.lifecycle).toBeUndefined();
  });
});

describe('seat file — validation is fail-closed', () => {
  it('lifecycle "until" without an `until` timestamp is rejected', () => {
    expect(() => parseSeatFile('kind = "agent"\nrole = "x"\nlifecycle = "until"\n', 'z')).toThrow();
  });

  it('a body name disagreeing with the filename stem is rejected', () => {
    expect(() => parseSeatFile('kind = "agent"\nrole = "x"\nname = "other"\n', 'olive')).toThrow(
      /disagrees with its filename/,
    );
  });

  it('a body name matching the stem is accepted', () => {
    expect(parseSeatFile('kind = "agent"\nrole = "x"\nname = "olive"\n', 'olive').name).toBe(
      'olive',
    );
  });

  it('an invalid team slug is rejected', () => {
    expect(() => parseTeamFile('slug = "Not A Slug"\n')).toThrow();
  });

  it('a whitespace seat name is rejected', () => {
    expect(() => parseSeatFile('kind = "agent"\nrole = "x"\n', 'bad name')).toThrow(/whitespace/);
  });
});

describe('seatNameFromPath', () => {
  it('extracts the stem from a seats/<name>.toml path', () => {
    expect(seatNameFromPath('.musterd/seats/olive.toml')).toBe('olive');
    expect(seatNameFromPath('/abs/path/.musterd/seats/david.toml')).toBe('david');
    expect(seatNameFromPath('cosmo.toml')).toBe('cosmo');
  });
});
