import { SYNC_PUSH_MAX_BATCH, SyncPushResponseSchema, type SyncEvent } from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { readNodeState } from '../node/state.js';
import { rowToEnvelope } from '../store/messages.js';
import type { MessageRow } from '../store/rows.js';
import { listActiveTeams } from '../store/teams.js';

/**
 * The daemon's half of the sync surface (ADR 325 increment 3b-i): push this machine's own
 * origin-stamped messages to the hub, which stages them in `sync_log`.
 *
 * Shaped after `seeds/ingest.ts`, the module ADR 325 named as the pattern — it already solves the
 * parts that look easy and are not: a `running` flag so a slow hub cannot stack passes, per-team
 * try/catch so one unreachable hub cannot stall another team, `unref()` so the timer never holds
 * the process open, and offline treated as the expected state rather than an error.
 *
 * The cursor advances ONLY past a batch the hub acked. A cursor moved on send would turn every
 * unreachable hub into permanent silent loss: the pusher would believe it had delivered events that
 * never arrived, and nothing downstream could tell that from a team that simply said nothing.
 */

/** How often the daemon offers its unpushed events. Idle cost is one conditional per team per tick;
 *  the outbound fetch happens only for teams this machine has actually enrolled. */
export const SYNC_PUSH_INTERVAL_MS = 60_000;

/** Abandon a slow hub rather than let it stack ticks. */
const PUSH_TIMEOUT_MS = 10_000;

/** This daemon's `nodes` row for the team, or null when it has never logged an act here. */
function localNodeId(ctx: Ctx, teamId: string): string | null {
  return (
    ctx.db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(teamId)?.node_id ?? null
  );
}

/**
 * The highest `origin_seq` this machine has ever minted for the node, or 0 if none.
 *
 * The ceiling on any resume point a hub may hand back: a hub claiming to hold seq N from us when we
 * have only ever written M < N is asserting something impossible, not correcting us.
 */
function localHead(ctx: Ctx, teamId: string, nodeId: string): number {
  return (
    ctx.db
      .prepare<
        [string, string],
        { high: number | null }
      >('SELECT MAX(origin_seq) AS high FROM messages WHERE team_id = ? AND origin_node = ?')
      .get(teamId, nodeId)?.high ?? 0
  );
}

function readCursor(ctx: Ctx, teamId: string, nodeId: string): number {
  return (
    ctx.db
      .prepare<
        [string, string],
        { last_seq: number }
      >('SELECT last_seq FROM sync_push_cursor WHERE team_id = ? AND node_id = ?')
      .get(teamId, nodeId)?.last_seq ?? 0
  );
}

function advanceCursor(ctx: Ctx, teamId: string, nodeId: string, seq: number, now: number): void {
  ctx.db
    .prepare(
      `INSERT INTO sync_push_cursor (team_id, node_id, last_seq, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(team_id, node_id) DO UPDATE SET last_seq = excluded.last_seq,
                                                  updated_at = excluded.updated_at`,
    )
    .run(teamId, nodeId, seq, now);
}

/**
 * The unpushed tail of THIS node's log, oldest first.
 *
 * Scoped to `origin_node = ?` on purpose: once 3b-ii folds foreign events into `messages`, a query
 * that merely filtered by team would sweep up a peer's events and offer them under this node's
 * credential — which the hub would rightly refuse, but only after this machine had tried to claim
 * authorship of someone else's traffic.
 *
 * The seat NAME is joined in here, not the member id. `messages.from_member` is a daemon-private
 * anchor (ADR 325): shipping it would dangle on the receiver, or resolve to a DIFFERENT seat that
 * happens to hold that id there.
 */
function unpushed(
  ctx: Ctx,
  teamId: string,
  nodeId: string,
  after: number,
): { row: MessageRow; from: string; to: string | null }[] {
  return ctx.db
    .prepare<
      [string, string, number, number],
      MessageRow & { from_name: string; to_name: string | null }
    >(
      `SELECT m.*, f.name AS from_name, t.name AS to_name
         FROM messages m
         JOIN members f ON f.id = m.from_member
         LEFT JOIN members t ON t.id = m.to_member
        WHERE m.team_id = ? AND m.origin_node = ? AND m.origin_seq > ?
        ORDER BY m.origin_seq
        LIMIT ?`,
    )
    .all(teamId, nodeId, after, SYNC_PUSH_MAX_BATCH)
    .map((r) => ({ row: r, from: r.from_name, to: r.to_name }));
}

/**
 * One team's push pass. Returns how many events the hub accepted. Exported for through-DB tests;
 * the loop below is just this on a timer.
 */
