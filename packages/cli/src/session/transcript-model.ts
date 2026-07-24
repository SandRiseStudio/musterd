import { openSync, readSync, statSync, closeSync } from 'node:fs';

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
