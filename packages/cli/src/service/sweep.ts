import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  bootoutArgs,
  bootstrapArgs,
  buildSweepPlist,
  kickstartArgs,
  parseLaunchctlPrint,
  printArgs,
  type LaunchctlStatus,
} from './launchd.js';
import type { RunResult, Runner } from './manage.js';

/**
 * Lifecycle ops for the ADR 166 liveness sweep as a LaunchAgent (`musterd service … --sweep`) —
 * the `autorefresh.ts` shape, every path explicit so tests point it at a temp dir and inject the
 * runner (no real `launchctl`, no writes to `~/Library/LaunchAgents`).
 *
 * WHY THIS EXISTS. Increment 2 flipped liveness to enumeration and demoted `binding.session` to
 * resume material. The one error direction that would make the new judgement *worse* than the slot
 * it replaced is `demoted` — enumeration calling a live seat not-live — and ADR 166 sets that
 * target at zero. Nothing scheduled the instrument that measures it, so the guardrail's only
 * observer was a human remembering to type a node command: an instrument that looks like it is
 * working while producing nothing, which the ADR itself names as this family's recurring failure.
 *
 * WHY LOCAL, AND NOT A CLOUD ROUTINE. The research-radar plan deliberately chose a cloud routine
 * over a local agent ("survives the machine being off"). That reasoning does not transfer: this
 * sweep reads `~/.musterd/config.json` bindings and `~/.claude/projects` transcripts, so a cloud
 * routine physically cannot see what it must measure.
 */
export interface SweepCtx {
  uid: string | number;
  label: string;
  plistPath: string;
  /** Absolute node binary — the one the plist embeds. */
  node: string;
  /** Absolute path to the sweep script. */
  scriptPath: string;
  /** Args after the script path — `['--quiet']` keeps a clean run out of the log. */
  scriptArgs: string[];
  workingDir: string;
  logPath: string;
  errLogPath: string;
  path: string;
  /**
   * How often the sweep runs (seconds). Derived, not chosen: a `demoted` case persists for at
   * least `LOCAL_SESSION_LIVE_MS` (10 min) from the last touch of the slot's transcript, so any
   * interval ≤600s cannot miss an instance. The default leaves margin for launchd drift and sleep.
   */
  intervalSeconds: number;
  run: Runner;
  sleep?: (ms: number) => void;
}

/** 5 minutes — half the window a demotion is guaranteed to persist for. */
export const DEFAULT_SWEEP_INTERVAL = 300;

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write the sweep plist from the versioned builder. */
export function writeSweepPlist(ctx: SweepCtx): void {
  mkdirSync(dirname(ctx.plistPath), { recursive: true });
  mkdirSync(dirname(ctx.logPath), { recursive: true });
  writeFileSync(
    ctx.plistPath,
    buildSweepPlist({
      label: ctx.label,
      node: ctx.node,
      scriptPath: ctx.scriptPath,
      scriptArgs: ctx.scriptArgs,
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
export function installSweep(ctx: SweepCtx): RunResult {
  writeSweepPlist(ctx);
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

/** Boot out + remove the plist. The log and the JSONL series stay — they are the measurement. */
export function uninstallSweep(ctx: SweepCtx): { removedPlist: boolean } {
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
  const removed = existsSync(ctx.plistPath);
  if (removed) rmSync(ctx.plistPath, { force: true });
  return { removedPlist: removed };
}

/** Load + start an installed-but-stopped sweep. */
export function startSweep(ctx: SweepCtx): RunResult {
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Boot out without removing the plist. */
export function stopSweep(ctx: SweepCtx): RunResult {
  return ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
}

/** Restart / run-now: kickstart when loaded (sweeps immediately), bootstrap from cold. */
export function refreshSweep(ctx: SweepCtx): RunResult {
  const kick = ctx.run('launchctl', kickstartArgs(ctx.uid, ctx.label));
  if (kick.status === 0) return kick;
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Coarse launchd status for the sweep. */
export function statusSweep(ctx: SweepCtx): LaunchctlStatus {
  const res = ctx.run('launchctl', printArgs(ctx.uid, ctx.label));
  return parseLaunchctlPrint(res.stdout, res.status === 0);
}
