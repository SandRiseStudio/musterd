import {
  SYNC_PULL_MAX_BATCH,
  SyncPullResponseSchema,
  type SyncPullResponse,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { readNodeState } from '../node/state.js';
import { handleFoldedMessages } from '../protocol/route.js';
import { listActiveTeams } from '../store/teams.js';
import { foldBatch, foldNodeLiveness, readPullCursor, type FoldStop } from './fold.js';
import { hasEnrolledJoiners, readStaged } from './log.js';

/**
 * The pull half of the sync surface (ADR 325 increment 3b-ii): fetch the team's canonical order
 * past this daemon's cursor and fold it into `messages`. Two feeders, one fold — a joiner reads the
 * hub over HTTP; the hub reads its own `sync_log`. Shaped after `push.ts` (running flag, per-team
 * try/catch, unref'd timer, offline as the expected state).
 *
 * Every way the fold can stop has its own `error` line here, distinguishable from offline (`warn`)
 * — the push side learned that lesson at ADR 335 §7. A stall is reported once per distinct
 * blocker, not once per tick; the set clears when the fold moves again.
 */

export const SYNC_PULL_INTERVAL_MS = 60_000;
const PULL_TIMEOUT_MS = 10_000;

/**
 * Blockers already reported, so a stall logs once and not every tick. Cleared when the fold moves.
 * Keyed per daemon (`Ctx`), not per module: two in-process daemons on one slug — the two-daemon
 * acceptance, or any test that runs a hub and a joiner in one process — must not share a
 * suppression set, or the second daemon's first stall is silently "already reported" by the first
 * (dolly, #1155 review F3).
 */
const reportedByDb = new WeakMap<Ctx['db'], Set<string>>();
function reportedFor(ctx: Ctx): Set<string> {
  // Keyed on the database handle, not the Ctx object: the handle IS the daemon's identity, and a
  // Ctx may be re-assembled around it (tests build one per call).
  let set = reportedByDb.get(ctx.db);
  if (!set) {
    set = new Set<string>();
    reportedByDb.set(ctx.db, set);
  }
  return set;
}

function localNodeId(ctx: Ctx, teamId: string): string | null {
  return (
    ctx.db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(teamId)?.node_id ?? null
  );
}

function reportStop(ctx: Ctx, team: string, stop: FoldStop): void {
  const reported = reportedFor(ctx);
  const key = `${team}:${JSON.stringify(stop)}`;
  if (reported.has(key)) return;
  reported.add(key);
  switch (stop.kind) {
    case 'unresolved_seat':
      log.error({
        msg: 'sync_fold_blocked',
        team,
        seat: stop.seat,
        hub_seq: stop.hub_seq,
        detail:
          'the fold names a seat this roster does not hold — not yet reconciled from git, or removed upstream; retrying each tick',
      });
      return;
    case 'unknown_act':
      log.error({
        msg: 'sync_fold_unknown_act',
        team,
        act: stop.act,
        hub_seq: stop.hub_seq,
        detail: 'a peer runs a newer build; upgrade this daemon — retrying each tick',
      });
      return;
    case 'id_collision':
      log.error({
        msg: 'sync_fold_id_collision',
        team,
        id: stop.id,
        held_origin: stop.held_origin,
        hub_seq: stop.hub_seq,
        detail: 'two origins minted one envelope id; terminal, needs operator attention',
      });
      return;
    case 'origin_gap':
      log.error({
        msg: 'sync_fold_origin_gap',
        team,
        origin: stop.origin,
        expected: stop.expected,
        got: stop.got,
        hub_seq: stop.hub_seq,
        detail:
          "the canonical order skipped an origin's sequence; the hub's invariant broke — terminal",
      });
      return;
    case 'unknown_lane_event':
    case 'unknown_presence_event':
      log.error({
        msg: 'sync_fold_unknown_event',
        team,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail: 'a peer runs a newer build; upgrade this daemon — retrying each tick',
      });
      return;
    case 'lane_unborn':
      log.error({
        msg: 'sync_fold_lane_unborn',
        team,
        lane: stop.lane,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail:
          'a transition for a lane this daemon never saw born (pre-2026-09-02 lane, or a hole); retrying each tick',
      });
      return;
    case 'presence_unborn':
      log.error({
        msg: 'sync_fold_presence_unborn',
        team,
        presence: stop.presence,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail: 'a re-attestation for a session this daemon never saw attach; retrying each tick',
      });
      return;
    case 'mistagged_ledger_event':
      log.error({
        msg: 'sync_fold_mistagged_ledger',
        team,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail:
          'a projected verb arrived under the non-projecting ledger tag; the origin runs a build that mis-tags — terminal, needs operator attention',
      });
      return;
    case 'unknown_policy_event':
    case 'unknown_continuity_event':
    case 'unknown_record_event':
      log.error({
        msg: 'sync_fold_unknown_event',
        team,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail: 'a peer runs a newer build; upgrade this daemon — retrying each tick',
      });
      return;
    case 'cursor_unborn':
      log.error({
        msg: 'sync_fold_cursor_unborn',
        team,
        message: stop.message,
        seat: stop.seat,
        hub_seq: stop.hub_seq,
        detail: 'a cursor names a message not yet folded here; transient — retrying each tick',
      });
      return;
    case 'seed_unborn':
      log.error({
        msg: 'sync_fold_seed_unborn',
        team,
        relay_id: stop.relay_id,
        hub_seq: stop.hub_seq,
        detail:
          'a seed-thread entry names a relay seed this daemon has not ingested yet (ADR 371 §3); transient — one relay poll — and a persisting one is a relay-ingest defect',
      });
      return;
  }
}

async function fetchPage(
  hubUrl: string,
  credential: string,
  slug: string,
  after: number,
): Promise<SyncPullResponse> {
  const url = new URL(`/teams/${slug}/sync/pull`, hubUrl);
  url.searchParams.set('after', String(after));
  url.searchParams.set('limit', String(SYNC_PULL_MAX_BATCH));
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
  });
  if (res.status === 409) {
    // The hub's head is BELOW our cursor. A hub cannot un-hold what it acked; either this daemon's
    // cursor is wrong or the hub lost data. Neither is something a retry fixes, and believing the
    // hub downward here would re-apply events we hold — logged at error, not silently re-anchored.
    const body = (await res.json().catch(() => null)) as { hub_seq_high?: unknown } | null;
    log.error({
      msg: 'sync_pull_impossible_resume',
      team: slug,
      cursor: after,
      hub_seq_high: typeof body?.hub_seq_high === 'number' ? body.hub_seq_high : null,
      detail: 'the hub holds less than this daemon has applied; needs operator attention',
    });
    throw new Error(`hub head is below this daemon's pull cursor ${after} — impossible, refusing`);
  }
  if (!res.ok) throw new Error(`hub responded ${res.status}`);
  return SyncPullResponseSchema.parse(await res.json());
}

