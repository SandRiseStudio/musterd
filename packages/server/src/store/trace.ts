import type { TraceEvent } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/**
 * The trace store's writer (ADR 445 §3, increment 1a). Structural columns only: this function has
 * no parameter through which a tool input, response, prompt or transcript could arrive — the
 * `content` column exists in the DDL and is never named here. Increment 1b adds a second writer
 * behind the credential scrub; this one stays the structural default that runs whether or not a
 * team turned content on.
 *
 * `seq` is assigned here, per (team, session): a hook is a one-shot process with no counter to
 * share, so the daemon is the only place a monotonic sequence can be minted without a lock file
 * per tool call. The whole batch is one transaction, so two hooks racing on the same session cannot
 * interleave their sequences.
 */
export function ingestTraceEvents(
  traceDb: Database,
  teamId: string,
  seat: string,
  events: readonly TraceEvent[],
): { accepted: number } {
  const nextSeq = traceDb.prepare<[string, string], { next: number }>(
    'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM trace_events WHERE team_id = ? AND session_digest = ?',
  );
  const insert = traceDb.prepare(`
    INSERT INTO trace_events (
      id, team_id, seat, session_digest, seq, ts, received_at, harness, kind,
      tool_name, tool_use_id, agent_id, parent_agent_id, duration_ms, outcome, detail
    ) VALUES (
      @id, @team_id, @seat, @session_digest, @seq, @ts, @received_at, @harness, @kind,
      @tool_name, @tool_use_id, @agent_id, @parent_agent_id, @duration_ms, @outcome, @detail
    )
  `);
  const now = Date.now();
  const run = traceDb.transaction((batch: readonly TraceEvent[]) => {
    // One MAX per distinct session in the batch, then count up locally — a batch is normally one
    // session, and a per-row MAX would re-scan the index for every event.
    const cursors = new Map<string, number>();
    let accepted = 0;
    for (const e of batch) {
      let seq = cursors.get(e.session_digest);
      if (seq === undefined) seq = nextSeq.get(teamId, e.session_digest)!.next;
      cursors.set(e.session_digest, seq + 1);
      insert.run({
        id: ulid(),
        team_id: teamId,
        seat,
        session_digest: e.session_digest,
        seq,
        ts: e.ts,
        received_at: now,
        harness: e.harness,
        kind: e.kind,
        tool_name: e.tool_name ?? null,
        tool_use_id: e.tool_use_id ?? null,
        agent_id: e.agent_id ?? null,
        parent_agent_id: e.parent_agent_id ?? null,
        duration_ms: e.duration_ms ?? null,
        outcome: e.outcome ?? null,
        detail: e.detail === undefined ? null : JSON.stringify(e.detail),
      });
      accepted++;
    }
    return accepted;
  });
  return { accepted: run(events) };
}

export interface TraceEventRow {
  id: string;
  team_id: string;
  seat: string;
  session_digest: string;
  seq: number;
  ts: number;
  received_at: number;
  harness: string;
  kind: string;
  tool_name: string | null;
  tool_use_id: string | null;
  agent_id: string | null;
  parent_agent_id: string | null;
  duration_ms: number | null;
  outcome: string | null;
  detail: string | null;
  content: string | null;
  redactions: number | null;
  truncated: number;
}

/** One session's events in sequence order — the read the coverage eval and `trace show` (inc 2) use. */
export function listSessionTrace(
  traceDb: Database,
  teamId: string,
  sessionDigest: string,
): TraceEventRow[] {
  return traceDb
    .prepare<
      [string, string],
      TraceEventRow
    >('SELECT * FROM trace_events WHERE team_id = ? AND session_digest = ? ORDER BY seq')
    .all(teamId, sessionDigest);
}

/** Per-kind counts for a team (optionally one seat) — the `musterd.trace.ingest` cross-check. */
export function countTraceEvents(
  traceDb: Database,
  teamId: string,
  seat?: string,
): { kind: string; count: number }[] {
  return seat === undefined
    ? traceDb
        .prepare<
          [string],
          { kind: string; count: number }
        >('SELECT kind, COUNT(*) AS count FROM trace_events WHERE team_id = ? GROUP BY kind ORDER BY kind')
        .all(teamId)
    : traceDb
        .prepare<
          [string, string],
          { kind: string; count: number }
        >('SELECT kind, COUNT(*) AS count FROM trace_events WHERE team_id = ? AND seat = ? GROUP BY kind ORDER BY kind')
        .all(teamId, seat);
}
