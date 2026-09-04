import {
  type CaptureRepoSeed,
  type PromoteSeed,
  type RelaySeed,
  type Seed,
  SeedSchema,
  type SubmitSeedBrief,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { MusterdError } from '../errors.js';
import { appendReplicatedEvent } from './audit.js';
import { openLane } from './lanes.js';
import type { MemberRow } from './rows.js';

interface SeedRow {
  id: string;
  team_id: string;
  relay_id: string;
  source: 'slack' | 'repo';
  body: string;
  captured_at: number;
  slack_user_id: string | null;
  submitted_by: string;
  state: Seed['state'];
  explorer_id: string | null;
  final_brief: string | null;
  conclusion: string | null;
  linked_lane_id: string | null;
  promotion_kind: 'automatic' | 'manual' | null;
  research_skipped: number | null;
  promoted_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

function toSeed(row: SeedRow, team: string, db: Database): Seed {
  const thread = db
    .prepare<
      [string],
      { id: string; kind: string; body: string; name: string; created_at: number }
    >(
      `SELECT e.id, e.kind, e.body, m.name, e.created_at
       FROM seed_thread_entries e JOIN members m ON m.id = e.member_id
       WHERE e.seed_id = ? ORDER BY e.created_at, e.id`,
    )
    .all(row.id)
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      body: entry.body,
      by: entry.name,
      created_at: entry.created_at,
    }));
  const memberName = db
    .prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?')
    .get(row.submitted_by)?.name;
  const explorer = row.explorer_id
    ? (db
        .prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?')
        .get(row.explorer_id)?.name ?? null)
    : null;
  return SeedSchema.parse({
    ...row,
    team,
    submitted_by: memberName,
    explorer,
    thread,
    final_brief: row.final_brief ? JSON.parse(row.final_brief) : null,
    promotion: row.promotion_kind
      ? {
          kind: row.promotion_kind,
          research_skipped: Boolean(row.research_skipped),
          at: row.promoted_at,
        }
      : null,
  });
}

