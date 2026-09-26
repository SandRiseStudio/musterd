import { createHmac, randomBytes } from 'node:crypto';
import {
  normalizeTraceDetail,
  scrubCredentials,
  structuralToolName,
  type SyncTraceRow,
  TRACE_CONTENT_FIELDS,
  TRACE_ID_DIGEST_LEN,
  type TraceContent,
  type TraceEvent,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import {
  CONTENT_CAPTURED_THROUGH_KEY,
  SYNC_TRACE_ID_KEY,
  syncTraceCursorKey,
} from '../db/traceDb.js';

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
): { accepted: number; content: number; normalized: number } {
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
    let normalized = 0;
    for (const e of batch) {
      let seq = cursors.get(e.session_digest);
      if (seq === undefined) seq = nextSeq.get(teamId, e.session_digest)!.next;
      cursors.set(e.session_digest, seq + 1);
      const stored = opts.writeContent && e.content ? scrubStoredContent(e.content) : undefined;
      if (stored) withContent++;
      // ADR 453 §2, rule 3: the local store holds the structural shape too, so the three
      // boundaries (ingest, pusher, hub) agree on one definition. Normalize, never reject — a tap
      // must not lose a row over one odd field. Ids stay raw here; they are digested on the wire.
      const tool = structuralToolName(e.harness, e.tool_name);
      const det = normalizeTraceDetail(e.kind, e.detail);
      normalized += (tool.normalized ? 1 : 0) + det.normalized;
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
        tool_name: tool.name,
        tool_use_id: e.tool_use_id ?? null,
        agent_id: e.agent_id ?? null,
        parent_agent_id: e.parent_agent_id ?? null,
        duration_ms: e.duration_ms ?? null,
        outcome: e.outcome ?? null,
        detail: det.detail === null ? null : JSON.stringify(det.detail),
        content: stored?.json ?? null,
        redactions: stored?.redactions ?? null,
        truncated: stored?.truncated ? 1 : 0,
      });
      accepted++;
    }
    return { accepted, content: withContent, normalized };
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
  /** When the content lifecycle nulled `content` (migration 2); null while content is live or was
   *  never captured. */
  content_pruned_at: number | null;
  /** The node that minted the row (migration 3, ADR 453): null = this daemon; a node id = received
   *  over `/sync/trace` from that joiner. */
  origin_node: string | null;
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

/** How long content stays in the live store (ADR 445 §3). Structural columns are never pruned. */
export const TRACE_CONTENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows per prune transaction — short enough that no single statement holds the writer for long
 *  (the daemon wedged twice on 2026-09-24 in synchronous SQLite work), and {@link
 *  TRACE_PRUNE_MAX_BATCHES} of them per tick clears a day's content (~27k rows, measured
 *  2026-09-25) in one pass. */
export const TRACE_PRUNE_BATCH = 2_000;
export const TRACE_PRUNE_MAX_BATCHES = 25;

