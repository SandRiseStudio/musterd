import {
  scrubCredentials,
  TRACE_CONTENT_FIELDS,
  type TraceContent,
  type TraceEvent,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/**
 * The daemon's pass of the credential scrub (ADR 445 §3) over a content part the hook already
 * scrubbed. The hook's pass is the one that matters — this is the net under an older or foreign tap
 * that sent content unscrubbed. Returns what goes in the `content` column (the fields only, as JSON)
 * and the row's total redaction count (the hook's plus any this pass found).
 */
export function scrubStoredContent(content: TraceContent): {
  json: string;
  redactions: number;
  truncated: boolean;
} {
  const fields: Partial<Record<(typeof TRACE_CONTENT_FIELDS)[number], string>> = {};
  let redactions = content.redactions;
  for (const f of TRACE_CONTENT_FIELDS) {
    const v = content[f];
    if (v === undefined) continue;
    const r = scrubCredentials(v);
    fields[f] = r.text;
    redactions += r.redactions;
  }
  return { json: JSON.stringify(fields), redactions, truncated: content.truncated };
}

/**
 * The trace store's writer (ADR 445 §3). Structural columns always. The content column only when
 * the caller passes `writeContent` — the route decides that from the team's `trace.content` policy,
 * and with it off a content part that arrived anyway is dropped here, never stored. Content goes
 * through {@link scrubStoredContent} on its way in, whatever the hook already did.
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
  opts: { writeContent?: boolean } = {},
): { accepted: number; content: number } {
  const nextSeq = traceDb.prepare<[string, string], { next: number }>(
    'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM trace_events WHERE team_id = ? AND session_digest = ?',
  );
  const insert = traceDb.prepare(`
    INSERT INTO trace_events (
      id, team_id, seat, session_digest, seq, ts, received_at, harness, kind,
      tool_name, tool_use_id, agent_id, parent_agent_id, duration_ms, outcome, detail,
      content, redactions, truncated
    ) VALUES (
      @id, @team_id, @seat, @session_digest, @seq, @ts, @received_at, @harness, @kind,
      @tool_name, @tool_use_id, @agent_id, @parent_agent_id, @duration_ms, @outcome, @detail,
      @content, @redactions, @truncated
    )
  `);
  const now = Date.now();
  const run = traceDb.transaction((batch: readonly TraceEvent[]) => {
    // One MAX per distinct session in the batch, then count up locally — a batch is normally one
    // session, and a per-row MAX would re-scan the index for every event.
    const cursors = new Map<string, number>();
    let accepted = 0;
    let withContent = 0;
    for (const e of batch) {
      let seq = cursors.get(e.session_digest);
      if (seq === undefined) seq = nextSeq.get(teamId, e.session_digest)!.next;
      cursors.set(e.session_digest, seq + 1);
      const stored = opts.writeContent && e.content ? scrubStoredContent(e.content) : undefined;
      if (stored) withContent++;
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
        content: stored?.json ?? null,
        redactions: stored?.redactions ?? null,
        truncated: stored?.truncated ? 1 : 0,
      });
      accepted++;
    }
    return { accepted, content: withContent };
  });
  return run(events);
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
