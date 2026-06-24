import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  bootoutArgs,
  bootstrapArgs,
  buildPlist,
  kickstartArgs,
  parseLaunchctlPrint,
  printArgs,
  type LaunchctlStatus,
} from './launchd.js';

/** The result of one `launchctl` invocation, captured so callers never throw on a non-zero exit. */
export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** A `launchctl` runner, injected so the orchestration is testable without shelling out. */
export type Runner = (cmd: string, args: string[]) => RunResult;

/**
 * Everything the lifecycle ops need, resolved once by the command and passed in. Paths are explicit
 * (not derived inside) so tests can point them at a temp dir — no writes to the real
 * `~/Library/LaunchAgents`.
 */
export interface ServiceCtx {
  uid: string | number;
  label: string;
  plistPath: string;
  node: string;
  binJs: string;
  serveArgs: string[];
  workingDir: string;
  stdoutPath: string;
  stderrPath: string;
  path: string;
  run: Runner;
  /** Blocking sleep between bootstrap retries; injected so tests don't actually wait. */
  sleep?: (ms: number) => void;
}

/** A synchronous sleep (one-shot CLI; no event loop to block) for the bootstrap retry. */
function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function plist(ctx: ServiceCtx): string {
  return buildPlist({
    label: ctx.label,
    node: ctx.node,
    binJs: ctx.binJs,
    serveArgs: ctx.serveArgs,
    workingDir: ctx.workingDir,
    stdoutPath: ctx.stdoutPath,
    stderrPath: ctx.stderrPath,
    path: ctx.path,
  });
}

/**
 * Install (or re-install) the LaunchAgent: write the plist, `bootout` any prior copy (ignored if it
 * wasn't loaded), then `bootstrap` to load + start it. Idempotent — re-running adopts the current
 * node/bin paths, so it cleanly supersedes a hand-installed plist with the same label.
 */
export function install(ctx: ServiceCtx): { ok: boolean; bootstrap: RunResult } {
  mkdirSync(dirname(ctx.plistPath), { recursive: true });
  writeFileSync(ctx.plistPath, plist(ctx), 'utf8');
  // Best-effort unload of any prior registration; a "not loaded" error here is expected and ignored.
  ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
  // `bootout` returns before launchd has fully torn the old job down, so an immediate `bootstrap` of
  // the same label races it and fails with the vague EIO (error 5: "Input/output error"). Retry a few
  // times, re-clearing first, to let teardown settle — makes re-install over a running agent reliable.
  const sleep = ctx.sleep ?? blockingSleep;
  let bootstrap = ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
  for (let attempt = 0; attempt < 4 && bootstrap.status !== 0; attempt++) {
    sleep(300);
    ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
    bootstrap = ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
  }
  return { ok: bootstrap.status === 0, bootstrap };
}

/** Stop + remove: `bootout` (so KeepAlive can't relaunch), then delete the plist. */
export function uninstall(ctx: ServiceCtx): { removed: boolean; bootout: RunResult } {
  const bootout = ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
  const removed = existsSync(ctx.plistPath);
  if (removed) rmSync(ctx.plistPath, { force: true });
  return { removed, bootout };
}

/** Load + start an installed-but-stopped agent (`bootstrap`). */
export function start(ctx: ServiceCtx): RunResult {
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Stop without removing the plist (`bootout`) — `start` reloads it later. */
export function stop(ctx: ServiceCtx): RunResult {
  return ctx.run('launchctl', bootoutArgs(ctx.uid, ctx.label));
}

/**
 * Restart in place (`kickstart -k`). If the agent isn't loaded yet, fall back to `bootstrap` so
 * `restart` works as a "make it run" even from a cold state.
 */
export function restart(ctx: ServiceCtx): RunResult {
  const kick = ctx.run('launchctl', kickstartArgs(ctx.uid, ctx.label));
  if (kick.status === 0) return kick;
  return ctx.run('launchctl', bootstrapArgs(ctx.uid, ctx.plistPath));
}

/** Coarse launchd status (loaded? pid? state?) from `launchctl print`. */
export function status(ctx: ServiceCtx): LaunchctlStatus {
  const res = ctx.run('launchctl', printArgs(ctx.uid, ctx.label));
  return parseLaunchctlPrint(res.stdout, res.status === 0);
}

/** The last `lines` of a log file, or `[]` if it doesn't exist yet. */
export function tailFile(path: string, lines: number): string[] {
  if (!existsSync(path)) return [];
  const all = readFileSync(path, 'utf8').split('\n');
  // Drop a trailing empty element from a final newline so we don't render a blank last line.
  if (all.length && all[all.length - 1] === '') all.pop();
  return all.slice(-lines);
}
