import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Binding,
  scrubCredentials,
  TRACE_CONTENT_MAX_BYTES,
  TRACE_MAX_BATCH,
  TRACE_TAIL_FILE,
  type TraceEvent,
  TraceEventSchema,
} from '@musterd/protocol';
import { sessionDigest } from '../session/digest.js';
import {
  emitTraceEvents,
  traceClient,
  traceContentEnabled,
  traceTapEnabled,
  writeTraceContentMode,
} from './hook.js';
import {
  CLAUDE_TRANSCRIPT_PARSER,
  CODEX_TRANSCRIPT_PARSER,
  type TranscriptRecord,
  transcriptParserFor,
} from './transcript.js';

/**
 * Rail R2, the transcript tail (ADR 445 §2, increment 2). The host tails
 * `binding.session.transcript_path` and posts `reasoning` / `assistant_text` / `usage` events keyed
 * to the same session digest as rail R1.
 *
 * **Who runs it: the hook processes that already exist.** There is no long-lived tailer. The Claude
 * Code `Stop` hook (end of every turn), the `SessionEnd` capture, and the Codex `post-tool-use` /
 * `end` hooks each read the transcript's DELTA since the last read — an offset cursor per session in
 * `.musterd/trace-tail.json` — parse it, and post. A turn's reasoning therefore lands one turn late
 * at worst, and a dead session's remainder lands at SessionEnd.
 *
 * **Fail-open, like the rest of the tap.** Every miss is a dropped delta, never a failed hook. The
 * offset advances only when every posted chunk landed, so a missed post is retried on the next hook
 * (at the price of possible duplicates when a reply was lost after the daemon stored the rows —
 * research substrate accepts that trade; rows carry `seq` and `received_at` to see it).
 *
 * **A parse failure downgrades the session** (ADR 445 §2): the cursor is marked and the tail posts
 * one `unknown` event with `detail.downgraded`, which the daemon turns into a `trace.downgraded`
 * audit row. From then on the session is structural-only — R1 keeps recording; R2 stops reading.
 */

/** Per-session read state. `path` pins the cursor to one transcript file: a session that moves
 *  files re-reads from zero rather than misapply an offset. */
export interface TailCursor {
  path: string;
  offset: number;
  updated_at: number;
  /** Set on a parse failure or a truncated file — the session is structural-only from then on. */
  downgraded?: boolean;
}

interface TailFile {
  sessions: Record<string, TailCursor>;
}

/** How many session cursors the file keeps — oldest pruned first. A workspace has a handful of
 *  live sessions at most; the bound exists so the file cannot grow with history. */
export const TAIL_SESSION_CAP = 16;

/** The most transcript one hook process will read. A Stop-hook delta is one turn (KiB to a few
 *  hundred KiB); this bound is for the catch-up read of a session that predates the tail. What lies
 *  past it is read by the following hooks, `offset` advancing each time. */
export const TAIL_MAX_DELTA_BYTES = 16 * 1024 * 1024;

export function readTailCursor(dir: string, digest: string): TailCursor | undefined {
  return readTailFile(dir).sessions[digest];
}

function readTailFile(dir: string): TailFile {
  try {
    const json: unknown = JSON.parse(readFileSync(join(dir, '.musterd', TRACE_TAIL_FILE), 'utf8'));
    const sessions = (json as TailFile).sessions;
    if (typeof sessions === 'object' && sessions !== null) return { sessions };
  } catch {
    /* absent or unreadable — start fresh */
  }
  return { sessions: {} };
}

export function writeTailCursor(dir: string, digest: string, cursor: TailCursor): void {
  try {
    const file = readTailFile(dir);
    file.sessions[digest] = cursor;
    const entries = Object.entries(file.sessions).sort((a, b) => b[1].updated_at - a[1].updated_at);
    file.sessions = Object.fromEntries(entries.slice(0, TAIL_SESSION_CAP));
    writeFileSync(join(dir, '.musterd', TRACE_TAIL_FILE), JSON.stringify(file) + '\n');
  } catch {
    /* a missing .musterd/ is an unbound folder — nothing to remember */
  }
}

/**
 * Read the transcript's unread suffix: whole lines only (a partial trailing line — the harness
 * mid-append — stays unread and unadvanced), at most {@link TAIL_MAX_DELTA_BYTES}. Returns the
 * lines and the offset they end at, or null when the file cannot be read (transient; not a
 * downgrade — the next hook retries).
 */
