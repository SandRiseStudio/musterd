import type {
  SeatSurfaceWeight,
  SurfaceRender,
  ToolCallEvent,
  ToolCallMetrics,
  ToolUsageRow,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { appendAudit } from './audit.js';

/**
 * Tool-call telemetry (ADR 144 increment 1) — the store behind the surface-redesign evals:
 * "which tools does each role actually call, at what cost, with what bounce rate", and "what does
 * each seat's rendered surface weigh". Ingest is best-effort observability (a failure must never
 * break the tool call it measures); the projection is derived at report time like everything else
 * in the insight engine.
 */

const BUCKET_MS = 60 * 60 * 1000; // hourly — 18 tools × 3 outcomes × a few seats stays tiny
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Fold one adapter flush into the hourly aggregate. Events are deltas accumulated adapter-side;
 * the whole batch lands in the arrival hour (a flush window is ≤ a minute — sub-bucket precision
 * isn't worth per-event timestamps on the wire). `role` is the caller's role at ingest,
 * server-resolved: it annotates the row (last write wins), it never keys it.
 */
export function recordToolCalls(
  db: Database,
  teamId: string,
  seat: string,
  role: string | null,
  events: ToolCallEvent[],
  now: number = Date.now(),
): void {
  if (events.length === 0) return;
  const bucket = now - (now % BUCKET_MS);
  const upsert = db.prepare(
    `INSERT INTO tool_call_stats
       (team_id, seat, role, tool, outcome, bucket_start, calls, total_duration_ms, max_duration_ms)
     VALUES (@team_id, @seat, @role, @tool, @outcome, @bucket_start, @calls, @total_duration_ms, @max_duration_ms)
     ON CONFLICT (team_id, seat, tool, outcome, bucket_start) DO UPDATE SET
       calls = calls + excluded.calls,
       total_duration_ms = total_duration_ms + excluded.total_duration_ms,
       max_duration_ms = MAX(max_duration_ms, excluded.max_duration_ms),
       role = COALESCE(excluded.role, role)`,
  );
  const tx = db.transaction((batch: ToolCallEvent[]) => {
    for (const e of batch) {
      upsert.run({
        team_id: teamId,
        seat,
        role,
        tool: e.tool,
        outcome: e.outcome,
        bucket_start: bucket,
        calls: e.calls,
        total_duration_ms: e.total_duration_ms,
        max_duration_ms: e.max_duration_ms,
      });
    }
  });
  tx(events);
}

/**
 * Record a seat's attested rendered-surface weight as an append-only `mcp.surface_rendered` audit
 * row (the `residency.wake_cost` precedent: a measured cost the ledger carries). Once per adapter
 * session by contract (the adapter sends it on its first flush only), so the ledger stays legible.
 */
export function recordSurfaceRender(
  db: Database,
  teamId: string,
  seat: string,
  surface: SurfaceRender,
): void {
  appendAudit(db, teamId, {
    actor: seat,
    action: 'mcp.surface_rendered',
    target: seat,
    result: 'allow',
    detail: {
      tools: surface.tools,
      bytes: surface.bytes,
      est_tokens: surface.est_tokens,
      ...(surface.breakdown ? { breakdown: surface.breakdown } : {}),
    },
  });
}

interface StatRow {
  seat: string;
  role: string | null;
  tool: string;
  outcome: string;
  calls: number;
  total_duration_ms: number;
  max_duration_ms: number;
}

/**
 * The tool-call block of the insight report: per-tool usage/bounce/latency over the window, plus
 * the latest attested surface weight per seat. One grouped pass over the aggregate + one over the
 * `mcp.surface_rendered` trail; diagnostic instruments, never a score.
 */
export function deriveToolCallMetrics(
  db: Database,
  teamId: string,
  now: number = Date.now(),
): ToolCallMetrics {
  const since = now - WINDOW_MS;
  const rows = db
    .prepare<[string, number], StatRow>(
      `SELECT seat, role, tool, outcome,
              SUM(calls) AS calls,
              SUM(total_duration_ms) AS total_duration_ms,
              MAX(max_duration_ms) AS max_duration_ms
         FROM tool_call_stats
        WHERE team_id = ? AND bucket_start > ?
        GROUP BY seat, role, tool, outcome`,
    )
    .all(teamId, since);

  interface ToolAcc {
    calls: number;
    errors: number;
    bounces: number;
    total_ms: number;
    max_ms: number;
    by_role: Record<string, number>;
  }
  const byTool = new Map<string, ToolAcc>();
  for (const r of rows) {
    let acc = byTool.get(r.tool);
    if (!acc)
      byTool.set(
        r.tool,
        (acc = { calls: 0, errors: 0, bounces: 0, total_ms: 0, max_ms: 0, by_role: {} }),
      );
    acc.calls += r.calls;
    if (r.outcome === 'error') acc.errors += r.calls;
    if (r.outcome === 'invalid_input') acc.bounces += r.calls;
    acc.total_ms += r.total_duration_ms;
    acc.max_ms = Math.max(acc.max_ms, r.max_duration_ms);
    const role = r.role ?? 'unroled';
    acc.by_role[role] = (acc.by_role[role] ?? 0) + r.calls;
  }

  const tools: ToolUsageRow[] = [...byTool.entries()]
    .map(([tool, a]) => ({
      tool,
      calls: a.calls,
      errors: a.errors,
      bounces: a.bounces,
      bounce_rate: a.calls > 0 ? a.bounces / a.calls : null,
      avg_duration_ms: a.calls > 0 ? Math.round(a.total_ms / a.calls) : null,
      max_duration_ms: a.calls > 0 ? a.max_ms : null,
      by_role: a.by_role,
    }))
    .sort((x, y) => y.calls - x.calls || x.tool.localeCompare(y.tool));

  // Latest attested weight per seat — an attestation like `presence.build`, so it is not
  // window-bound: the newest row per seat stands until the next session re-attests.
  const surfaceRows = db
    .prepare<[string], { target: string | null; ts: number; detail: string | null }>(
      `SELECT target, ts, detail FROM audit
        WHERE team_id = ? AND action = 'mcp.surface_rendered'
        ORDER BY ts DESC, id DESC`,
    )
    .all(teamId);
  const surface: SeatSurfaceWeight[] = [];
  const seen = new Set<string>();
  for (const r of surfaceRows) {
    if (!r.target || seen.has(r.target)) continue;
    seen.add(r.target);
    try {
      const d = JSON.parse(r.detail ?? '{}') as {
        tools?: number;
        bytes?: number;
        est_tokens?: number;
      };
      if (typeof d.tools !== 'number' || typeof d.bytes !== 'number') continue;
      surface.push({
        seat: r.target,
        ts: r.ts,
        tools: d.tools,
        bytes: d.bytes,
        est_tokens: d.est_tokens ?? Math.round(d.bytes / 4),
      });
    } catch {
      /* best-effort rows stay skippable */
    }
  }
  surface.sort((a, b) => a.seat.localeCompare(b.seat));

  return {
    window_days: WINDOW_DAYS,
    calls: tools.reduce((n, t) => n + t.calls, 0),
    bounces: tools.reduce((n, t) => n + t.bounces, 0),
    tools,
    surface,
  };
}
