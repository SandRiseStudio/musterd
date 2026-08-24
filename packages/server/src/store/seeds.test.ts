import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/open.js';
import { createTeam } from './teams.js';
import { addMember } from './members.js';
import { createSeedFromRelay, listSeeds } from './seeds.js';

describe('shared Seed store (ADR 291)', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => db.close());

  it('persists one immutable relay Seed per Team relay id', () => {
    const team = createTeam(db, { slug: 'bravo' });
    const nick = addMember(db, team, { name: 'nick', kind: 'human' });
    const first = createSeedFromRelay(db, team.id, nick.row.id, {
      id: 'relay-1',
      source: 'slack',
      body: 'A raw idea',
      ts: 1,
    });

    expect(first.state).toBe('open');
    expect(listSeeds(db, team.id)).toMatchObject([{ relay_id: 'relay-1', body: 'A raw idea' }]);
  });
});