export function readTranscriptDelta(
  path: string,
  offset: number,
): { lines: string[]; nextOffset: number } | null {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size <= offset) return { lines: [], nextOffset: offset };
    const want = Math.min(size - offset, TAIL_MAX_DELTA_BYTES);
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(want);
    const got = readSync(fd, buf, 0, want, offset);
    const chunk = buf.subarray(0, got);
    // Advance only past the last complete line. UTF-8 safe: 0x0a never occurs inside a multi-byte
    // sequence, so slicing at it cannot split a character across reads.
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], nextOffset: offset };
    const complete = chunk.subarray(0, lastNewline + 1);
    return {
      lines: complete.toString('utf8').split('\n').filter(Boolean),
      nextOffset: offset + lastNewline + 1,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Cut a string to at most `max` UTF-8 bytes without leaving half a character behind. */
function cutBytes(s: string, max: number): string {
  return Buffer.from(s, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
}

/**
 * Build the wire event for one parsed record. Content (scrubbed, then bounded — the hook.ts order,
 * so a credential cannot survive by being split at the bound) only when the caller passed the
 * gates; `unknown` and `usage` records have no text so never a content part.
 */
export function buildTailEvent(
  record: TranscriptRecord,
  opts: { harness: string; digest: string; content: boolean; now?: number },
): TraceEvent | null {
  const field = record.kind === 'reasoning' ? 'reasoning' : 'assistant';
  let content: TraceEvent['content'];
  if (
    opts.content &&
    record.text &&
    (record.kind === 'reasoning' || record.kind === 'assistant_text')
  ) {
    const scrubbed = scrubCredentials(record.text);
    let kept = scrubbed.text;
    let truncated = false;
    if (Buffer.byteLength(kept, 'utf8') > TRACE_CONTENT_MAX_BYTES) {
      kept = cutBytes(kept, TRACE_CONTENT_MAX_BYTES);
      truncated = true;
    }
    content = { [field]: kept, redactions: scrubbed.redactions, truncated };
  }
  const candidate = {
    harness: opts.harness,
    session_digest: opts.digest,
    ts: record.ts ?? opts.now ?? Date.now(),
    kind: record.kind,
    ...(record.tool_use_id ? { tool_use_id: record.tool_use_id.slice(0, 128) } : {}),
    detail: record.detail,
    ...(content ? { content } : {}),
  };
  const ok = TraceEventSchema.safeParse(candidate);
  if (ok.success) return ok.data;
  // A content part the schema refuses must not cost the structural row it rode on.
  if (candidate.content === undefined) return null;
  const { content: _dropped, ...structural } = candidate;
  const retry = TraceEventSchema.safeParse(structural);
  return retry.success ? retry.data : null;
}

/** The downgrade marker event — the daemon writes the `trace.downgraded` audit row when it sees
 *  `detail.downgraded` (ADR 445 §2: "a parse failure downgrades the session … with an audit row"). */
function downgradeEvent(
  harness: string,
  digest: string,
  parser: string,
  reason: string,
): TraceEvent | null {
  const candidate = {
    harness,
    session_digest: digest,
    ts: Date.now(),
    kind: 'unknown' as const,
    outcome: 'error' as const,
    detail: { parser, downgraded: true, reason: reason.slice(0, 64) },
  };
  const ok = TraceEventSchema.safeParse(candidate);
  return ok.success ? ok.data : null;
}

/**
 * The one-call form the hook sites use: cursor → delta → parse → build → post → advance. Never
 * throws; never reads past the byte bound; returns whether anything landed (for a caller's counter,
 * never control flow).
 */
export async function tailTranscript(opts: {
  binding: Binding | null;
  dir: string;
  harness: string;
  sessionId: string;
  transcriptPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  try {
    if (!traceTapEnabled(opts.env)) return false;
    const binding = opts.binding;
    if (!binding?.agent_key) return false;
    const parse = transcriptParserFor(opts.harness);
    if (!parse) return false;
    const digest = sessionDigest(binding.agent_key, opts.sessionId);
    const cursor = readTailCursor(opts.dir, digest);
    if (cursor?.downgraded) return false;
    const offset = cursor && cursor.path === opts.transcriptPath ? cursor.offset : 0;

    const http = traceClient(binding, opts.dir);
    if (!http) return false;
    const post = (events: readonly TraceEvent[]): Promise<boolean> =>
      emitTraceEvents(http, binding.team, events, undefined, (mode) =>
        writeTraceContentMode(opts.dir, mode),
      );

    // A file shorter than the cursor is not append-only any more — the parser's ground assumption
    // is gone, so the session downgrades rather than guess at what a re-read would duplicate.
    let size: number;
    try {
      size = statSync(opts.transcriptPath).size;
    } catch {
      return false; // transient: transcript not on disk yet (SessionStart names it early)
    }
    if (size < offset) {
      return await downgrade(opts, digest, 'transcript_truncated', post);
    }

    const delta = readTranscriptDelta(opts.transcriptPath, offset);
    if (delta === null) return false;
    if (delta.lines.length === 0) return true;

    let records: TranscriptRecord[];
    try {
      records = parse(delta.lines);
    } catch {
      // The parsers are tolerant by construction; a throw is a defect, and the honest reading of
      // one is "this format is beyond this parser" — the downgrade contract, not a silent retry.
      return await downgrade(opts, digest, 'parse_failure', post);
    }

    const content = traceContentEnabled(binding, opts.dir);
    const events: TraceEvent[] = [];
    for (const record of records) {
      const event = buildTailEvent(record, { harness: opts.harness, digest, content });
      if (event) events.push(event);
    }

    let allLanded = true;
    for (let i = 0; i < events.length; i += TRACE_MAX_BATCH) {
      if (!(await post(events.slice(i, i + TRACE_MAX_BATCH)))) {
        allLanded = false;
        break;
      }
    }
    // Advance only when everything landed — a dropped delta is re-read by the next hook.
    if (allLanded || events.length === 0) {
      writeTailCursor(opts.dir, digest, {
        path: opts.transcriptPath,
        offset: delta.nextOffset,
        updated_at: Date.now(),
      });
    }
    return allLanded && events.length > 0;
  } catch {
    return false;
  }
}

async function downgrade(
  opts: { dir: string; harness: string; transcriptPath: string },
  digest: string,
  reason: string,
  post: (events: readonly TraceEvent[]) => Promise<boolean>,
): Promise<boolean> {
  writeTailCursor(opts.dir, digest, {
    path: opts.transcriptPath,
    offset: 0,
    updated_at: Date.now(),
    downgraded: true,
  });
  const marker = downgradeEvent(
    opts.harness,
    digest,
    transcriptParserVersion(opts.harness),
    reason,
  );
  if (marker) await post([marker]);
  return false;
}

function transcriptParserVersion(harness: string): string {
  return harness === 'codex' ? CODEX_TRANSCRIPT_PARSER : CLAUDE_TRANSCRIPT_PARSER;
}
