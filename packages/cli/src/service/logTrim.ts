import { appendFileSync, copyFileSync, existsSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Size-capped retention for the service logs under `~/.musterd` (ADR 224).
 *
 * Every musterd LaunchAgent writes to a `StandardOutPath` and nothing ever trims it. Measured
 * 2026-08-04 on the dogfood machine: `daemon.log` 34 MB, `otel-sink.log` 10.6 MB, `live/build.log`
 * 4.6 MB — ~50 MB of append-only history with no upper bound. Not a disk problem; a *forensic*
 * one. These logs are the only record of what the unattended agents did, and an unbounded file is
 * one that eventually gets `rm`'d by hand at exactly the wrong moment.
 *
 * **Copy-truncate, not rename.** The obvious rotation — rename the file and let a new one appear —
 * does not work here: the writing process holds an fd to the *inode*, so after a rename the daemon
 * keeps writing to `daemon.log.1` forever and the fresh `daemon.log` stays empty. So: copy the
 * over-cap file to `<name>.1`, then truncate the original to zero in place.
 *
 * **Truncating a live log is safe here, and that was measured, not assumed.** launchd opens
 * `StandardOutPath` with `O_APPEND`, so a write after truncation lands at offset 0 rather than at
 * the writer's stale offset. Verified 2026-08-04 with a throwaway LaunchAgent: truncate a file it
 * was appending to once per second, and four seconds later the file was exactly 64 bytes — four
 * clean lines, no sparse hole, no NUL padding. Without `O_APPEND` the same trim would have left a
 * multi-megabyte hole and made the problem worse than doing nothing.
 *
 * The bound is therefore two generations: at most `cap` live plus `cap` in `.1`.
 */

/** Default cap per log file. Two generations → ~16 MB worst case for the largest log. */
export const DEFAULT_LOG_CAP_BYTES = 8 * 1024 * 1024;

/** Env override, in whole megabytes (`MUSTERD_LOG_CAP_MB=32`). `0` disables trimming entirely. */
export function logCapBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['MUSTERD_LOG_CAP_MB'];
  if (raw === undefined) return DEFAULT_LOG_CAP_BYTES;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return DEFAULT_LOG_CAP_BYTES;
  return Math.floor(mb * 1024 * 1024);
}

export interface TrimmedLog {
  /** Absolute path of the log that was trimmed. */
  path: string;
  /** Bytes it held before the trim (now preserved in `<path>.1`). */
  before: number;
}

/**
 * Trim one log if it exceeds `cap`. Returns null when it was under the cap (the common case — this
 * runs on every auto-refresh tick and must cost one `stat` when there is nothing to do).
 */
export function trimLog(path: string, cap: number, now: Date = new Date()): TrimmedLog | null {
  if (cap <= 0) return null;
  let before: number;
  try {
    before = statSync(path).size;
  } catch {
    return null; // vanished between listing and stat — nothing to do
  }
  if (before <= cap) return null;
  try {
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    // Say why the file just went empty, in the file itself. A log that silently loses its history
    // is indistinguishable from one that was never written to — and this whole lane exists because
    // an unexplained log is a log nobody can reason from. The append lands at offset 0 (see above).
    appendFileSync(
      path,
      `${now.toISOString()} — trimmed by musterd: ${mb(before)} exceeded the ${mb(cap)} cap; ` +
        `the previous contents are in ${path}.1 (ADR 224)\n`,
    );
    return { path, before };
  } catch {
    return null; // best-effort: log hygiene must never break the tick that runs it
  }
}

/**
 * The logs musterd's own LaunchAgents write, relative to the musterd home. An explicit list, NOT a
 * `*.log` walk: `dirname(configPath())` is the real `~/.musterd` in production but a *shared temp
 * directory* under the ADR 162/190 test isolation, and a recursive glob there would truncate
 * whatever unrelated `.log` files another process happened to leave in `/var/folders/…/T`. Trimming
 * only names we ourselves write keeps the blast radius to exactly musterd's own output; a new
 * LaunchAgent adds its log here, beside the plist builder that creates it.
 */
export const SERVICE_LOGS = [
  'daemon.log',
  'daemon.err.log',
  'serve.log',
  'devdaemon.log',
  'host.log',
  'host.err.log',
  'broadcast.log',
  'otel-sink.log',
  'otel-sink.stdout.log',
  'otel-sink.err.log',
  'autorefresh/refresh.log',
  'live/build.log',
  'live/viewer.log',
  'live/sync.log',
  'research/sweep.log',
] as const;

/**
 * Trim each of {@link SERVICE_LOGS} under `dir` that exceeds `cap`. The rotated `.1` files are not
 * in the list and so are never themselves rotated — that is what bounds retention at two
 * generations rather than an ever-growing `.1.1.1` chain.
 */
export function trimServiceLogs(
  dir: string,
  cap: number = logCapBytes(),
  now: Date = new Date(),
): TrimmedLog[] {
  if (cap <= 0 || !existsSync(dir)) return [];
  const out: TrimmedLog[] = [];
  for (const rel of SERVICE_LOGS) {
    const hit = trimLog(join(dir, rel), cap, now);
    if (hit) out.push(hit);
  }
  return out;
}

/** Human-readable size for the marker line and the tick's report. */
export function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
