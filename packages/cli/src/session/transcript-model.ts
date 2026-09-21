import { openSync, readSync, readFileSync, statSync, closeSync } from 'node:fs';

/**
 * The single place that knows a harness transcript's on-disk shape.
 *
 * A harness hands its hooks a `transcript_path` on stdin — a documented input — but the *format* of
 * that file is not documented and can move without notice. Isolating the parse here means a format
 * change degrades the whole observed-attestation tier to `undefined` (i.e. back to declaration-only,
 * the honest fallback) instead of breaking a hook. Every failure path returns `undefined`; this
 * function never throws, because it runs inside a hook and a hook must never fail.
 */

/** Read only the tail: transcripts grow unbounded and the newest turn is always at the end. */
const TAIL_BYTES = 256 * 1024;

/** The wire cap on an attested model id, mirroring `resolveAttestedModel`. */
const MAX_MODEL_LEN = 120;

/**
 * Written in place of a model id for synthetic turns. Observed in real transcripts; attesting it
 * would put a sentinel on the roster where a model belongs.
 */
const SYNTHETIC = '<synthetic>';

/**
 * The model id from the newest assistant turn in a harness transcript, or `undefined` when the file
 * cannot be read, carries no model, or is not in a shape we recognise.
 *
 * Walks backwards so a session that switched models mid-run attests the one it is running *now*.
 */
export function readModelFromTranscript(path: string): string | undefined {
  let raw: string;
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) return undefined;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const length = stat.size - start;
    const buf = Buffer.allocUnsafe(length);
    fd = openSync(path, 'r');
    const read = readSync(fd, buf, 0, length, start);
    raw = buf.subarray(0, read).toString('utf8');
  } catch {
    return undefined; // missing, unreadable, a directory, a race — never fail a hook
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close; the read already succeeded or we already bailed
      }
    }
  }

  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A sliced head (we started mid-line) or a truncated tail (the harness is mid-write). Skip it:
      // one unreadable line is never a reason to give up on the rest of the tail.
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const message = (parsed as Record<string, unknown>)['message'];
    if (typeof message !== 'object' || message === null) continue;
    const model = (message as Record<string, unknown>)['model'];
    if (typeof model !== 'string' || model === '' || model === SYNTHETIC) continue;
    return model.slice(0, MAX_MODEL_LEN);
  }
  return undefined;
}

/**
 * The bytes of a transcript that a `--resume` actually replays: its `user` and `assistant` records.
 *
 * Everything else in the file — `attachment` lines (the harness's snapshot of its own system
 * prompt, tool-schema and MCP-instruction deltas, skill listings), hook records, cost and queue
 * bookkeeping — is written to the transcript but never re-read into the model's context on resume.
 * Measured 2026-09-21 (ADR 427): 45% of a wake life's file is those lines, so a 284 KiB file is a
 * 47k-token conversation. The ADR 131 §5 hygiene bound is a *cost* crossover on what a resume
 * re-ingests, which is this number, not `stat().size`.
 *
 * Returns `undefined` when the file cannot be read or parsed at all — the caller falls back to the
 * file size, which is the conservative direction (it refuses a resume, never grants one on a guess).
 * A single unparseable line (a truncated tail mid-write) is skipped, not fatal, exactly as in
 * {@link readModelFromTranscript}. `isMeta` records are counted as conversation: they ride the
 * message array on resume even though the harness synthesised them.
 */
export function resumeWeightBytes(path: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let bytes = 0;
  let parsedAny = false;
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    parsedAny = true;
    const type = (parsed as Record<string, unknown>)['type'];
    if (type === 'user' || type === 'assistant') bytes += Buffer.byteLength(line, 'utf8');
  }
  return parsedAny || raw === '' ? bytes : undefined;
}