/** The capture watermark `corpus:snapshot` stamped, or null on a machine that never archived. */
export function contentCapturedThrough(traceDb: Database): number | null {
  const row = traceDb
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get(CONTENT_CAPTURED_THROUGH_KEY);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Null the content column of rows past the content window (ADR 445 §3: "content older than 30 days
 * is pruned unless `corpus:snapshot` captured it"), keeping every structural column and stamping
 * `content_pruned_at`.
 *
 * The capture clause is read as "never before a snapshot holds it": on a machine where
 * `corpus:snapshot` has ever captured `trace.db` (the watermark exists), a row is pruned only once
 * it is BOTH past the window and strictly below the watermark — so the prune never destroys the
 * only copy of an archived corpus. A machine that has never archived has no watermark and gets the
 * plain 30-day bound; content there was never going to be kept.
 *
 * Batched: each batch is its own short transaction, and a tick stops after
 * {@link TRACE_PRUNE_MAX_BATCHES}; the rest waits for the next tick.
 */
export function pruneTraceContent(
  traceDb: Database,
  now: number = Date.now(),
  opts: { maxAgeMs?: number; batch?: number; maxBatches?: number } = {},
): { pruned: number; cutoff: number; capturedThrough: number | null } {
  const windowCutoff = now - (opts.maxAgeMs ?? TRACE_CONTENT_MAX_AGE_MS);
  const capturedThrough = contentCapturedThrough(traceDb);
  const cutoff = capturedThrough === null ? windowCutoff : Math.min(windowCutoff, capturedThrough);
  const batch = opts.batch ?? TRACE_PRUNE_BATCH;
  const maxBatches = opts.maxBatches ?? TRACE_PRUNE_MAX_BATCHES;
  const prune = traceDb.prepare<[number, number, number]>(`
    UPDATE trace_events SET content = NULL, content_pruned_at = ?
     WHERE rowid IN (
       SELECT rowid FROM trace_events
        WHERE content IS NOT NULL AND received_at < ?
        ORDER BY received_at LIMIT ?
     )
  `);
  let pruned = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { changes } = prune.run(now, cutoff, batch);
    pruned += changes;
    if (changes < batch) break;
  }
  return { pruned, cutoff, capturedThrough };
}

/** How often the daemon runs {@link pruneTraceContent}, and how long after boot the first pass waits
 *  (off the boot path — reconcile and the first requests come first). */
export const TRACE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const TRACE_PRUNE_FIRST_DELAY_MS = 60 * 1000;

/**
 * The daemon's content-prune loop. A failing pass logs and the loop keeps running — the prune can
 * delay a bound, never take the daemon down. Returns the stop function `close()` calls.
 */
export function startTraceContentPrune(
  traceDb: Database,
  onPass: (r: ReturnType<typeof pruneTraceContent>) => void,
  onError: (err: unknown) => void,
): () => void {
  const pass = () => {
    try {
      onPass(pruneTraceContent(traceDb));
    } catch (err) {
      onError(err);
    }
  };
  const first = setTimeout(pass, TRACE_PRUNE_FIRST_DELAY_MS);
  first.unref?.();
  const every = setInterval(pass, TRACE_PRUNE_INTERVAL_MS);
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
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

// ── replication (ADR 453) ───────────────────────────────────────────────────────────────────────

function readMeta(traceDb: Database, key: string): string | null {
  return (
    traceDb
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get(key)?.value ?? null
  );
}

function writeMeta(traceDb: Database, key: string, value: string): void {
  traceDb
    .prepare(
      'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

/**
 * The per-machine id-digest key (ADR 453 §2), minted on first use into this file's `schema_meta`.
 * Random, never sent, never logged; the same id digests the same way here for the file's life.
 */
export function syncTraceIdKey(traceDb: Database): Buffer {
  const held = readMeta(traceDb, SYNC_TRACE_ID_KEY);
  if (held) return Buffer.from(held, 'hex');
  const key = randomBytes(32);
  writeMeta(traceDb, SYNC_TRACE_ID_KEY, key.toString('hex'));
  return key;
}

/** An opaque harness id as it crosses to the hub: `HMAC-SHA256(key, id)` cut to 24 hex characters. */
export function digestTraceId(key: Buffer, id: string | null): string | null {
  if (id === null || id === '') return null;
  return createHmac('sha256', key).update(id).digest('hex').slice(0, TRACE_ID_DIGEST_LEN);
}

/** The pusher's cursor for a team: the highest `rowid` the hub has acked (0 = nothing yet). */
export function readSyncTraceCursor(traceDb: Database, teamId: string): number {
  const v = Number(readMeta(traceDb, syncTraceCursorKey(teamId)) ?? '0');
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

export function advanceSyncTraceCursor(traceDb: Database, teamId: string, rowid: number): void {
  writeMeta(traceDb, syncTraceCursorKey(teamId), String(rowid));
}

/**
 * The next batch of THIS daemon's own rows after the cursor, in `rowid` order, already shaped for
 * the wire (ADR 453 §2, rule 2): structural columns SELECTed by name (content is never read), the
 * tool name normalized to the harness namespace, the detail normalized per kind, and the three
 * opaque ids digested under the machine key. `rowid` is sound as a cursor: nothing deletes from
 * `trace_events` (the content prune is an UPDATE), so it only grows. Rows with an `origin_node`
 * are never offered — they are a joiner's, held here on a hub, and the hub forwards nothing.
 */
export function unpushedTraceRows(
  traceDb: Database,
  teamId: string,
  after: number,
  limit: number,
): { rows: SyncTraceRow[]; last: number; normalized: number } {
  const key = syncTraceIdKey(traceDb);
  const raw = traceDb
    .prepare<
      [string, number, number],
      {
        rowid: number;
        id: string;
        seat: string;
        session_digest: string;
        seq: number;
        ts: number;
        received_at: number;
        harness: string;
        kind: SyncTraceRow['kind'];
        tool_name: string | null;
        tool_use_id: string | null;
        agent_id: string | null;
        parent_agent_id: string | null;
        duration_ms: number | null;
        outcome: SyncTraceRow['outcome'];
        detail: string | null;
      }
    >(
      `SELECT rowid, id, seat, session_digest, seq, ts, received_at, harness, kind, tool_name,
              tool_use_id, agent_id, parent_agent_id, duration_ms, outcome, detail
         FROM trace_events
        WHERE team_id = ? AND rowid > ? AND origin_node IS NULL
        ORDER BY rowid LIMIT ?`,
    )
    .all(teamId, after, limit);
  let normalized = 0;
  const rows: SyncTraceRow[] = raw.map((r) => {
    const tool = structuralToolName(r.harness, r.tool_name);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    const det = normalizeTraceDetail(r.kind, parsed);
    normalized += (tool.normalized ? 1 : 0) + det.normalized;
    return {
      id: r.id,
      seat: r.seat,
      session_digest: r.session_digest,
      seq: r.seq,
      ts: r.ts,
      received_at: r.received_at,
      harness: r.harness,
      kind: r.kind,
      tool_name: tool.name,
      tool_use_id: digestTraceId(key, r.tool_use_id),
      agent_id: digestTraceId(key, r.agent_id),
      parent_agent_id: digestTraceId(key, r.parent_agent_id),
      duration_ms: r.duration_ms,
      outcome: r.outcome,
      detail: det.detail,
    };
  });
  return { rows, last: raw.length > 0 ? raw[raw.length - 1]!.rowid : after, normalized };
}

/**
 * The hub's write for a `/sync/trace` batch (ADR 453 §2): one transaction, `INSERT OR IGNORE` per
 * row with the origin's `seq`/`ts`/`received_at` verbatim and `origin_node` set. A row that inserts
 * nothing is classified by one lookup: the same `id` held → `ignored` (a re-push); otherwise it hit
 * `UNIQUE (team, session_digest, seq)` under a different id → `collided`, counted apart so a digest
 * collision cannot hide inside the re-push count. The residence check is the ROUTE's (it needs the
 * coordination store); rows arrive here already admitted.
 */
export function ingestSyncedTraceRows(
  traceDb: Database,
  teamId: string,
  originNode: string,
  rows: readonly SyncTraceRow[],
): { accepted: number; ignored: number; collided: number } {
  const insert = traceDb.prepare(`
    INSERT OR IGNORE INTO trace_events (
      id, team_id, seat, session_digest, seq, ts, received_at, harness, kind,
      tool_name, tool_use_id, agent_id, parent_agent_id, duration_ms, outcome, detail,
      content, redactions, truncated, origin_node
    ) VALUES (
      @id, @team_id, @seat, @session_digest, @seq, @ts, @received_at, @harness, @kind,
      @tool_name, @tool_use_id, @agent_id, @parent_agent_id, @duration_ms, @outcome, @detail,
      NULL, NULL, 0, @origin_node
    )
  `);
  const held = traceDb.prepare<[string], { one: number }>(
    'SELECT 1 AS one FROM trace_events WHERE id = ?',
  );
  const run = traceDb.transaction((batch: readonly SyncTraceRow[]) => {
    let accepted = 0;
    let ignored = 0;
    let collided = 0;
    for (const r of batch) {
      const { changes } = insert.run({
        id: r.id,
        team_id: teamId,
        seat: r.seat,
        session_digest: r.session_digest,
        seq: r.seq,
        ts: r.ts,
        received_at: r.received_at,
        harness: r.harness,
        kind: r.kind,
        tool_name: r.tool_name,
        tool_use_id: r.tool_use_id,
        agent_id: r.agent_id,
        parent_agent_id: r.parent_agent_id,
        duration_ms: r.duration_ms,
        outcome: r.outcome,
        detail: r.detail === null ? null : JSON.stringify(r.detail),
        origin_node: originNode,
      });
      if (changes > 0) accepted++;
      else if (held.get(r.id)) ignored++;
      else collided++;
    }
    return { accepted, ignored, collided };
  });
  return run(rows);
}