export function createSeedFromRelay(
  db: Database,
  teamId: string,
  relay: RelaySeed,
  now = Date.now(),
): Seed {
  const prior = db
    .prepare<[string, string], SeedRow>('SELECT * FROM seeds WHERE team_id = ? AND relay_id = ?')
    .get(teamId, relay.id);
  const team = db
    .prepare<[string], { slug: string }>('SELECT slug FROM teams WHERE id = ?')
    .get(teamId)!;
  if (prior) return toSeed(prior, team.slug, db);
  const submitter = db
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM members
       WHERE team_id = ? AND kind = 'human' AND left_at IS NULL AND slack_user_id = ?`,
    )
    .get(teamId, relay.meta.user);
  if (!submitter) throw new Error('unknown_submitter');
  const id = ulid(now);
  db.prepare(
    `INSERT INTO seeds
       (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(
    id,
    teamId,
    relay.id,
    relay.source,
    relay.body,
    relay.ts,
    relay.meta.user,
    submitter.id,
    now,
    now,
  );
  const row = db.prepare<[string], SeedRow>('SELECT * FROM seeds WHERE id = ?').get(id)!;
  return toSeed(row, team.slug, db);
}

/** `relay_id` for a document-recorded intention: the source's own identifier, namespaced so it can
 *  never collide with a relay record id. */
export function repoRelayId(ref: string): string {
  return `repo:${ref.trim()}`;
}

/**
 * ADR 373 increment 2: capture a document-recorded intention as a Seed — the same shape the relay
 * ingest produces, with the repo path + anchor where the Slack record id would be. Idempotent on
 * that key: a second capture returns the row the first one made, body untouched (the source is
 * immutable, ADR 291), so `pnpm intents:ingest` can run on every merge.
 *
 * `lane_id` is a `Follows-up: <lane-id>` already written: the Seed is born (or moves to) `promoted`
 * with `linked_lane_id` set — the seed → lane edge ADR 248 built — so "which document asked for this
 * lane?" is a query over seeds, not a new lane field. An open Seed whose ref is later disposed with
 * a lane id is linked the same way; a Seed already promoted elsewhere is left alone.
 */
export function captureRepoSeed(
  db: Database,
  teamId: string,
  actor: MemberRow,
  input: CaptureRepoSeed,
  now = Date.now(),
): Seed {
  const team = db
    .prepare<[string], { slug: string }>('SELECT slug FROM teams WHERE id = ?')
    .get(teamId)!;
  const relayId = repoRelayId(input.ref);
  const tx = db.transaction((): Seed => {
    if (input.lane_id !== undefined) {
      const lane = db
        .prepare<
          [string, string],
          { id: string }
        >('SELECT id FROM lanes WHERE team_id = ? AND id = ?')
        .get(teamId, input.lane_id);
      if (!lane) throw new MusterdError('bad_request', `Lane "${input.lane_id}" not found`);
    }
    const prior = db
      .prepare<[string, string], SeedRow>('SELECT * FROM seeds WHERE team_id = ? AND relay_id = ?')
      .get(teamId, relayId);
    if (prior) {
      if (input.lane_id !== undefined && prior.linked_lane_id === null) {
        db.prepare(
          `UPDATE seeds
           SET state = 'promoted', explorer_id = NULL, linked_lane_id = ?, promotion_kind = 'manual',
               research_skipped = 1, promoted_at = ?, updated_at = ?
           WHERE team_id = ? AND id = ?`,
        ).run(input.lane_id, now, now, teamId, prior.id);
      }
      return toSeed(
        db.prepare<[string], SeedRow>('SELECT * FROM seeds WHERE id = ?').get(prior.id)!,
        team.slug,
        db,
      );
    }
    const id = ulid(now);
    const promoted = input.lane_id !== undefined;
    db.prepare(
      `INSERT INTO seeds
         (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state,
          linked_lane_id, promotion_kind, research_skipped, promoted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'repo', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      teamId,
      relayId,
      input.body,
      input.captured_at ?? now,
      actor.id,
      promoted ? 'promoted' : 'open',
      input.lane_id ?? null,
      promoted ? 'manual' : null,
      promoted ? 1 : null,
      promoted ? now : null,
      now,
      now,
    );
    return toSeed(
      db.prepare<[string], SeedRow>('SELECT * FROM seeds WHERE id = ?').get(id)!,
      team.slug,
      db,
    );
  });
  return tx();
}

export function listSeeds(db: Database, teamId: string): Seed[] {
  const team = db
    .prepare<[string], { slug: string }>('SELECT slug FROM teams WHERE id = ?')
    .get(teamId)!;
  return db
    .prepare<[string], SeedRow>('SELECT * FROM seeds WHERE team_id = ? ORDER BY created_at, id')
    .all(teamId)
    .map((row) => toSeed(row, team.slug, db));
}

export function getSeed(db: Database, teamId: string, seedId: string): Seed | null {
  const team = db
    .prepare<[string], { slug: string }>('SELECT slug FROM teams WHERE id = ?')
    .get(teamId);
  if (!team) return null;
  const row = db
    .prepare<[string, string], SeedRow>('SELECT * FROM seeds WHERE team_id = ? AND id = ?')
    .get(teamId, seedId);
  return row ? toSeed(row, team.slug, db) : null;
}

function requireSeed(db: Database, teamId: string, seedId: string): Seed {
  const seed = getSeed(db, teamId, seedId);
  if (!seed) throw new MusterdError('not_found', `Seed "${seedId}" not found`);
  return seed;
}

type ThreadKind = 'clarification' | 'answer' | 'brief' | 'conclusion';

/** The fold's silent projector primitive: one thread row, no stamp (ADR 371 §1). */
function appendThread(
  db: Database,
  entryId: string,
  seedId: string,
  memberId: string,
  kind: ThreadKind,
  body: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO seed_thread_entries (id, seed_id, kind, body, member_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(entryId, seedId, kind, body, memberId, now);
}

/**
 * Append a thread entry AND stamp it as `record.seed_thread` (ADR 371 §3), in the caller's
 * transaction. The event names the seed by `relay_id` and the writer by NAME — `seeds.id` and
 * `members.id` are minted per daemon and mean nothing off this machine — and carries the entry's
 * own id, so both machines hold the same row under the same key. The seed's lifecycle state does
 * NOT cross with it (§3): a brief replicates, the `state = 'completed'` beside it stays local.
 */
function applyThread(
  db: Database,
  teamId: string,
  seed: { id: string; relay_id: string },
  actor: MemberRow,
  kind: ThreadKind,
  body: string,
  now: number,
): void {
  const entryId = ulid(now);
  appendThread(db, entryId, seed.id, actor.id, kind, body, now);
  appendReplicatedEvent(db, teamId, {
    actor: actor.name,
    action: 'record.seed_thread',
    target: seed.relay_id,
    result: 'allow',
    detail: {
      entry_id: entryId,
      relay_id: seed.relay_id,
      kind,
      body,
      by: actor.name,
      created_at: now,
    },
  });
}

export function claimSeed(
  db: Database,
  teamId: string,
  seedId: string,
  actor: MemberRow,
  now = Date.now(),
): Seed {
  if (actor.kind !== 'agent')
    throw new MusterdError('forbidden', 'only an agent Member may explore a Seed');
  const seed = requireSeed(db, teamId, seedId);
  if (seed.state !== 'open' && seed.state !== 'clarified')
    throw new MusterdError('conflict', `Seed "${seedId}" is not claimable`);
  db.prepare(
    `UPDATE seeds SET state = 'exploring', explorer_id = ?, updated_at = ?
     WHERE team_id = ? AND id = ?`,
  ).run(actor.id, now, teamId, seedId);
  return requireSeed(db, teamId, seedId);
}

export function askSeedClarification(
  db: Database,
  teamId: string,
  seedId: string,
  actor: MemberRow,
  body: string,
  now = Date.now(),
): Seed {
  const seed = requireSeed(db, teamId, seedId);
  if (seed.state !== 'exploring' || seed.explorer !== actor.name)
    throw new MusterdError('forbidden', 'only the active explorer may ask a clarification');
  const tx = db.transaction(() => {
    applyThread(db, teamId, seed, actor, 'clarification', body, now);
    db.prepare(
      `UPDATE seeds SET state = 'needs_clarification', explorer_id = NULL, updated_at = ?
       WHERE team_id = ? AND id = ?`,
    ).run(now, teamId, seedId);
  });
  tx();
  return requireSeed(db, teamId, seedId);
}

export function answerSeedClarification(
  db: Database,
  teamId: string,
  seedId: string,
  actor: MemberRow,
  body: string,
  now = Date.now(),
): Seed {
  const seed = requireSeed(db, teamId, seedId);
  if (seed.submitted_by !== actor.name)
    throw new MusterdError('forbidden', 'only the submitting Member may answer a clarification');
  if (seed.state !== 'needs_clarification')
    throw new MusterdError('conflict', `Seed "${seedId}" is not awaiting clarification`);
  const tx = db.transaction(() => {
    applyThread(db, teamId, seed, actor, 'answer', body, now);
    db.prepare(
      `UPDATE seeds SET state = 'clarified', updated_at = ? WHERE team_id = ? AND id = ?`,
    ).run(now, teamId, seedId);
  });
  tx();
  return requireSeed(db, teamId, seedId);
}

function promote(
  db: Database,
  teamId: string,
  teamSlug: string,
  seed: Seed,
  actor: MemberRow,
  title: string,
  detail: string,
  kind: 'automatic' | 'manual',
  researchSkipped: boolean,
  now: number,
): Seed {
  const tx = db.transaction(() => {
    const current = requireSeed(db, teamId, seed.id);
    if (current.state === 'promoted') return current;
    const lane = openLane(db, teamId, teamSlug, actor.name, { title, detail }, now);
    db.prepare(
      `UPDATE seeds
       SET state = 'promoted', explorer_id = NULL, linked_lane_id = ?, promotion_kind = ?,
           research_skipped = ?, promoted_at = ?, updated_at = ?
       WHERE team_id = ? AND id = ?`,
    ).run(lane.id, kind, researchSkipped ? 1 : 0, now, now, teamId, seed.id);
    return requireSeed(db, teamId, seed.id);
  });
  return tx();
}

export function submitSeedBrief(
  db: Database,
  teamId: string,
  teamSlug: string,
  seedId: string,
  actor: MemberRow,
  input: SubmitSeedBrief,
  now = Date.now(),
): Seed {
  const seed = requireSeed(db, teamId, seedId);
  if (seed.state === 'promoted' && input.result === 'promote') return seed;
  if (seed.state !== 'exploring' || seed.explorer !== actor.name)
    throw new MusterdError('forbidden', 'only the active explorer may submit a final brief');
  if (input.result === 'promote') {
    const tx = db.transaction(() => {
      applyThread(db, teamId, seed, actor, 'brief', JSON.stringify(input.brief), now);
      db.prepare(
        'UPDATE seeds SET final_brief = ?, updated_at = ? WHERE team_id = ? AND id = ?',
      ).run(JSON.stringify(input.brief), now, teamId, seedId);
      return promote(
        db,
        teamId,
        teamSlug,
        seed,
        actor,
        input.brief.proposed_lane.title,
        input.brief.proposed_lane.detail,
        'automatic',
        false,
        now,
      );
    });
    return tx();
  }
  const tx = db.transaction(() => {
    applyThread(db, teamId, seed, actor, 'brief', JSON.stringify(input.brief), now);
    applyThread(db, teamId, seed, actor, 'conclusion', input.conclusion, now);
    db.prepare(
      `UPDATE seeds
       SET state = 'completed', explorer_id = NULL, final_brief = ?, conclusion = ?,
           completed_at = ?, updated_at = ?
       WHERE team_id = ? AND id = ?`,
    ).run(JSON.stringify(input.brief), input.conclusion, now, now, teamId, seedId);
  });
  tx();
  return requireSeed(db, teamId, seedId);
}

function rawSeedTitle(body: string): string {
  const first = body
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  return (first || 'Seed').slice(0, 80);
}

export function promoteSeed(
  db: Database,
  teamId: string,
  teamSlug: string,
  seedId: string,
  actor: MemberRow,
  input: PromoteSeed,
  now = Date.now(),
): Seed {
  const seed = requireSeed(db, teamId, seedId);
  if (seed.state === 'promoted') return seed;
  const title = input.title ?? seed.final_brief?.proposed_lane.title ?? rawSeedTitle(seed.body);
  const detail = input.detail ?? seed.final_brief?.proposed_lane.detail ?? seed.body;
  return promote(
    db,
    teamId,
    teamSlug,
    seed,
    actor,
    title,
    detail,
    'manual',
    seed.final_brief === null,
    now,
  );
}
