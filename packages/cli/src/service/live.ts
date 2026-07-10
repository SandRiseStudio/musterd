import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  bootoutArgs,
  bootstrapArgs,
  buildLiveServePlist,
  buildLiveServeScript,
  buildLiveSyncPlist,
  buildLiveSyncScript,
  kickstartArgs,
  parseLaunchctlPrint,
  printArgs,
  type LaunchctlStatus,
} from './launchd.js';
import type { RunResult, Runner } from './manage.js';

/**
 * Everything the `/live` viewer lifecycle ops need, resolved once by the command and passed in
 * (ADR 124). Every path is explicit so tests can point them at a temp dir — no writes to the real
 * `~/Library/LaunchAgents` or `~/.musterd`, no `launchctl`/`git`/`pnpm` actually run.
 *
 * The viewer is a two-agent bundle plus a dedicated worktree; this ctx names all of it. The `sourceRepo`
 * is the daemon's own checkout (which shares the object store) — the worktree is added from it.
 */
export interface LiveCtx {
  uid: string | number;
  serverLabel: string;
  syncLabel: string;
  /** Dedicated detached-on-`origin/main` viewer worktree (a sibling of the daemon checkout). */
  worktree: string;
  /** An existing checkout sharing the git object store, from which the worktree is added. */
  sourceRepo: string;
  serverPlistPath: string;
  syncPlistPath: string;
  serveScriptPath: string;
  syncScriptPath: string;
  serverLogPath: string;
  syncLogPath: string;
  port: number;
  /** Dir holding `node`/`pnpm` (server PATH) — usually `dirname(process.execPath)`. */
  nodeDir: string;
  /** Dir holding `git` (tracker PATH). */
  gitDir: string;
  /** How often the tracker polls `origin/main` (seconds). */
  intervalSeconds: number;
  run: Runner;
  sleep?: (ms: number) => void;
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write the two generated scripts (executable) + the two plists to disk, from the versioned builders. */
export function writeLiveArtifacts(ctx: LiveCtx): void {
  const scriptOpts = {
    worktree: ctx.worktree,
    port: ctx.port,
    nodeDir: ctx.nodeDir,
    gitDir: ctx.gitDir,
    uid: ctx.uid,
    serverLabel: ctx.serverLabel,
  };
  mkdirSync(dirname(ctx.serveScriptPath), { recursive: true });
  writeFileSync(ctx.serveScriptPath, buildLiveServeScript(scriptOpts), { mode: 0o755 });
  writeFileSync(ctx.syncScriptPath, buildLiveSyncScript(scriptOpts), { mode: 0o755 });
  mkdirSync(dirname(ctx.serverPlistPath), { recursive: true });
  writeFileSync(
    ctx.serverPlistPath,
    buildLiveServePlist({
      label: ctx.serverLabel,
      scriptPath: ctx.serveScriptPath,
      workingDir: ctx.worktree,
      stdoutPath: ctx.serverLogPath,
      stderrPath: ctx.serverLogPath,
    }),
    'utf8',
  );
  writeFileSync(
    ctx.syncPlistPath,
    buildLiveSyncPlist({
      label: ctx.syncLabel,
      scriptPath: ctx.syncScriptPath,
      workingDir: ctx.worktree,
      stdoutPath: ctx.syncLogPath,
      stderrPath: ctx.syncLogPath,
      intervalSeconds: ctx.intervalSeconds,
    }),
    'utf8',
  );
}

/**
 * Ensure the dedicated viewer worktree exists, parked at detached `origin/main`. Idempotent: if the
 * directory is already a worktree we leave it (the tracker/server keep it current); otherwise we
 * `git worktree add --detach`. Returns the result so the command can surface a add failure.
 */
export function ensureWorktree(ctx: LiveCtx): { created: boolean; result?: RunResult } {
  if (existsSync(`${ctx.worktree}/.git`)) return { created: false };
  // Fetch first so origin/main is a valid start point even on a fresh clone.
  ctx.run('git', ['-C', ctx.sourceRepo, 'fetch', 'origin', 'main', '--quiet']);
  const result = ctx.run('git', [
    '-C',
    ctx.sourceRepo,
    'worktree',
    'add',
    '--detach',
    ctx.worktree,
    'origin/main',
  ]);
  return { created: result.status === 0, result };
}

function bootstrapWithRetry(ctx: LiveCtx, label: string, plistPath: string): RunResult {
  const sleep = ctx.sleep ?? blockingSleep;
  ctx.run('launchctl', bootoutArgs(ctx.uid, label));
  let boot = ctx.run('launchctl', bootstrapArgs(ctx.uid, plistPath));
  for (let attempt = 0; attempt < 4 && boot.status !== 0; attempt++) {
    sleep(300);
    ctx.run('launchctl', bootoutArgs(ctx.uid, label));
    boot = ctx.run('launchctl', bootstrapArgs(ctx.uid, plistPath));
  }
  return boot;
}

/**
 * Install the viewer: ensure the worktree, write the generated scripts + plists, then bootstrap both
 * agents (server first, then tracker). Idempotent — re-running re-generates the artifacts (adopting the
 * current node/git/port) and reloads. Returns each agent's bootstrap result for the command to report.
 */
export function installLive(ctx: LiveCtx): {
  worktree: { created: boolean; result?: RunResult };
  server: RunResult;
  sync: RunResult;
} {
  const worktree = ensureWorktree(ctx);
  writeLiveArtifacts(ctx);
  const server = bootstrapWithRetry(ctx, ctx.serverLabel, ctx.serverPlistPath);
  const sync = bootstrapWithRetry(ctx, ctx.syncLabel, ctx.syncPlistPath);
  return { worktree, server, sync };
}

/** Stop + remove both agents and the generated scripts/plists. Leaves the worktree in place (a
 * checkout with node_modules is expensive to recreate; `--purge` removes it). */
export function uninstallLive(ctx: LiveCtx, purgeWorktree = false): { removedPlists: number } {
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.syncLabel));
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.serverLabel));
  let removedPlists = 0;
  for (const p of [
    ctx.serverPlistPath,
    ctx.syncPlistPath,
    ctx.serveScriptPath,
    ctx.syncScriptPath,
  ]) {
    if (existsSync(p)) {
      rmSync(p, { force: true });
      if (p.endsWith('.plist')) removedPlists++;
    }
  }
  if (purgeWorktree && existsSync(ctx.worktree)) {
    ctx.run('git', ['-C', ctx.sourceRepo, 'worktree', 'remove', '--force', ctx.worktree]);
  }
  return { removedPlists };
}

