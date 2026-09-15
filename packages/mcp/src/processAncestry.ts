import { execFileSync } from 'node:child_process';

/**
 * The parent pid of `pid`, from `ps` — the one portable way Node has to read another process's
 * parent (it exposes only its own `process.ppid`). Undefined when the process is gone or `ps`
 * cannot say; never throws, because this runs on the adapter's mount path.
 */
export function readParentPid(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    const ppid = Number.parseInt(out, 10);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This process's ancestors, nearest first, bounded (ADR 354 amendment 2026-09-02).
 *
 * Why more than `process.ppid`: the wake-lease file names the pid the actuator SPAWNED, and on this
 * machine that is not the harness. `codex` resolves to `@openai/codex/bin/codex.js` — a Node script
 * that `spawn`s the native binary — so the actuator's child is the wrapper and the MCP server's
 * parent is the native codex one generation below it. The live falsifier for #1187 refused the
 * file on exactly that hop (lease `01M1HXRG…`, 2026-09-02 13:43). A bounded walk covers a wrapper,
 * a sandbox shim, or both, and still excludes a human session in the same workspace: that tree
 * shares no ancestor with the actuator's child.
 *
 * `maxHops` is small on purpose. Every hop is one `ps`; the walk runs only when a wake-lease file
 * actually exists and parses, so the common case (no file) pays nothing.
 */
export function processAncestry(
  startPid: number = process.ppid,
  maxHops = 6,
  readPpid: (pid: number) => number | undefined = readParentPid,
): number[] {
  const out: number[] = [];
  let pid: number | undefined = startPid;
  for (let i = 0; i < maxHops && pid !== undefined && pid > 1; i++) {
    out.push(pid);
    pid = readPpid(pid);
  }
  return out;
}
