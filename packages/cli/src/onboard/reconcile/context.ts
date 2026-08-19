import { execFileSync } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { machineConfigRoot } from '../../machinePaths.js';

/**
 * The injected seams the multi-harness reconciler runs on (ADR 282). Every adapter and store
 * consults these — never ambient `process.cwd()`, `homedir()`, or the real clock — so tests can
 * run entire two-machine scenarios in memory and stop-injection can cut the sequence anywhere.
 */

/** Filesystem seam. `readFile` answers `null` for a missing file — never throws for absence. */
export interface FsSeam {
  readFile(path: string): string | null;
  /** Create the directory (and parents). */
  mkdirp(dir: string): void;
  writeFile(path: string, data: string, mode: number): void;
  fsyncFile(path: string): void;
  fsyncDir(dir: string): void;
  rename(from: string, to: string): void;
  rm(path: string): void;
}

/** Process seam — enough identity to distinguish PID reuse (ADR 282 lease reclamation). */
export interface ProcessSeam {
  /** This process's PID. */
  pid: number;
  /** This process's start identity (opaque string; POSIX `ps -o lstart=` in the default seam). */
  startedAt(): string;
  /**
   * Is the process with this recorded identity still alive? `'unknown'` when the platform cannot
   * answer — the caller must treat unknown as busy, never reclaimable.
   */
  liveness(pid: number, processStartedAt: string): boolean | 'unknown';
}

/** Clock seam — epoch milliseconds. */
export interface ClockSeam {
  now(): number;
}

/**
 * The explicit roots and seams a reconcile pass runs against. `worktreeRoot` is the normalized
 * REAL path of the worktree (symlinks resolved) — it doubles as this worktree's ledger owner id.
 * `machineConfigRoot` is derived from the config path, so `MUSTERD_CONFIG` isolates tests and two
 * users on one machine naturally get independent ledgers, journals, and locks.
 */
export interface HarnessContext {
  worktreeRoot: string;
  machineConfigRoot: string;
  env: NodeJS.ProcessEnv;
  fs: FsSeam;
  proc: ProcessSeam;
  clock: ClockSeam;
}

/** The real filesystem seam. */
export const nodeFs: FsSeam = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  mkdirp(dir) {
    mkdirSync(dir, { recursive: true });
  },
  writeFile(path, data, mode) {
    writeFileSync(path, data, { encoding: 'utf8', mode });
  },
  fsyncFile(path) {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  fsyncDir(dir) {
    try {
      const fd = openSync(dir, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Some platforms (notably Windows) refuse directory fds; the rename is still atomic.
    }
  },
  rename(from, to) {
    renameSync(from, to);
  },
  rm(path) {
    rmSync(path, { force: true });
  },
};

/** POSIX process-start identity for a PID, or null when it cannot be read. */
function psStartedAt(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** The real process seam: `process.kill(pid, 0)` liveness plus `ps -o lstart=` start identity. */
export const nodeProc: ProcessSeam = {
  pid: process.pid,
  startedAt() {
    return psStartedAt(process.pid) ?? `pid-${process.pid}@unknown-start`;
  },
  liveness(pid, processStartedAt) {
    let alive: boolean;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      // EPERM: the PID exists but belongs to another user — alive, identity unverifiable.
      if (code === 'EPERM') return 'unknown';
      return 'unknown';
    }
    if (!alive) return false;
    const started = psStartedAt(pid);
    if (started === null) return 'unknown'; // cannot verify identity — never reclaim on a guess
    return started === processStartedAt ? true : false;
  },
};

/** The real clock seam. */
export const nodeClock: ClockSeam = {
  now: () => Date.now(),
};

/**
 * Build the real HarnessContext for a worktree. Resolves the worktree to its normalized REAL path
 * (the ledger owner id) and derives the machine config root from the config path seam.
 */
export function defaultHarnessContext(
  worktreeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): HarnessContext {
  let worktreeRoot: string;
  try {
    worktreeRoot = realpathSync(resolve(worktreeDir));
  } catch {
    worktreeRoot = resolve(worktreeDir);
  }
  return {
    worktreeRoot,
    machineConfigRoot: machineConfigRoot(env),
    env,
    fs: nodeFs,
    proc: nodeProc,
    clock: nodeClock,
  };
}

/** One recorded operation on the in-memory seam, for sequence assertions in tests. */
export type MemoryFsOp =
  | { op: 'mkdirp'; path: string }
  | { op: 'writeFile'; path: string; mode: number }
  | { op: 'fsyncFile'; path: string }
  | { op: 'fsyncDir'; path: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'rm'; path: string };

export interface MemoryFs extends FsSeam {
  /** Every mutating call, in order. Reads are not logged. */
  log: MemoryFsOp[];
  /** The current file map (path → contents), for direct assertions. */
  files: Map<string, string>;
  /** Arrange the next matching op to throw — stop-injection for crash-recovery tests. */
  failNext(match: { op: MemoryFsOp['op']; pathIncludes?: string }): void;
}

/**
 * An in-memory FsSeam that records its op sequence and supports stop-injection. First-class
 * (exported from src, not a test file) because the Task 8 scenario suite drives whole two-machine
 * reconciliations through it.
 */
export function memoryFs(initial?: Record<string, string>): MemoryFs {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  const log: MemoryFsOp[] = [];
  let fail: { op: MemoryFsOp['op']; pathIncludes?: string } | null = null;
  const maybeFail = (entry: MemoryFsOp): void => {
    log.push(entry);
    if (!fail || fail.op !== entry.op) return;
    const path =
      'path' in entry ? entry.path : entry.op === 'rename' ? entry.to : /* istanbul ignore next */ '';
    if (fail.pathIncludes !== undefined && !path.includes(fail.pathIncludes)) return;
    fail = null;
    throw new Error(`injected stop at ${entry.op} ${path}`);
  };
  return {
    log,
    files,
    failNext(match) {
      fail = match;
    },
    readFile(path) {
      return files.get(path) ?? null;
    },
    mkdirp(path) {
      maybeFail({ op: 'mkdirp', path });
    },
    writeFile(path, data, mode) {
      maybeFail({ op: 'writeFile', path, mode });
      files.set(path, data);
    },
    fsyncFile(path) {
      maybeFail({ op: 'fsyncFile', path });
    },
    fsyncDir(path) {
      maybeFail({ op: 'fsyncDir', path });
    },
    rename(from, to) {
      maybeFail({ op: 'rename', from, to });
      const data = files.get(from);
      if (data === undefined) throw new Error(`rename: no such file ${from}`);
      files.delete(from);
      files.set(to, data);
    },
    rm(path) {
      maybeFail({ op: 'rm', path });
      files.delete(path);
    },
  };
}

/** Re-exported here so reconcile modules can compute container directories without node:path soup. */
export function parentDir(path: string): string {
  const d = dirname(path);
  return d === '' ? sep : d;
}
