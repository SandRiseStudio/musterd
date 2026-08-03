import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { addMember } from '../store/members.js';
import { parseWorkingHours } from '../store/rows.js';
import { createTeam } from '../store/teams.js';

let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('working-hours roster projection (ADR 205)', () => {
  it('inherits Team hours and lets a Member replace them', async () => {
    const db = openDb(':memory:');
    const teamHours = {
      timezone: 'America/Los_Angeles',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const,
      start: '11:00',
      end: '15:00',
    };
    const memberHours = {
      timezone: 'America/New_York',
      days: ['mon', 'wed', 'fri'] as const,
      start: '09:00',
      end: '12:00',
    };
    const team = createTeam(db, { slug: 'revive', workingHours: teamHours });
    expect(parseWorkingHours(team.working_hours)).toEqual(teamHours);
    addMember(db, team, { name: 'inherited', kind: 'agent' });
    addMember(db, team, { name: 'custom', kind: 'agent', workingHours: memberHours });
    server = createServer({ db, port: 0, rosterRoots: [] });
    const { port } = await server.listen();

    const response = await fetch(`http://127.0.0.1:${port}/teams/revive`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      team: { working_hours: typeof teamHours };
      members: { name: string; working_hours: typeof teamHours }[];
    };
    expect(body.team.working_hours).toEqual(teamHours);
    expect(body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'inherited', working_hours: teamHours }),
        expect.objectContaining({ name: 'custom', working_hours: memberHours }),
      ]),
    );
    db.close();
  });
});
