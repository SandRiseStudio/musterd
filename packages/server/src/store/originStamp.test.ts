import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  return { db, team, ada };
}

function env(id: string, ts: number, meta: Record<string, unknown> | null = null) {
  return makeEnvelope({
    id,
    team: 'revive',
    from: 'ada',
    to: { kind: 'team' as const },
    act: 'message',
    body: 'hi',
    ts,
    meta,
  });
}

function seqsFor(db: ReturnType<typeof openDb>, teamId: string) {
  return db
    .prepare<
      [string],
      { origin_node: string; origin_seq: number }
    >('SELECT origin_node, origin_seq FROM messages WHERE team_id = ? ORDER BY origin_seq ASC')
    .all(teamId);
}

describe('the (origin_node, origin_seq) stamp (ADR 331)', () => {
  // Eval (i): gaplessness — N inserts yield exactly 1..N for this node, no duplicates, no holes.
  it('stamps N inserts as exactly the sequence 1..N against one node row', () => {
    const { db, team, ada } = seed();
    for (let i = 1; i <= 5; i++) insertMessage(db, team.id, ada.id, null, env(`m-${i}`, 1000 + i));
    const rows = seqsFor(db, team.id);
    expect(rows.map((r) => r.origin_seq)).toEqual([1, 2, 3, 4, 5]);
    const nodes = new Set(rows.map((r) => r.origin_node));
    expect(nodes.size).toBe(1);
    const node = db
      .prepare<
        [string],
        { id: string; next_seq: number }
      >('SELECT id, next_seq FROM nodes WHERE team_id = ?')
      .get(team.id);
    expect(node?.id).toBe([...nodes][0]);
    expect(node?.next_seq).toBe(6);
  });

  // Eval (ii): a failed insert burns no number — the falsifier for §Decision 2's transaction.
  it('a failed insert (duplicate envelope id) leaves next_seq unchanged and no hole', () => {
    const { db, team, ada } = seed();
    insertMessage(db, team.id, ada.id, null, env('m-1', 1001));
    insertMessage(db, team.id, ada.id, null, env('m-2', 1002));
    expect(() => insertMessage(db, team.id, ada.id, null, env('m-2', 1003))).toThrow();
    const node = db
      .prepare<[string], { next_seq: number }>('SELECT next_seq FROM nodes WHERE team_id = ?')
      .get(team.id);
    expect(node?.next_seq).toBe(3);
    insertMessage(db, team.id, ada.id, null, env('m-3', 1004));
    expect(seqsFor(db, team.id).map((r) => r.origin_seq)).toEqual([1, 2, 3]);
  });

  // Eval (iii): monotone across restart — the counter is a column, not process state.
  it('resumes past the pre-restart maximum after close and reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-origin-'));
    const file = join(dir, 'db.sqlite');
    try {
      const db1 = openDb(file);
      const team = createTeam(db1, { slug: 'revive' });
      const ada = addMember(db1, team, { name: 'ada', kind: 'agent' }).row;
      insertMessage(db1, team.id, ada.id, null, env('m-1', 1001));
      insertMessage(db1, team.id, ada.id, null, env('m-2', 1002));
      db1.close();
      const db2 = openDb(file);
      insertMessage(db2, team.id, ada.id, null, env('m-3', 1003));
      expect(seqsFor(db2, team.id).map((r) => r.origin_seq)).toEqual([1, 2, 3]);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Eval (v): no caller-supplied origin — the same falsifier `from_provenance` warrants.
  it('ignores origin fields arriving in envelope meta; the stamp is server-derived', () => {
    const { db, team, ada } = seed();
    insertMessage(
      db,
      team.id,
      ada.id,
      null,
      env('m-1', 1001, { origin_node: 'evil', origin_seq: 999 }),
    );
    const row = seqsFor(db, team.id)[0]!;
    expect(row.origin_seq).toBe(1);
    expect(row.origin_node).not.toBe('evil');
    const node = db
      .prepare<[string], { id: string }>('SELECT id FROM nodes WHERE team_id = ?')
      .get(team.id);
    expect(row.origin_node).toBe(node?.id);
  });

  // Two teams on one daemon are two node identities with two independent streams (§Decision 1).
  it('keeps independent per-team sequences on a daemon hosting two teams', () => {
    const db = openDb(':memory:');
    const t1 = createTeam(db, { slug: 'one' });
    const t2 = createTeam(db, { slug: 'two' });
    const a1 = addMember(db, t1, { name: 'ada', kind: 'agent' }).row;
    const a2 = addMember(db, t2, { name: 'ada', kind: 'agent' }).row;
    insertMessage(db, t1.id, a1.id, null, env('m-1', 1001));
    insertMessage(db, t2.id, a2.id, null, env('m-2', 1002));
    insertMessage(db, t1.id, a1.id, null, env('m-3', 1003));
    expect(seqsFor(db, t1.id).map((r) => r.origin_seq)).toEqual([1, 2]);
    expect(seqsFor(db, t2.id).map((r) => r.origin_seq)).toEqual([1]);
    const n1 = seqsFor(db, t1.id)[0]!.origin_node;
    const n2 = seqsFor(db, t2.id)[0]!.origin_node;
    expect(n1).not.toBe(n2);
    db.close();
  });
});
