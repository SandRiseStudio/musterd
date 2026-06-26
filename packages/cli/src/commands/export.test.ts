import { parseSeatFile, parseTeamFile } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { rosterToFiles, type RosterMember } from './team.js';

describe('rosterToFiles — db→file projection for `team export`', () => {
  it('writes canonical team + seat files, token-free', () => {
    const members: RosterMember[] = [
      { name: 'olive', kind: 'agent', role: 'reviewer', lifecycle: 'forever' },
      { name: 'david', kind: 'human', role: 'lead', lifecycle: 'forever' },
    ];
    const { teamToml, seatFiles } = rosterToFiles('alpha', members);
    expect(teamToml).toBe('slug = "alpha"\n');
    expect(seatFiles['olive.toml']).toBe('kind = "agent"\nrole = "reviewer"\n');
    expect(seatFiles['david.toml']).toBe('kind = "human"\nrole = "lead"\n');
    // No token, ever.
    expect(JSON.stringify(seatFiles)).not.toMatch(/mskd_|token/);
  });

  it('renders an until-lifecycle seat with a canonical ISO timestamp', () => {
    const ts = Date.parse('2026-07-01T00:00:00.000Z');
    const { seatFiles } = rosterToFiles('alpha', [
      { name: 'temp', kind: 'agent', role: 'intern', lifecycle: 'until', lifecycle_until: ts },
    ]);
    expect(seatFiles['temp.toml']).toBe(
      'kind = "agent"\nrole = "intern"\nlifecycle = "until"\nuntil = "2026-07-01T00:00:00.000Z"\n',
    );
    // Round-trips back to the same identity.
    const back = parseSeatFile(seatFiles['temp.toml']!, 'temp');
    expect(back).toEqual({
      kind: 'agent',
      role: 'intern',
      lifecycle: 'until',
      until: '2026-07-01T00:00:00.000Z',
      name: 'temp',
    });
  });

  it('handles an empty roster (team.toml, no seats)', () => {
    const { teamToml, seatFiles } = rosterToFiles('alpha', []);
    expect(parseTeamFile(teamToml)).toEqual({ slug: 'alpha', lifecycle: 'forever' });
    expect(Object.keys(seatFiles)).toEqual([]);
  });
});
