import {
  syncEventActor,
  syncEventId,
  syncEventTeam,
  type SyncEvent,
  type SyncPullEvent,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { getMemberByName } from '../store/members.js';
import { bindSeatToNode } from '../store/nodes.js';

/**
 * The hub's staging log for pushed events (ADR 325 increment 3b-i).
 *
 * Ingest lands events HERE and nowhere else — never in `messages`, never touching `nodes.next_seq`.
 * The fold into `messages` is 3b-ii, one implementation run by hub and puller alike, which is what
 * keeps ADR 331 §Consequences' "second insert path" a single reviewed thing rather than two that
 * drift. `src/sync/containment.test.ts` is what holds that true.
 */

/** A batch arrived out of order. `expectedSeq` is where the pusher should resume. */
export class SyncGapError extends Error {
  constructor(readonly expectedSeq: number) {
    super(`sync gap — expected origin_seq ${expectedSeq}`);
    this.name = 'SyncGapError';
  }
}

/** A batch carried an origin the pushing node is not entitled to write. */
export class SyncOriginError extends Error {
  constructor(message = 'a node may push only its own events') {
    super(message);
    this.name = 'SyncOriginError';
  }
}

/**
 * An origin restaged one of its OWN envelope ids under a different `origin_seq`. Terminal, not
 * resumable: an origin cannot honestly mint one id twice, so this is corruption at the source and
 * no retry of the same batch will clear it. Named so the pusher can tell it from a transient
 * failure and say so out loud, rather than retrying forever behind a warn line.
 */
export class SyncDuplicateIdError extends Error {
  constructor(readonly eventId: string) {
    super(`envelope id ${eventId} is already staged for this origin under a different origin_seq`);
    this.name = 'SyncDuplicateIdError';
  }
}

/**
 * An event names a seat bound to ANOTHER node (ADR 328 §4, enforced at ingest — presence
 * replication spec §2 for the presence kind; every kind since push-level residence, 2026-09-02).
 * The batch is refused whole and the pusher's cursor stays: a node may speak for the seats that
 * live on it and for no other, and a message, a lane transition or a session attached elsewhere
 * are the same hole. The way out is `musterd node trust` from where the seat lives (ADR 358), an
 * admin unbind, or acting from where it lives.
 */
export class SyncResidenceError extends Error {
  constructor(
    readonly seat: string,
    readonly boundTo: string,
    readonly boundLabel: string,
    readonly kind: 'message' | 'lane' | 'presence' | 'ledger' | 'policy' = 'presence',
  ) {
    super(
      `a ${kind} event names seat "${seat}", which is bound to node "${boundLabel}"; this node may not speak for it`,
    );
    this.name = 'SyncResidenceError';
  }
}

/**
 * The highest `origin_seq` this hub holds for a node, or 0 when it holds nothing.
 *
 * Scoped by node alone, deliberately: `nodes.id` is a global primary key and a node belongs to
 * exactly one team, so the node IS the partition. Adding a team predicate here would invent a
 * second, weaker key and let the same origin carry two sequences.
 */
export function highestContiguousSeq(db: Database, nodeId: string): number {
  // The log is gapless per origin by construction — ingest refuses anything else — so MAX is the
  // contiguous head rather than merely the largest value seen.
  const row = db
    .prepare<
      [string],
      { high: number | null }
    >('SELECT MAX(origin_seq) AS high FROM sync_log WHERE origin_node = ?')
    .get(nodeId);
  return row?.high ?? 0;
}

/** The team's canonical order head — the highest `hub_seq` assigned, or 0 before the first ingest. */
export function hubHead(db: Database, teamId: string): number {
  const row = db
    .prepare<
      [string],
      { high: number | null }
    >('SELECT MAX(hub_seq) AS high FROM sync_log WHERE team_id = ?')
    .get(teamId);
  return row?.high ?? 0;
}

/**
 * Ingest one pushed batch.
 *
 * Throws `SyncOriginError` or `SyncGapError` — and any constraint violation throws too. Every one
 * of them rolls the whole batch back, because a partially applied batch leaves a hole the pusher
 * believes it has closed.
 */
export function ingestBatch(
  db: Database,
  teamId: string,
  nodeId: string,
  events: SyncEvent[],
  now: number = Date.now(),
): { accepted: number; hub_seq_high: number } {
  return db.transaction(() => {
    // Authentication proves WHICH node is pushing; it does not prove the node may write to THIS
    // team's log, because `nodes.id` is global while a node belongs to one team. Increment 3a's one
    // confirmed hole was exactly this confusion between a global id and a team-scoped check.
    const node = db
      .prepare<[string], { team_id: string; slug: string }>(
        `SELECT n.team_id AS team_id, t.slug AS slug
           FROM nodes n JOIN teams t ON t.id = n.team_id
          WHERE n.id = ?`,
      )
      .get(nodeId);
    if (!node || node.team_id !== teamId) {
      throw new SyncOriginError('node is not a member of this team');
    }

    // Push-level residence (2026-09-02): the hub never refuses ITSELF. A loopback push carries rows
    // the hub wrote under a seat credential it authenticated, or on a joiner's behalf after binding
    // the seat to that joiner at arbitration (ADR 355 §5) — a machine credential was never the
    // authority for any of them. It still binds an unbound seat to the hub, so a hub resident who
    // has only ever messaged here is the hub's before a joiner can name them.
    const loopback =
      db
        .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
        .get(teamId)?.node_id === nodeId;

    let expected = highestContiguousSeq(db, nodeId) + 1;
    let accepted = 0;

    for (const event of events) {
      if (event.origin_node !== nodeId) throw new SyncOriginError();
      // The hub authenticated the TEAM, so the event does not get to name a different one — for
      // either kind. Nothing in 3b-i reads `envelope.team`; 3b-ii's fold is the reader, and a row
      // whose team_id says one team while its payload says another is a contradiction the staging
      // layer already had the information to refuse (dolly, 2026-08-28).
      if (syncEventTeam(event) !== node.slug) {
        throw new SyncOriginError('event names a team other than the one it is pushed into');
      }

      // Residence at ingest, every kind (ADR 355 §5's named next increment, 2026-09-02; the
      // presence kind since ADR 356 §2): the first event a node pushes AS a seat binds the seat to
      // it, first-writer-wins under the same guarded CAS a claim uses; a seat already bound
      // elsewhere refuses the batch. Runs on every event, replay or not, and before the replay
      // check on purpose: the binding is a fact about who may speak, not about which seq was
      // stored. An unknown seat is the fold's problem (`unresolved_seat`); residence needs a
      // member id. A service seat (ADR 232) is machinery that runs on every machine as ONE roster
      // name — `autorefresh` bounces each daemon — so it is resident everywhere: no binding, no
      // refusal. This transaction rolls the whole batch back on the throw, so a refused batch
      // binds nothing.
      //
      // The policy kind is exempt (residence-2 census gap 1, 2026-09-03). Residence answers "may
      // this node speak AS this seat"; a `policy.change` is a fact about the TEAM that only the hub
      // ever mints — a joiner's admin forwards precisely so the hub is the author. Binding the
      // admin to the hub here would strand them: the seat lives on the joiner, and its next
      // message from there would be refused for having set a policy it was told to forward.
      const actor = event.kind === 'policy' ? null : syncEventActor(event);
      const seat = actor ? getMemberByName(db, teamId, actor) : undefined;
      if (seat && seat.kind !== 'service') {
        const bound = bindSeatToNode(db, teamId, seat.id, nodeId, now);
        if (!bound.bound && !loopback) {
          throw new SyncResidenceError(
            seat.name,
            bound.node_id,
            bound.label,
            event.kind ?? 'message',
          );
        }
      }

      // A replay of something already held is a no-op, not a gap: the pusher resending after a lost
      // ack is the expected case, and it must not look like corruption. This is what makes the
      // batch idempotent, so the insert below needs no ON CONFLICT — and must not have one. A
      // distinct event reusing a staged envelope id is NOT a replay under the idempotence key
      // (origin_node, origin_seq); swallowing it would advance the origin's sequence past an event
      // the hub never stored, which is silent loss wearing an ack.
      if (event.origin_seq < expected) continue;
      if (event.origin_seq !== expected) throw new SyncGapError(expected);

      // Allocated inside the same transaction as the insert, the shape `insertMessage` established
      // for `next_seq`: SQLite's single writer means the read-bump-insert cannot interleave. The
      // upsert seeds 2 and returns the PRE-increment value, so the first event gets hub_seq 1 —
      // copying the schema's DEFAULT 1 here would hand out 1 twice. Because nothing below can
      // silently decline to insert, every number allocated is a number stored: the order is dense.
      const hubSeq = db
        .prepare<[string], { hub_seq: number }>(
          `INSERT INTO sync_meta (team_id, next_hub_seq) VALUES (?, 2)
           ON CONFLICT(team_id) DO UPDATE SET next_hub_seq = next_hub_seq + 1
           RETURNING next_hub_seq - 1 AS hub_seq`,
        )
        .get(teamId)!.hub_seq;

      try {
        db.prepare(
          `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          syncEventId(event),
          teamId,
          nodeId,
          event.origin_seq,
          hubSeq,
          JSON.stringify(event),
          now,
        );
      } catch (err) {
        // Classified rather than allowed to surface raw: an unnamed SQLITE_CONSTRAINT reaches the
        // pusher as a bare 500, which it cannot tell from a hub that is merely down — so it retries
        // the identical poison batch every tick, silently, forever.
        if (err instanceof Error && /idx_sync_log_origin_id|sync_log\.id/.test(err.message)) {
          throw new SyncDuplicateIdError(syncEventId(event));
        }
        throw err;
      }
      accepted += 1;
      expected += 1;
    }

    return { accepted, hub_seq_high: hubHead(db, teamId) };
  })();
}

/**
 * Is this daemon a hub for the team — does any OTHER node hold a live credential here? The loopback
 * predicate for the hub's own staging (3b-ii). False for every single-machine install, so they pay
 * nothing; flips true at the first enrollment and the push cursor (starting at 0) backfills the
 * hub's whole history through the same gapless path a joiner uses.
 */
export function hasEnrolledJoiners(db: Database, teamId: string, localNodeId: string): boolean {
  return Boolean(
    db
      .prepare<[string, string], { one: number }>(
        `SELECT 1 AS one FROM nodes
          WHERE team_id = ? AND id != ? AND credential_hash IS NOT NULL AND revoked_at IS NULL
          LIMIT 1`,
      )
      .get(teamId, localNodeId),
  );
}

/**
 * One page of the team's canonical order after `after`, oldest first. This is the walk
 * `idx_sync_log_hub` was declared UNIQUE for (3b-i). `payload` was stored as the SyncEvent verbatim,
 * so it parses back without a second shape — the hub_seq rides beside it for the puller's cursor.
 */
export function readStaged(
  db: Database,
  teamId: string,
  after: number,
  limit: number,
): SyncPullEvent[] {
  return db
    .prepare<[string, number, number], { hub_seq: number; payload: string }>(
      'SELECT hub_seq, payload FROM sync_log WHERE team_id = ? AND hub_seq > ? ORDER BY hub_seq LIMIT ?',
    )
    .all(teamId, after, limit)
    .map((r) => ({ ...(JSON.parse(r.payload) as SyncEvent), hub_seq: r.hub_seq }));
}
