import { execFileSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { basename, sep } from 'node:path';

/**
 * The host guard's backstop for an attended session (ADR 444). The transcript guard (ADR 131 §5)
 * reads a session as live only while its transcript is being written, so an open session whose
 * person has stepped away reads as idle — and once the daemon stops seeing its presence, a wake is
 * leased and spawned beside it (dolly, 2026-09-22: 25 minutes). An attended session is a harness
 * process that is running in the workspace and is not a headless run. A wake child is always
 * headless (`claude -p …`), so it never counts.
 *
 * Read-only and best-effort. `undefined` is "cannot tell" and must never be read as "no session".
 */

/** One harness process, as the process table reports it. */
export interface HarnessProcess {
  pid: number;
  /** The executable name (`ps -o comm`). */
  comm: string;
  /** The full command line (`ps -o args`). */
  args: string;
  /** The process's working directory, when it could be read. */
  cwd?: string;
}

/** Lists harness processes, or `undefined` when the process table cannot be read. */
export type ProcessLister = () => HarnessProcess[] | undefined;

/** How to recognise a harness's interactive session: its executable, and its headless flags. */
interface ProcessSignature {
  comm: string;
  headless: readonly string[];
}

/** Only harnesses with a known signature are judged; the rest return "cannot tell". */
const SIGNATURES: Readonly<Record<string, ProcessSignature>> = {
  'claude-code': { comm: 'claude', headless: ['-p', '--print'] },
};

const EXEC_TIMEOUT_MS = 2_000;

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function readCwd(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

/** The real process table: every process whose executable is a known harness binary. */
export function listHarnessProcesses(): HarnessProcess[] | undefined {
  const comms = new Set(Object.values(SIGNATURES).map((s) => s.comm));
  let table: string;
  try {
    table = execFileSync('ps', ['-axo', 'pid=,comm='], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
  const found: HarnessProcess[] = [];
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const comm = basename(m[2]!.trim());
    if (!comms.has(comm)) continue;
    const pid = Number(m[1]);
    let args = comm;
    try {
      args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      continue; // exited between the two reads
    }
    const cwd = readCwd(pid);
    found.push({ pid, comm, args, ...(cwd !== undefined ? { cwd } : {}) });
  }
  return found;
}

/**
 * An attended `harness` session open in `workspace` (or a directory under it): its pid, `null` when
 * there is none, or `undefined` when this cannot be told — an unknown harness, or an unreadable
 * process table.
 */
export function attendedHarnessProcess(
  workspace: string,
  harness: string | undefined,
  list: ProcessLister = listHarnessProcesses,
): { pid: number } | null | undefined {
  const signature = SIGNATURES[harness ?? 'claude-code'];
  if (!signature) return undefined;
  const procs = list();
  if (procs === undefined) return undefined;
  const root = canonical(workspace);
  const hit = procs.find((p) => {
    if (basename(p.comm) !== signature.comm || p.cwd === undefined) return false;
    const tokens = p.args.split(/\s+/);
    if (signature.headless.some((flag) => tokens.includes(flag))) return false;
    const cwd = canonical(p.cwd);
    return cwd === root || cwd.startsWith(root + sep);
  });
  return hit ? { pid: hit.pid } : null;
}