/** One team's pull pass. Returns how many events were applied. Exported for through-DB tests. */
export async function pullTeam(
  ctx: Ctx,
  team: { id: string; slug: string },
  now: number = Date.now(),
): Promise<number> {
  const nodeId = localNodeId(ctx, team.id);
  // Same rule as push.ts: an enrollment is this daemon's only if it names this daemon's node row.
  const record = readNodeState().nodes[team.slug];
  const enrollment = record && record.node_id === nodeId ? record : undefined;
  // A hub that has never sent anything has no node row yet, and it hosts joiners all the same —
  // a hub is defined by who is enrolled WITH it, not by whether it has spoken. (push.ts needs the
  // row because it has nothing to push without one; the fold has plenty to apply.)
  const isHub = !enrollment && hasEnrolledJoiners(ctx.db, team.id, nodeId ?? '');
  if (!enrollment && !isHub) return 0;

  const cursor = readPullCursor(ctx.db, team.id);
  const page: Pick<SyncPullResponse, 'events' | 'nodes'> = enrollment
    ? await fetchPage(enrollment.hub_url, enrollment.credential, team.slug, cursor)
    : { events: readStaged(ctx.db, team.id, cursor, SYNC_PULL_MAX_BATCH), nodes: [] };
  // Node liveness lands even when the page is empty: a quiet team still needs to know its
  // machines are alive (presence replication §3). The hub reads its own table and folds none.
  if (page.nodes.length > 0) foldNodeLiveness(ctx.db, team.id, page.nodes);
  if (page.events.length === 0) return 0;

  const result = foldBatch(ctx.db, team.id, page.events, now);
  if (result.stop) {
    reportStop(ctx, team.slug, result.stop);
  } else {
    const reported = reportedFor(ctx);
    for (const key of reported) if (key.startsWith(`${team.slug}:`)) reported.delete(key);
  }
  // The incident pool is the hub's (ADR 371 §2): a joiner's `blocked_by` report crosses on the
  // status_update it rides, and the hub records it HERE, when that message folds — the route-time
  // hook a message posted directly to the hub gets, fired for a folded one. Only the hub: a joiner
  // folding the same message must not count it, or there would be one pool per machine again.
  if (isHub && result.messages.length > 0) {
    try {
      handleFoldedMessages(ctx, team.slug, result.messages);
    } catch (err) {
      log.warn({ msg: 'incident_hook_failed', team: team.slug, err: String(err) });
    }
  }
  return result.applied;
}

/** Start the pull loop. Returns a stop function (same contract as startSyncPush). */
export function startSyncPull(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const team of listActiveTeams(ctx.db)) {
        try {
          const applied = await pullTeam(ctx, team);
          if (applied > 0) log.info({ msg: 'sync_pulled', team: team.slug, applied });
        } catch (error) {
          // Offline is the expected failure for a laptop; the classified stops above already wrote
          // their own error line before this warn.
          log.warn({ msg: 'sync_pull_failed', team: team.slug, error: String(error) });
        }
      }
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), SYNC_PULL_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
