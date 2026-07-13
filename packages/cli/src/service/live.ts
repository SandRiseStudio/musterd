import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  bootoutArgs,
  bootstrapArgs,
  buildLiveBuildPlist,
  buildLiveBuildScript,
  kickstartArgs,
  parseLaunchctlPrint,
  printArgs,
  type LaunchctlStatus,
} from './launchd.js';
import type { RunResult, Runner } from './manage.js';

/**
 * Everything the `/live` viewer lifecycle ops need, resolved once by the command and passed in
 * (ADR 132). Every path is explicit so tests can point them at a temp dir — no writes to the real
 * `~/Library/LaunchAgents` or `~/.musterd`, no `launchctl`/`git`/`pnpm` actually run.
 *
 * The viewer is now a *single* build-publisher agent plus a dedicated worktree; this ctx names all of it.
 * The `sourceRepo` is the daemon's own checkout (which shares the object store) — the worktree is added
 * from it. `webRoot` is the daemon's static-serve root (ADR 062): the builder publishes the bundle there,
 * the daemon serves it. The `legacy*` fields are the retired ADR 124 dev-server bundle, cleaned up on
 * install/uninstall so an in-place upgrade leaves nothing dangling.
 */
export interface LiveCtx {
  uid: string | number;
  /** The single build-publisher agent's label (reuses `studio.sandrise.musterd-live`). */
  buildLabel: string;
  /** Retired ADR 124 main-tracker label — booted out on install/uninstall. */
  legacySyncLabel: string;
  /** Dedicated detached-on-`origin/main` viewer worktree (a sibling of the daemon checkout). */
  worktree: string;
  /** An existing checkout sharing the git object store, from which the worktree is added. */
  sourceRepo: string;
  /** The daemon's web-root — publish target for the built bundle (what the daemon serves). */
  webRoot: string;
  buildPlistPath: string;
  buildScriptPath: string;
  buildLogPath: string;
  /** Retired ADR 124 artifacts (dev-server plist/script + the tracker's), removed on uninstall/upgrade. */
  legacySyncPlistPath: string;
  legacyServeScriptPath: string;
  legacySyncScriptPath: string;
  /** Dir holding `node`/`pnpm` (build PATH) — usually `dirname(process.execPath)`. */
  nodeDir: string;
  /** Dir holding `git`. */
  gitDir: string;
  /** How often the builder polls `origin/main` (seconds). */
  intervalSeconds: number;
  run: Runner;
  sleep?: (ms: number) => void;
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write the generated build-publisher script (executable) + its plist to disk, from the versioned
 * builders. */
export function writeLiveArtifacts(ctx: LiveCtx): void {
  mkdirSync(dirname(ctx.buildScriptPath), { recursive: true });
  writeFileSync(
    ctx.buildScriptPath,
    buildLiveBuildScript({
      worktree: ctx.worktree,
      webRoot: ctx.webRoot,
      nodeDir: ctx.nodeDir,
      gitDir: ctx.gitDir,
    }),
    { mode: 0o755 },
  );
  mkdirSync(dirname(ctx.buildPlistPath), { recursive: true });
  writeFileSync(
    ctx.buildPlistPath,
    buildLiveBuildPlist({
      label: ctx.buildLabel,
      scriptPath: ctx.buildScriptPath,
      workingDir: ctx.worktree,
      stdoutPath: ctx.buildLogPath,
      stderrPath: ctx.buildLogPath,
      intervalSeconds: ctx.intervalSeconds,
    }),
    'utf8',
  );
}

/**
 * Ensure the dedicated viewer worktree exists, parked at detached `origin/main`. Idempotent: if the
 * directory is already a worktree we leave it (the builder keeps it current); otherwise we
 * `git worktree add --detach`. Returns the result so the command can surface an add failure.
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

/** Boot out + remove the retired ADR 124 dev-server bundle (the `musterd-live-sync` tracker, and the old
 * `serve.sh`/`sync.sh` scripts + the sync plist). The `musterd-live` label itself is *reused* by the new
 * build-publisher, so `bootstrapWithRetry` boots out its old KeepAlive instance before loading the new
 * one — this just clears the second agent and the stale files. Idempotent (no-ops when already gone). */
function cleanupLegacy(ctx: LiveCtx): void {
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.legacySyncLabel));
  for (const p of [ctx.legacySyncPlistPath, ctx.legacyServeScriptPath, ctx.legacySyncScriptPath]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

/**
 * Install the viewer: retire any ADR 124 dev-server bundle, ensure the worktree, write the generated
 * script + plist, then bootstrap the single build-publisher (which builds + publishes on load, then on
 * its interval). Idempotent — re-running re-generates the artifacts and reloads. Returns the worktree +
 * bootstrap result for the command to report.
 */
export function installLive(ctx: LiveCtx): {
  worktree: { created: boolean; result?: RunResult };
  build: RunResult;
} {
  cleanupLegacy(ctx);
  const worktree = ensureWorktree(ctx);
  writeLiveArtifacts(ctx);
  const build = bootstrapWithRetry(ctx, ctx.buildLabel, ctx.buildPlistPath);
  return { worktree, build };
}

/** Stop + remove the build-publisher and any retired ADR 124 artifacts, and clear the published bundle so
 * the daemon cleanly 404s the UI. Leaves the worktree in place (a checkout with node_modules is expensive
 * to recreate; `--purge` removes it). */
export function uninstallLive(ctx: LiveCtx, purgeWorktree = false): { removedPlists: number } {
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.buildLabel));
  cleanupLegacy(ctx);
  let removedPlists = 0;
  for (const p of [ctx.buildPlistPath, ctx.buildScriptPath]) {
    if (existsSync(p)) {
      rmSync(p, { force: true });
      if (p.endsWith('.plist')) removedPlists++;
    }
  }
  if (existsSync(ctx.webRoot)) rmSync(ctx.webRoot, { force: true, recursive: true });
  if (purgeWorktree && existsSync(ctx.worktree)) {
    ctx.run('git', ['-C', ctx.sourceRepo, 'worktree', 'remove', '--force', ctx.worktree]);
  }
  return { removedPlists };
}

/** Bootstrap the build-publisher (load + start an installed-but-stopped viewer). */
export function startLive(ctx: LiveCtx): { build: RunResult } {
  return { build: ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.buildPlistPath)) };
}

/** Boot out the build-publisher without removing artifacts. */
export function stopLive(ctx: LiveCtx): { build: RunResult } {
  return { build: ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.buildLabel)) };
}

/**
 * `refresh --live` — force a build + publish *now* instead of waiting for the builder's next poll:
 * `kickstart -k` the agent (its script re-syncs, rebuilds, and publishes on start). Falls back to
 * `bootstrap` if it isn't loaded, so `refresh` also works from cold.
 */
export function refreshLive(ctx: LiveCtx): RunResult {
  const kick = ctx.run('launchctl', kickstartArgs(ctx.uid, ctx.buildLabel));
  if (kick.status === 0) return kick;
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.buildPlistPath));
}

/** Coarse launchd status for the build-publisher agent. */
export function statusLive(ctx: LiveCtx): { build: LaunchctlStatus } {
  const res = ctx.run('launchctl', printArgs(ctx.uid, ctx.buildLabel));
  return { build: parseLaunchctlPrint(res.stdout, res.status === 0) };
}
