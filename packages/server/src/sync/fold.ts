import { ActSchema, type SyncPullEvent } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { getMemberByName } from '../store/members.js';
import type { MessageRow } from '../store/rows.js';

/**
 * The fold (ADR 325 increment 3b-ii): apply the team's canonical order to THIS daemon's `messages`.
 *
 * This is the second insert path ADR 331 §Consequences warned about, and the whole slice is shaped
 * so there is exactly one of it, reviewed here, run by hub and puller alike. Three disciplines:
 *
 *  - **`nodes.next_seq` is never touched.** A folded row keeps the stamp its origin minted; the
 *    local allocator belongs to `insertMessage` alone. `fold.test.ts`'s first case is the falsifier.
 *  - **Idempotent on `(origin_node, origin_seq)`**, held by `idx_messages_origin` (v52) — not on
 *    `messages.id`, which ADR 335 deliberately left unique-per-origin only.
 *  - **Block, don't skip.** The first event that cannot be fully resolved stops the cursor AT that
 *    event; everything before it commits. Out-of-order application would make "everything up to N
 *    is applied" unanswerable, which is the one thing a cursor is for.
 *
 * `created_at` is this daemon's clock at fold time — never `envelope.ts`, which is the ORIGIN's
 * clock and travels (ADR 335 §1). The inbox and wake cursors are moving off `ts` onto `created_at`
 * for exactly that reason (spec §"The ts-cursor defect"); a wire value here would reintroduce the
 * defect under the fixed column.
 */

export type FoldStop =
  | { kind: 'unresolved_seat'; seat: string; hub_seq: number }
  | { kind: 'unknown_act'; act: string; hub_seq: number }
  | { kind: 'id_collision'; id: string; hub_seq: number; held_origin: string }
  | { kind: 'origin_gap'; origin: string; expected: number; got: number; hub_seq: number };

export interface FoldResult {
  applied: number;
  skipped: number;
  /** The cursor after this call — the last hub_seq applied or skipped. */
  last_hub_seq: number;
  stop: FoldStop | null;
}

export function readPullCursor(db: Database, teamId: string): number {
  return (
    db
      .prepare<
        [string],
        { last_hub_seq: number }
      >('SELECT last_hub_seq FROM sync_pull_cursor WHERE team_id = ?')
      .get(teamId)?.last_hub_seq ?? 0
  );
}

function writePullCursor(db: Database, teamId: string, hubSeq: number, now: number): void {
  db.prepare(
    `INSERT INTO sync_pull_cursor (team_id, last_hub_seq, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET last_hub_seq = excluded.last_hub_seq, updated_at = excluded.updated_at`,
  ).run(teamId, hubSeq, now);
}

function localNodeId(db: Database, teamId: string): string | null {
  return (
    db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(teamId)?.node_id ?? null
  );
}

/** The highest origin_seq this daemon holds for an origin — the read-side gap check's baseline. */
function heldHead(db: Database, originNode: string): number {
  return (
    db
      .prepare<
        [string],
        { high: number | null }
      >('SELECT MAX(origin_seq) AS high FROM messages WHERE origin_node = ?')
      .get(originNode)?.high ?? 0
  );
}

export function foldBatch(
  db: Database,
  teamId: string,
  events: SyncPullEvent[],
  now: number = Date.now(),
): FoldResult {
  return db.transaction((): FoldResult => {
    const local = localNodeId(db, teamId);
    const startCursor = readPullCursor(db, teamId);
    let cursor = startCursor;
    let applied = 0;
    let skipped = 0;
    let stop: FoldStop | null = null;

    // A `return finish()` inside db.transaction COMMITS what ran before it: the prefix and the
    // cursor go together. Only an unclassified throw rolls the batch back.
    const finish = (): FoldResult => {
      if (cursor !== startCursor) writePullCursor(db, teamId, cursor, now);
      return { applied, skipped, last_hub_seq: cursor, stop };
    };

    for (const event of events) {
      const env = event.envelope;

      // Rule 1 — own origin: already in messages via insertMessage. Not an error.
      if (local !== null && event.origin_node === local) {
        skipped += 1;
        cursor = event.hub_seq;
        continue;
      }

      // Rule 2 — replay: the pair is the idempotence key.
      const held = db
        .prepare<
          [string, number],
          { id: string }
        >('SELECT id FROM messages WHERE origin_node = ? AND origin_seq = ?')
        .get(event.origin_node, event.origin_seq);
      if (held) {
        skipped += 1;
        cursor = event.hub_seq;
        continue;
      }

      // Read-side gap: the hub ingests gaplessly and we walk hub_seq in order, so this cannot trip
      // unless the hub's own invariant broke. Terminal — it is that invariant's falsifier from here.
      const expected = heldHead(db, event.origin_node) + 1;
      if (event.origin_seq !== expected) {
        stop = {
          kind: 'origin_gap',
          origin: event.origin_node,
          expected,
          got: event.origin_seq,
          hub_seq: event.hub_seq,
        };
        return finish();
      }

      // Rule 3 — resolve every seat the envelope names, or stop here. `to` blocks too: NULL would
      // silently turn a directed act into a broadcast.
      const from = getMemberByName(db, teamId, env.from);
      if (!from) {
        stop = { kind: 'unresolved_seat', seat: env.from, hub_seq: event.hub_seq };
        return finish();
      }
      let toMember: string | null = null;
      if (env.to.kind === 'member') {
        const to = getMemberByName(db, teamId, env.to.name);
        if (!to) {
          stop = { kind: 'unresolved_seat', seat: env.to.name, hub_seq: event.hub_seq };
          return finish();
        }
        toMember = to.id;
      }

      // Rule 5 — the id is held under a different pair (rule 2 passed, so it is not a replay).
      const collision = db
        .prepare<[string], { origin_node: string }>('SELECT origin_node FROM messages WHERE id = ?')
        .get(env.id);
      if (collision) {
        stop = {
          kind: 'id_collision',
          id: env.id,
          hub_seq: event.hub_seq,
          held_origin: collision.origin_node,
        };
        return finish();
      }

      // Unknown act — the wire outran the reader: the origin runs a newer build. messages.act
      // carries no CHECK (dropped in the table rewrite), so the schema would happily store it and
      // every reader downstream would meet an act it cannot classify. Block until this daemon is
      // upgraded; skipping would drop an event a peer considers sent.
      if (!ActSchema.safeParse(env.act).success) {
        stop = { kind: 'unknown_act', act: env.act, hub_seq: event.hub_seq };
        return finish();
      }

      // Rule 4 — insert with the origin stamp verbatim. NEVER reads or writes nodes.next_seq.
      const row: MessageRow = {
        id: env.id,
        team_id: teamId,
        from_member: from.id,
        to_kind: env.to.kind,
        to_member: toMember,
        act: env.act,
        body: env.body,
        thread_id: env.thread ?? null,
        meta: env.meta ? JSON.stringify(env.meta) : null,
        from_provenance: event.from_provenance,
        origin_node: event.origin_node,
        origin_seq: event.origin_seq,
        ts: env.ts,
        created_at: now,
      };
      db.prepare(
        `INSERT INTO messages
           (id, team_id, from_member, to_kind, to_member, act, body, thread_id, meta, from_provenance, origin_node, origin_seq, ts, created_at)
         VALUES
           (@id, @team_id, @from_member, @to_kind, @to_member, @act, @body, @thread_id, @meta, @from_provenance, @origin_node, @origin_seq, @ts, @created_at)`,
      ).run(row);
      applied += 1;
      cursor = event.hub_seq;
    }
    return finish();
  })();
}
