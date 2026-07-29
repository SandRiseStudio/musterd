import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Resolving a runnable `claude` binary, shared by harness detection (`init`/`doctor`) and the wake
 * actuator (`musterd host`, ADR 131 increment 3). Extracted from `onboard/harnesses/claudeCode.ts`
 * because the host has the *worse* PATH problem: a LaunchAgent-managed resident loop inherits
 * launchd's minimal PATH (no nvm/homebrew/npm-global shims, no `~/.claude/local`), so "claude is on
 * PATH" is exactly the assumption a wake must not make.
 */

/** Can `cmd` run? Returns stdout on success (used by detection to read versions). */
export async function hasRunnable(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8000 });
    return { ok: true, out: stdout };
    // reason: exec rejection is an untyped error-like with optional stdout/message.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    return { ok: false, out: String(err?.stdout ?? err?.message ?? '') };
  }
}

/**
 * Where the `claude` CLI commonly lives. `execFile` resolves against the *launching process's*
 * PATH only, so a venv/conda/non-login shell — or launchd — can hide an installed CLI ("not
 * installed" while the Claude Code extension runs fine, a dogfood finding). Falling back to these
 * absolute paths makes detection and actuation PATH-robust.
 */
export function claudeCandidates(): string[] {
  const home = homedir();
  return [
    join(home, '.npmglobal/bin/claude'),
    join(home, '.npm-global/bin/claude'),
    join(home, '.claude/local/claude'),
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

let claudeBinCache: string | null | undefined;

/**
 * Drop the memoised answer so the next {@link resolveClaudeBin} searches again.
 *
 * The cache is per *process*, which is harmless for a one-shot CLI and wrong for `musterd host` — a
 * KeepAlive resident loop that lives for days. A path resolved at boot outlives the CLI it pointed
 * at: a `claude` upgrade that moves the install leaves the host spawning a path that no longer
 * exists, and since a spawn failure burns a wake attempt, three of them exhaust the act terminally.
 * Measured on the dogfood machine (lane `01KYQ913P5`): **8 of 14 recorded wake failures were ENOENT
 * on a stale cached path** — `~/.npmglobal/bin/claude` (4) and `~/.local/bin/claude` (3), plus one
 * outright "not found". No wake has ever failed on an expired grant.
 */
export function invalidateClaudeBinCache(): void {
  claudeBinCache = undefined;
}

/** Resolve a runnable `claude`: PATH first, then known install locations. Cached per process —
 *  call {@link invalidateClaudeBinCache} when a spawn proves the cached answer stale. */
export async function resolveClaudeBin(): Promise<string | null> {
  if (claudeBinCache !== undefined) return claudeBinCache;
  if ((await hasRunnable('claude', ['--version'])).ok) return (claudeBinCache = 'claude');
  for (const c of claudeCandidates()) {
    if (existsSync(c) && (await hasRunnable(c, ['--version'])).ok) return (claudeBinCache = c);
  }
  return (claudeBinCache = null);
}
