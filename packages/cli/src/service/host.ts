import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  bootoutArgs,
  bootstrapArgs,
  buildHostPlist,
  kickstartArgs,
  parseLaunchctlPrint,
  printArgs,
  type LaunchctlStatus,
} from './launchd.js';
import type { RunResult, Runner } from './manage.js';

/**
 * Lifecycle ops for the wake actuator as a LaunchAgent (`musterd service … --wake`, ADR 131
 * inc 5) — the `live.ts` shape: a ctx resolved once by the command, every path explicit so tests
 * point it at a temp dir and inject the runner (no real `launchctl`, no writes to
 * `~/Library/LaunchAgents`). Much simpler than the viewer: no worktree, no generated script — the
 * plist runs `node bin.js host [flags]` directly, and `musterd host` already owns registry
 * reloads per tick, so an enrollment change needs no service op at all.
 *
 * Bouncing this agent drops no teammate session (it runs no server); in-flight wake runs keep
 * their own watchdogs (the host awaits them on shutdown, and a killed host's leases expire back
 * to due via the reaper — crash-safe by the ADR 131 §4 lease design).
 */
export interface WakeHostCtx {
  uid: string | number;
  label: string;
  plistPath: string;
  /** Absolute node binary + CLI entry — the same pair the daemon plist embeds. */
  node: string;
  binJs: string;
  /** Flags baked into the plist (`--interval`, `--timeout`, `--host` label override). */
  hostArgs: string[];
  workingDir: string;
  logPath: string;
  errLogPath: string;
  /** PATH for the loop AND the harnesses it spawns; launchd's default is minimal. */
  path: string;
  run: Runner;
  sleep?: (ms: number) => void;
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write the wake-actuator plist from the versioned builder. */
export function writeHostPlist(ctx: WakeHostCtx): void {
  mkdirSync(dirname(ctx.plistPath), { recursive: true });
  mkdirSync(dirname(ctx.logPath), { recursive: true });
  writeFileSync(
    ctx.plistPath,
    buildHostPlist({
      label: ctx.label,
      node: ctx.node,
      binJs: ctx.binJs,
      hostArgs: ctx.hostArgs,
      workingDir: ctx.workingDir,
      stdoutPath: ctx.logPath,
      stderrPath: ctx.errLogPath,
      path: ctx.path,
    }),
    'utf8',
  );
}

/** Install (or reinstall) the actuator: write the plist, boot out any old instance, bootstrap —
 *  with the manage.ts retry (bootout returns before teardown settles; an immediate bootstrap of
 *  the same label races it and fails with the vague EIO). */
export function installWakeHost(ctx: WakeHostCtx): RunResult {
  writeHostPlist(ctx);
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

/** Boot out + remove the plist. Log files stay (they are the record of past wakes). */
export function uninstallWakeHost(ctx: WakeHostCtx): { removedPlist: boolean } {
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
  const removed = existsSync(ctx.plistPath);
  if (removed) rmSync(ctx.plistPath, { force: true });
  return { removedPlist: removed };
}

/** Load + start an installed-but-stopped actuator. */
export function startWakeHost(ctx: WakeHostCtx): RunResult {
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Boot out the actuator without removing the plist. */
export function stopWakeHost(ctx: WakeHostCtx): RunResult {
  return ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
}

/** Restart: kickstart when loaded, bootstrap from cold otherwise (the `refresh --wake` mapping —
 *  the loop re-reads its registry every tick, so a restart is only needed to pick up a new DIST). */
export function restartWakeHost(ctx: WakeHostCtx): RunResult {
  const kick = ctx.run('launchctl', kickstartArgs(ctx.uid, ctx.label));
  if (kick.status === 0) return kick;
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Coarse launchd status for the actuator. */
export function statusWakeHost(ctx: WakeHostCtx): LaunchctlStatus {
  const res = ctx.run('launchctl', printArgs(ctx.uid, ctx.label));
  return parseLaunchctlPrint(res.stdout, res.status === 0);
}
