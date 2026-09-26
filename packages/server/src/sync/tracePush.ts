import { SYNC_TRACE_MAX_BATCH, SyncTracePushResponseSchema } from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { readNodeState } from '../node/state.js';
import { listActiveTeams } from '../store/teams.js';
import { advanceSyncTraceCursor, readSyncTraceCursor, unpushedTraceRows } from '../store/trace.js';

/**
 * The joiner's trace pusher (ADR 453 §4): this daemon's own structural trace rows, `trace.db` to
 * the hub's `trace.db`, over `POST /teams/:slug/sync/trace` with the machine credential.
 *
 * Its OWN loop, deliberately. `startSyncPush` is one async pass per tick behind a `running` guard,
 * awaiting each team in turn — a trace POST inside that pass would couple the two channels by
 * scheduling even with separate cursors: a slow hub would delay the next team's coordination push
 * by up to the trace timeout, every tick, and a thrown trace error inside a team's `try` would skip
 * the rest of that team. So this has its own interval, its own `running` flag, its own per-team
 * try/catch and its own fetch timeout. "No coupling either way" holds by construction, and
 * `tracePush.test.ts` pins that a stalled `/sync/trace` leaves the `/sync/push` cadence unchanged.
 *
 * Nothing here touches `musterd.db` except the read of which teams exist and which node this is.
 * Never runs on a hub for its own rows (the hub is where the corpus lives) and never on a machine
 * that has not enrolled — there is nowhere to push.
 */

export const SYNC_TRACE_INTERVAL_MS = 60_000;
const TRACE_PUSH_TIMEOUT_MS = 10_000;

/** This daemon's `nodes` row for the team, or null — the same read `sync/push.ts` makes. */
function localNodeId(ctx: Ctx, teamId: string): string | null {
  return (
    ctx.db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(teamId)?.node_id ?? null
  );
}

export interface TracePushOutcome {
  pushed: number;
  ignored: number;
  collided: number;
  refused: number;
  /** Fields the pusher normalized on the way out (legacy or odd rows) — a non-zero rate names a tap. */
  normalized: number;
}

/**
 * One team's trace push. Returns what the hub said, or null when there was nothing to do (not
 * enrolled, or nothing after the cursor). Throws on transport failure and on a 4xx/5xx other than
 * a batch-holding 409, so the loop logs it and the cursor stays. Exported for through-DB tests.
 */
export async function pushTraceTeam(
  ctx: Ctx,
  team: { id: string; slug: string },
): Promise<TracePushOutcome | null> {
  const nodeId = localNodeId(ctx, team.id);
  const record = readNodeState().nodes[team.slug];
  const enrollment = record && nodeId && record.node_id === nodeId ? record : undefined;
  if (!enrollment) return null;

  const cursor = readSyncTraceCursor(ctx.traceDb, team.id);
  const { rows, last, normalized } = unpushedTraceRows(
    ctx.traceDb,
    team.id,
    cursor,
    SYNC_TRACE_MAX_BATCH,
  );
  if (rows.length === 0) return null;

  const res = await fetch(new URL(`/teams/${team.slug}/sync/trace`, enrollment.hub_url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${enrollment.credential}`,
    },
    body: JSON.stringify({ rows }),
    signal: AbortSignal.timeout(TRACE_PUSH_TIMEOUT_MS),
  });

  if (res.status === 409) {
    // A batch-holding refusal (ADR 453 §3): unresolved or unbound seat — transient. The cursor
    // stays and the same batch goes next tick. Say which, so the log names the seat to bind.
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      reason?: string;
      seat?: string;
    } | null;
    log.warn({
      msg: 'trace_push_held',
      team: team.slug,
      reason: body?.reason ?? 'conflict',
      seat: body?.seat ?? null,
      cursor,
    });
    return { pushed: 0, ignored: 0, collided: 0, refused: 0, normalized };
  }
  if (!res.ok) throw new Error(`hub responded ${res.status}`);

  const ack = SyncTracePushResponseSchema.parse(await res.json());
  // Only past what the hub answered 200 to — refused rows included (§3: they are not written on
  // the hub, they stay here, and they never block the rows behind them).
  advanceSyncTraceCursor(ctx.traceDb, team.id, last);
  if (ack.refused.length > 0) {
    const seats = new Set(
      rows.filter((r) => ack.refused.some((f) => f.id === r.id)).map((r) => r.seat),
    );
    log.warn({
      msg: 'trace_rows_refused',
      team: team.slug,
      refused: ack.refused.length,
      seats: [...seats],
    });
  }
  return {
    pushed: ack.accepted,
    ignored: ack.ignored,
    collided: ack.collided,
    refused: ack.refused.length,
    normalized,
  };
}

/** Start the trace push loop. Returns a stop function (the `startSyncPush` contract). */
export function startTracePush(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const team of listActiveTeams(ctx.db)) {
        try {
          const out = await pushTraceTeam(ctx, team);
          if (out && (out.pushed > 0 || out.refused > 0 || out.collided > 0 || out.normalized > 0))
            log.info({ msg: 'trace_pushed', team: team.slug, ...out });
        } catch (error) {
          log.warn({
            msg: 'trace_push_failed',
            team: team.slug,
            cursor: readSyncTraceCursor(ctx.traceDb, team.id),
            error: String(error),
          });
        }
      }
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), SYNC_TRACE_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
