import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember, getMemberByName } from './members.js';
import { getTeamBySlug, createTeam } from './teams.js';

const hours = {
  timezone: 'America/Los_Angeles',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const,
  start: '11:00',
  end: '15:00',
};

describe('working-hours persistence', () => {
  it('stores optional Team and Member schedules as JSON', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'revive', workingHours: hours });
    const member = addMember(db, team, {
      name: 'miley',
      kind: 'agent',
      workingHours: hours,
    });

    expect(getTeamBySlug(db, 'revive')?.working_hours).toBe(JSON.stringify(hours));
    expect(getMemberByName(db, team.id, 'miley')?.working_hours).toBe(JSON.stringify(hours));
    db.close();
  });

  it('keeps a missing Member schedule nullable for inheritance', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'revive', workingHours: hours });
    const member = addMember(db, team, { name: 'miley', kind: 'agent' });

    expect(getMemberByName(db, team.id, 'miley')?.working_hours).toBeNull();
    expect(getTeamBySlug(db, 'revive')?.working_hours).toBe(JSON.stringify(hours));
    expect(member.row.working_hours).toBeNull();
    db.close();
  });
});
