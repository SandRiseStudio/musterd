import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  bootoutArgs,
  bootstrapArgs,
  buildStreamwatchPlist,
  kickstartArgs,
  parseLaunchctlPrint,
  printArgs,
  type LaunchctlStatus,
} from './launchd.js';
import type { RunResult, Runner } from './manage.js';

/**
 * Lifecycle ops for the ADR 293 stream supervisor as a LaunchAgent (`musterd service … --stream`)
 * — the sweep's shape: every path explicit so tests point it at a temp dir and inject the runner.
 *
 * WHY THIS EXISTS. `--rm --restart no` makes machine lifetime = stream lifetime, which is right
 * for billing and deliberate stops — and means a Chrome death (2026-08-18, "Chrome DevTools
 * socket closed") ends the broadcast until a human notices old air. The stream verbs now record
 * intent (streamState.ts); this agent runs the one-pass reconcile (`stream ensure`) that acts on
 * it. Laptop-side, not Fly-side: a Fly restart policy cannot tell the ADR 159 watchdog's
 * deliberate kills from crashes, and the relaunch needs fly + tailscale + the image digest, all
 * of which live here.
 */
export interface StreamwatchCtx {
  uid: string | number;
  label: string;
  plistPath: string;
  /** Absolute node binary — the one the plist embeds. */
  node: string;
  /** Absolute path to the CLI entry (`bin.js`) whose `stream ensure` the agent runs. */
  binJs: string;
  workingDir: string;
  logPath: string;
  errLogPath: string;
  path: string;
  intervalSeconds: number;
  run: Runner;
  sleep?: (ms: number) => void;
}

/** 60s: a crash costs at most a minute of dead air plus the machine boot. One tick is a JSON read
 * plus one `fly machine list` — cheap enough that a tighter loop would buy nothing. */
export const DEFAULT_STREAMWATCH_INTERVAL = 60;

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write the supervisor plist from the versioned builder. */
export function writeStreamwatchPlist(ctx: StreamwatchCtx): void {
  mkdirSync(dirname(ctx.plistPath), { recursive: true });
  mkdirSync(dirname(ctx.logPath), { recursive: true });
  writeFileSync(
    ctx.plistPath,
    buildStreamwatchPlist({
      label: ctx.label,
      node: ctx.node,
      binJs: ctx.binJs,
      workingDir: ctx.workingDir,
      stdoutPath: ctx.logPath,
      stderrPath: ctx.errLogPath,
      path: ctx.path,
      intervalSeconds: ctx.intervalSeconds,
    }),
    'utf8',
  );
}

/** Install (or reinstall): write the plist, boot out any old instance, bootstrap — with the
 *  manage.ts retry (bootout returns before teardown settles and races an immediate bootstrap). */
export function installStreamwatch(ctx: StreamwatchCtx): RunResult {
  writeStreamwatchPlist(ctx);
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

/** Boot out + remove the plist. The desired-state file and the log stay — they are the record. */
export function uninstallStreamwatch(ctx: StreamwatchCtx): { removedPlist: boolean } {
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
  const removed = existsSync(ctx.plistPath);
  if (removed) rmSync(ctx.plistPath, { force: true });
  return { removedPlist: removed };
}

/** Load + start an installed-but-stopped supervisor. */
export function startStreamwatch(ctx: StreamwatchCtx): RunResult {
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Boot out without removing the plist. */
export function stopStreamwatch(ctx: StreamwatchCtx): RunResult {
  return ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
}

/** Restart / run-now: kickstart when loaded (reconciles immediately), bootstrap from cold. */
export function refreshStreamwatch(ctx: StreamwatchCtx): RunResult {
  const kick = ctx.run('launchctl', kickstartArgs(ctx.uid, ctx.label));
  if (kick.status === 0) return kick;
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Coarse launchd status for the supervisor. */
export function statusStreamwatch(ctx: StreamwatchCtx): LaunchctlStatus {
  const res = ctx.run('launchctl', printArgs(ctx.uid, ctx.label));
  return parseLaunchctlPrint(res.stdout, res.status === 0);
}