/** Bootstrap both agents (load + start an installed-but-stopped viewer). */
export function startLive(ctx: LiveCtx): { server: RunResult; sync: RunResult } {
  return {
    server: ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.serverPlistPath)),
    sync: ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.syncPlistPath)),
  };
}

/** Bootout both agents without removing artifacts. */
export function stopLive(ctx: LiveCtx): { server: RunResult; sync: RunResult } {
  return {
    server: ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.serverLabel)),
    sync: ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.syncLabel)),
  };
}

/**
 * `refresh --live` — force the viewer onto the tip of main *now* instead of waiting for the tracker's
 * next poll: `kickstart -k` the server (its script re-syncs + rebuilds on restart). Falls back to
 * `bootstrap` if the server isn't loaded, so `refresh` also works from cold.
 */
export function refreshLive(ctx: LiveCtx): RunResult {
  const kick = ctx.run('launchctl', kickstartArgs(ctx.uid, ctx.serverLabel));
  if (kick.status === 0) return kick;
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.serverPlistPath));
}

/** Coarse launchd status for both viewer agents. */
export function statusLive(ctx: LiveCtx): { server: LaunchctlStatus; sync: LaunchctlStatus } {
  const one = (label: string): LaunchctlStatus => {
    const res = ctx.run('launchctl', printArgs(ctx.uid, label));
    return parseLaunchctlPrint(res.stdout, res.status === 0);
  };
  return { server: one(ctx.serverLabel), sync: one(ctx.syncLabel) };
}
