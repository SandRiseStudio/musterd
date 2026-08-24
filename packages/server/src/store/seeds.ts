import { type Seed, SeedSchema, type SeedSource } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';

interface SeedRow {
  id: string;
  team_id: string;
  relay_id: string;
  source: SeedSource;
  body: string;
  captured_at: number;
  submitted_by: string;
  state: Seed['state'];
  explorer_id: string | null;
  conclusion: string | null;
  linked_lane_id: string | null;
  created_at: number;
  updated_at: number;
}

function toSeed(row: SeedRow, team: string, db: Database): Seed {
  const thread = db
    .prepare<[string], { id: string; kind: string; body: string; name: string; created_at: number }>(
      `SELECT e.id, e.kind, e.body, m.name, e.created_at
       FROM seed_thread_entries e JOIN members m ON m.id = e.member_id
       WHERE e.seed_id = ? ORDER BY e.created_at, e.id`,
    )
    .all(row.id)
    .map((entry) => ({ id: entry.id, kind: entry.kind, body: entry.body, by: entry.name, created_at: entry.created_at }));
  const memberName = db.prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?').get(row.submitted_by)?.name;
  const explorer = row.explorer_id
    ? db.prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?').get(row.explorer_id)?.name ?? null
    : null;
  return SeedSchema.parse({ ...row, team, submitted_by: memberName, explorer, thread });
}

export function createSeedFromRelay(
  db: Database,
  teamId: string,
  submitterId: string,
  relay: { id: string; source: SeedSource; body: string; ts: number },
  now = Date.now(),
): Seed {
  const id = ulid(now);
  db.prepare(
    `INSERT INTO seeds (id, team_id, relay_id, source, body, captured_at, submitted_by, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(id, teamId, relay.id, relay.source, relay.body, relay.ts, submitterId, now, now);
  const row = db.prepare<[string], SeedRow>('SELECT * FROM seeds WHERE id = ?').get(id)!;
  const team = db.prepare<[string], { slug: string }>('SELECT slug FROM teams WHERE id = ?').get(teamId)!;
  return toSeed(row, team.slug, db);
}

export function listSeeds(db: Database, teamId: string): Seed[] {
  const team = db.prepare<[string], { slug: string }>('SELECT slug FROM teams WHERE id = ?').get(teamId)!;
  return db.prepare<[string], SeedRow>('SELECT * FROM seeds WHERE team_id = ? ORDER BY created_at, id').all(teamId).map((row) => toSeed(row, team.slug, db));
}
