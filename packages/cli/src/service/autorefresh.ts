import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  bootoutArgs,
  bootstrapArgs,
  buildAutoRefreshPlist,
  kickstartArgs,
  parseLaunchctlPrint,
  printArgs,
  type LaunchctlStatus,
} from './launchd.js';
import type { RunResult, Runner } from './manage.js';

/**
 * Lifecycle ops for the daemon auto-refresher as a LaunchAgent (`musterd service … --auto`,
 * ADR 118/130 fast-follow) — the `host.ts` shape: a ctx resolved once by the command, every path
 * explicit so tests point it at a temp dir and inject the runner (no real `launchctl`, no writes to
 * `~/Library/LaunchAgents`). Simpler than the `/live` viewer: no worktree, no generated script — the
 * plist runs `node bin.js service refresh --auto --mode <mode>` directly, and that tick subcommand
 * owns all the "is the daemon behind + is it safe to bounce" logic (so it stays unit-testable).
 *
 * The tick *does* bounce the daemon (unlike `--live`/`--wake`), but only when the daemon is behind
 * origin/main; the quiet-period policy (idle-else-notice) lives in the tick, not in the schedule.
 */
export interface AutoRefreshCtx {
  uid: string | number;
  label: string;
  plistPath: string;
  /** Absolute node binary + CLI entry — the same pair the daemon plist embeds. */
  node: string;
  binJs: string;
  /** Args after `service` in the plist — `['refresh', '--auto', '--mode', <mode>]`. */
  refreshArgs: string[];
  workingDir: string;
  logPath: string;
  errLogPath: string;
  /** PATH for the tick's `git`/`pnpm` shellouts; launchd's default is minimal. */
  path: string;
  /** How often the agent runs the tick (seconds). */
  intervalSeconds: number;
  run: Runner;
  sleep?: (ms: number) => void;
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write the auto-refresher plist from the versioned builder. */
export function writeAutoRefreshPlist(ctx: AutoRefreshCtx): void {
  mkdirSync(dirname(ctx.plistPath), { recursive: true });
  mkdirSync(dirname(ctx.logPath), { recursive: true });
  writeFileSync(
    ctx.plistPath,
    buildAutoRefreshPlist({
      label: ctx.label,
      node: ctx.node,
      binJs: ctx.binJs,
      refreshArgs: ctx.refreshArgs,
      workingDir: ctx.workingDir,
      stdoutPath: ctx.logPath,
      stderrPath: ctx.errLogPath,
      path: ctx.path,
      intervalSeconds: ctx.intervalSeconds,
    }),
    'utf8',
  );
}

/** Install (or reinstall) the auto-refresher: write the plist, boot out any old instance, bootstrap —
 *  with the manage.ts retry (bootout returns before teardown settles; an immediate bootstrap of the
 *  same label races it and fails with the vague EIO). */
export function installAutoRefresh(ctx: AutoRefreshCtx): RunResult {
  writeAutoRefreshPlist(ctx);
  const sleep = ctx.sleep ?? blockingSleep;
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
  let boot = ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
  for (let attempt = 0; attempt < 4 && boot.status !== 0; attempt++) {
    sleep(300);
    ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
    boot = ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
  }
  return boot;
}

/** Boot out + remove the plist. Log files stay (they are the record of past refreshes). */
export function uninstallAutoRefresh(ctx: AutoRefreshCtx): { removedPlist: boolean } {
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
  const removed = existsSync(ctx.plistPath);
  if (removed) rmSync(ctx.plistPath, { force: true });
  return { removedPlist: removed };
}

/** Load + start an installed-but-stopped auto-refresher. */
export function startAutoRefresh(ctx: AutoRefreshCtx): RunResult {
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Boot out the auto-refresher without removing the plist. */
export function stopAutoRefresh(ctx: AutoRefreshCtx): RunResult {
  return ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
}

/** Restart / run-now: kickstart when loaded (runs the tick immediately), bootstrap from cold. */
export function refreshAutoRefresh(ctx: AutoRefreshCtx): RunResult {
  const kick = ctx.run('launchctl', kickstartArgs(ctx.uid, ctx.label));
  if (kick.status === 0) return kick;
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Coarse launchd status for the auto-refresher. */
export function statusAutoRefresh(ctx: AutoRefreshCtx): LaunchctlStatus {
  const res = ctx.run('launchctl', printArgs(ctx.uid, ctx.label));
  return parseLaunchctlPrint(res.stdout, res.status === 0);
}