export async function pushTeam(
  ctx: Ctx,
  team: { id: string; slug: string },
  now: number = Date.now(),
): Promise<number> {
  const enrollment = readNodeState().nodes[team.slug];
  // Not enrolled: the single-machine case, which is every musterd install today. Not an error.
  if (!enrollment) return 0;

  const nodeId = localNodeId(ctx, team.id);
  // No local row means this daemon has stamped no origin for the team, so it has nothing of its own
  // to push — and must not mint an identity just to discover that.
  if (!nodeId) return 0;

  const cursor = readCursor(ctx, team.id, nodeId);
  const pending = unpushed(ctx, team.id, nodeId, cursor);
  if (pending.length === 0) return 0;

  const events: SyncEvent[] = pending.map(({ row, from, to }) => ({
    envelope: rowToEnvelope(row, team.slug, from, to),
    origin_node: row.origin_node,
    origin_seq: row.origin_seq,
    // Travels because it is an attested fact about the event (ADR 131 §4). `created_at` deliberately
    // does not: it is local receipt time, and shipping ours would assert a falsehood about when the
    // hub learned of the event.
    from_provenance: row.from_provenance,
  }));

  const res = await fetch(new URL(`/teams/${team.slug}/sync/push`, enrollment.hub_url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${enrollment.credential}`,
    },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });

  if (res.status === 409) {
    // The hub holds a different idea of where we are. Believe it DOWNWARD — it is the authority on
    // what it has, and a pusher that cannot self-correct retries the same rejected batch forever.
    //
    // Upward is a different thing entirely, and it is bounded here. A resume point ahead of
    // anything this machine ever minted cannot be a correction: it would move the cursor past real
    // events, which every later pass then skips, which is exactly the silent loss the cursor exists
    // to prevent — reintroduced through the one number the hub gets to dictate. It does not take a
    // hostile hub; any hub-side miscomputation of the resume point converts into permanent loss
    // here, reported by nobody (dolly, 2026-08-28, #1102 required B).
    const body = (await res.json().catch(() => null)) as { expected_seq?: unknown } | null;
    const expected = body?.expected_seq;
    if (typeof expected === 'number' && Number.isInteger(expected) && expected >= 1) {
      const head = localHead(ctx, team.id, nodeId);
      if (expected > head + 1) {
        throw new Error(
          `hub asked to resume at origin_seq ${expected}, ahead of this node's head ${head} — ` +
            'impossible, so refusing rather than skipping events',
        );
      }
      advanceCursor(ctx, team.id, nodeId, expected - 1, now);
      log.warn({ msg: 'sync_push_gap', team: team.slug, resume_at: expected });
      return 0;
    }
    throw new Error(`hub refused the batch (409) without a usable resume point`);
  }

  if (res.status === 422) {
    // A refusal no retry can clear. Everything else in this loop is "offline, try next tick", and
    // that answer is wrong here: the same batch will be refused forever. Logged at ERROR with the
    // offending event id so the failure is legible from this daemon's log alone, without anyone
    // reading the hub's database to find out why a machine went quiet.
    const body = (await res.json().catch(() => null)) as { event_id?: unknown } | null;
    log.error({
      msg: 'sync_push_rejected',
      team: team.slug,
      event_id: typeof body?.event_id === 'string' ? body.event_id : null,
      detail: 'the hub will never accept this batch; it needs operator attention',
    });
    throw new Error(`hub permanently refused the batch (422)`);
  }
  if (!res.ok) throw new Error(`hub responded ${res.status}`);

  const ack = SyncPushResponseSchema.parse(await res.json());
  // Only now, and only as far as the batch we actually sent. `accepted` counts what was NEW to the
  // hub — a replay acks 0 — so the cursor follows the batch, not the count.
  advanceCursor(ctx, team.id, nodeId, pending[pending.length - 1]!.row.origin_seq, now);
  return ack.accepted;
}

/** Start the push loop. Returns a stop function (same contract as startSeedsIngest). */
export function startSyncPush(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow hub must not stack passes
    running = true;
    try {
      for (const team of listActiveTeams(ctx.db)) {
        try {
          const pushed = await pushTeam(ctx, team);
          if (pushed > 0) log.info({ msg: 'sync_pushed', team: team.slug, pushed });
        } catch (error) {
          // Offline is the expected failure mode for a laptop; log and retry next tick. Nothing is
          // lost, because the cursor did not move past an unacked batch.
          log.warn({ msg: 'sync_push_failed', team: team.slug, error: String(error) });
        }
      }
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), SYNC_PUSH_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
