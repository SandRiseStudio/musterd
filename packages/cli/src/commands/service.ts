import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { flagStr, type Parsed } from '../args.js';
import { configPath, loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { loadHostRegistry } from '../host/registry.js';
import { osNotify } from '../notify/os.js';
import { theme } from '../render/theme.js';
import { MIN_NODE_MAJOR } from '../runtime.js';
import {
  installAutoRefresh,
  refreshAutoRefresh,
  startAutoRefresh,
  statusAutoRefresh,
  stopAutoRefresh,
  uninstallAutoRefresh,
  type AutoRefreshCtx,
} from '../service/autorefresh.js';
import {
  installWakeHost,
  restartWakeHost,
  startWakeHost,
  statusWakeHost,
  stopWakeHost,
  uninstallWakeHost,
  type WakeHostCtx,
} from '../service/host.js';
import {
  AUTOREFRESH_LABEL,
  HOST_LABEL,
  kickstartArgs,
  LIVE_LABEL,
  LIVE_SYNC_LABEL,
  SWEEP_LABEL,
  agentFailureNote,
  parsePlistEnvironment,
  parsePlistProgramArguments,
  SERVICE_LABEL,
  serviceSupported,
  stableNodePath,
} from '../service/launchd.js';
import {
  installLive,
  refreshLive,
  startLive,
  statusLive,
  stopLive,
  uninstallLive,
  type LiveCtx,
} from '../service/live.js';
import {
  install,
  restart,
  start,
  status,
  stop,
  tailFile,
  uninstall,
  type RunResult,
  type Runner,
  type ServiceCtx,
} from '../service/manage.js';
import {
  DEFAULT_SWEEP_INTERVAL,
  installSweep,
  refreshSweep,
  startSweep,
  statusSweep,
  stopSweep,
  uninstallSweep,
  type SweepCtx,
} from '../service/sweep.js';

/** Shell out to `launchctl` synchronously, capturing output and never throwing on a non-zero exit. */
const spawnRunner: Runner = (cmd, args): RunResult => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * The node an agent's plist should name. `process.execPath` under Homebrew carries the exact version,
 * which stops resolving the moment the formula upgrades — see `stableNodePath` for the outage that
 * taught us. Every plist this CLI writes goes through here.
 */
function agentNode(): string {
  return stableNodePath(process.execPath, (p) => realpathSync(p));
}

/**
 * Whether the program an installed plist names still exists on disk. `undefined` when the plist can't
 * be read at all (nothing to say). This is the direct form of the failure `agentFailureNote` reports:
 * a Homebrew upgrade retires the versioned node path and every plist still naming it goes unloadable.
 */
function agentProgramExists(plistPath: string): boolean | undefined {
  let xml: string;
  try {
    xml = readFileSync(plistPath, 'utf8');
  } catch {
    return undefined;
  }
  const program = parsePlistProgramArguments(xml)?.[0];
  if (!program) return undefined;
  return existsSync(program);
}

/** Where the LaunchAgent plist lives (user domain — no root). */
function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

/**
 * Resolve everything the lifecycle ops need from the *running* process: `process.execPath` is the
 * exact node to embed (self-correcting — whatever launched the CLI), and `argv[1]` is this CLI's
 * entry. The musterd home (`~/.musterd`, where the db already lives) holds the daemon logs.
 *
 * Exported so `musterd reload` can resolve the same service identity to find the daemon's pid.
 */
export function resolveCtx(serveArgs: string[]): ServiceCtx {
  const node = agentNode();
  const binJs = resolvePath(process.argv[1] ?? '');
  // repo root: …/packages/cli/dist/bin.js → up four. Best-effort; cwd doesn't affect the db (homedir).
  const workingDir = resolvePath(binJs, '../../../..');
  const home = dirname(configPath()); // ~/.musterd (or MUSTERD_CONFIG's dir)
  const nodeDir = dirname(node);
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : '',
    label: SERVICE_LABEL,
    plistPath: plistPath(),
    node,
    binJs,
    serveArgs,
    workingDir,
    stdoutPath: join(home, 'daemon.log'),
    stderrPath: join(home, 'daemon.err.log'),
    path: [nodeDir, '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    run: spawnRunner,
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

const USAGE =
  'usage: musterd service <install|uninstall|start|stop|restart|refresh|status|logs> [--live | --wake | --auto | --sweep] [--port <n>] [--host <h>] [--allowed-hosts <a,b>] [--interval <s>] [--timeout <s>] [--mode <idle|notice>] [--follow] [--force]';

/** The daemon's static-serve root (ADR 062/132): the service-owned dir the `--live` build-publisher
 * publishes the built bundle into, and the daemon serves `/live` from. Under `~/.musterd/live/web`. */
export function liveWebRoot(): string {
  return join(dirname(configPath()), 'live', 'web');
}

/**
 * Resolve the `/live` viewer service (ADR 132) from the running process. The viewer worktree is a
 * sibling of the daemon's own checkout (`…/agents` → `…/agents-live`), added from it since they share
 * the git object store. The generated build script + log live under `~/.musterd/live/`; the plist sits
 * beside the daemon's in `~/Library/LaunchAgents`. `gitDir` is resolved so the build's PATH finds git.
 * The `legacy*` fields name the retired ADR 124 dev-server bundle so an in-place upgrade cleans it up.
 */
/**
 * Resolve the wake-actuator service (ADR 131 inc 5) from the running process: the plist runs
 * `node bin.js host [flags]` with the daemon's node/entry pair. `--interval`/`--timeout` (bare
 * seconds, `musterd host`'s own contract) are baked into the plist at install — operator facts,
 * like the daemon's `--port`; the per-seat policy knobs arrive per wake order and need no service
 * op. The label deliberately reads `--wake`, not `--host`: `--host <h>` is the daemon's bind flag.
 */
function resolveWakeCtx(run: Runner, parsed: Parsed): WakeHostCtx {
  const binJs = resolvePath(process.argv[1] ?? '');
  const home = dirname(configPath()); // ~/.musterd
  const hostArgs: string[] = [];
  const interval = flagStr(parsed.flags, 'interval');
  const timeout = flagStr(parsed.flags, 'timeout');
  if (interval) hostArgs.push('--interval', interval);
  if (timeout) hostArgs.push('--timeout', timeout);
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : '',
    label: HOST_LABEL,
    plistPath: join(homedir(), 'Library', 'LaunchAgents', `${HOST_LABEL}.plist`),
    node: agentNode(),
    binJs,
    hostArgs,
    workingDir: resolvePath(binJs, '../../../..'),
    logPath: join(home, 'host.log'),
    errLogPath: join(home, 'host.err.log'),
    // The loop loads the CLI's native modules AND spawns harnesses (claude, git, node tooling) —
    // both need more PATH than launchd's default.
    path: [
      dirname(process.execPath),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':'),
    run,
  };
}

/** The auto-refresher's mode knob: how it treats a behind-daemon that still has live sessions. */
export type AutoRefreshMode = 'idle' | 'notice';
const DEFAULT_AUTOREFRESH_MODE: AutoRefreshMode = 'notice';
const DEFAULT_AUTOREFRESH_INTERVAL = 120;

function parseAutoRefreshMode(parsed: Parsed): AutoRefreshMode {
  const m = flagStr(parsed.flags, 'mode');
  if (m === undefined) return DEFAULT_AUTOREFRESH_MODE;
  if (m === 'idle' || m === 'notice') return m;
  throw new CliError(`--mode must be 'idle' or 'notice' (got '${m}')`, 2);
}

/** Where the auto-refresher records the last origin/main tip it *attempted* to refresh onto, so a
 *  build that fails against a given tip isn't re-attempted every interval (the debounce mirrors the
 *  /live publisher's `.published-sha`). Cleared once the daemon actually reaches that tip. */
function autoRefreshStampPath(): string {
  return join(dirname(configPath()), 'autorefresh', '.attempted-sha');
}

/**
 * Resolve the ADR 166 liveness sweep from the running process. The plist runs the research script
 * out of the CHECKOUT this CLI was launched from — deliberately the daemon's own checkout on a
 * dogfood machine, because the auto-refresher already keeps that one built and the sweep imports
 * `packages/cli/dist`: running anywhere else would measure with an artifact production is not
 * using. `--interval` (bare seconds) is baked at install, like the other interval agents.
 */
function resolveSweepCtx(run: Runner, parsed: Parsed): SweepCtx {
  const binJs = resolvePath(process.argv[1] ?? '');
  const home = dirname(configPath()); // ~/.musterd
  const checkout = resolvePath(binJs, '../../../..');
  const interval = flagStr(parsed.flags, 'interval');
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : '',
    label: SWEEP_LABEL,
    plistPath: join(homedir(), 'Library', 'LaunchAgents', `${SWEEP_LABEL}.plist`),
    node: agentNode(),
    scriptPath: join(checkout, 'scripts', 'research', 'adr-166-slot-sweep.ts'),
    // Clean runs stay silent so the log holds findings only; a demoted case always speaks.
    scriptArgs: ['--quiet'],
    workingDir: checkout,
    logPath: join(home, 'research', 'sweep.log'),
    errLogPath: join(home, 'research', 'sweep.log'),
    // The sweep shells out to nothing — node alone is enough, plus the usual dirs for safety.
    path: [dirname(process.execPath), '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
    intervalSeconds: interval ? Number(interval) : DEFAULT_SWEEP_INTERVAL,
    run,
  };
}

/**
 * Resolve the auto-refresher service (ADR 118/130 fast-follow) from the running process: the plist
 * runs `node bin.js service refresh --auto --mode <mode>` on an interval. Same node/entry pair the
 * daemon embeds. `--interval` (bare seconds, default 120) and `--mode` are baked at install — like
 * the wake actuator's cadence. The label reads `--auto`, not `--refresh` (that's the daemon verb).
 * PATH must carry `git` + `pnpm` (the tick shells the rebuild) on top of node.
 */
function resolveAutoRefreshCtx(run: Runner, parsed: Parsed): AutoRefreshCtx {
  const binJs = resolvePath(process.argv[1] ?? '');
  const home = dirname(configPath()); // ~/.musterd
  const mode = parseAutoRefreshMode(parsed);
  const interval = flagStr(parsed.flags, 'interval');
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : '',
    label: AUTOREFRESH_LABEL,
    plistPath: join(homedir(), 'Library', 'LaunchAgents', `${AUTOREFRESH_LABEL}.plist`),
    node: agentNode(),
    binJs,
    refreshArgs: ['refresh', '--auto', '--mode', mode],
    workingDir: resolvePath(binJs, '../../../..'),
    logPath: join(home, 'autorefresh', 'refresh.log'),
    errLogPath: join(home, 'autorefresh', 'refresh.log'),
    // The tick shells `git` and `pnpm --dir <checkout> build`; pnpm may live in ~/Library/pnpm.
    path: [
      dirname(process.execPath),
      '/opt/homebrew/bin',
      join(homedir(), 'Library', 'pnpm'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':'),
    intervalSeconds: interval ? Number(interval) : DEFAULT_AUTOREFRESH_INTERVAL,
    run,
  };
}

/** Exported for tests: the Cellar-trap regression (see below) needs a direct probe. */
export function resolveLiveCtx(ctx: ServiceCtx): LiveCtx {
  const run = ctx.run;
  const binJs = resolvePath(process.argv[1] ?? '');
  // The worktree hangs off the checkout the DAEMON runs from (read back from its installed plist,
  // like `service refresh` — issue #289), not off wherever this CLI binary happens to live: invoked
  // via the Homebrew shim, `argv[1]` resolves into the Cellar and `install --live` would plant the
  // worktree at …/Cellar/musterd/<v>/libexec/lib/node_modules-live — which dies on the next
  // `brew upgrade` (observed 2026-07-24). Fall back to the invoked checkout only when no installed
  // daemon plist resolves.
  const repoRoot = daemonCheckout(ctx) ?? resolvePath(binJs, '../../../..');
  const home = dirname(configPath()); // ~/.musterd
  const liveDir = join(home, 'live');
  const agents = join(homedir(), 'Library', 'LaunchAgents');
  const whichGit = run('which', ['git']).stdout.trim();
  const gitDir = whichGit ? dirname(whichGit) : '/opt/homebrew/bin';
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : '',
    buildLabel: LIVE_LABEL,
    legacySyncLabel: LIVE_SYNC_LABEL,
    worktree: `${repoRoot}-live`,
    sourceRepo: repoRoot,
    webRoot: liveWebRoot(),
    buildPlistPath: join(agents, `${LIVE_LABEL}.plist`),
    buildScriptPath: join(liveDir, 'build.sh'),
    buildLogPath: join(liveDir, 'build.log'),
    legacySyncPlistPath: join(agents, `${LIVE_SYNC_LABEL}.plist`),
    legacyServeScriptPath: join(liveDir, 'serve.sh'),
    legacySyncScriptPath: join(liveDir, 'sync.sh'),
    nodeDir: dirname(process.execPath),
    gitDir,
    intervalSeconds: 60,
    run,
  };
}

/** The daemon's `/health` shape as this command reads it (ADR 016 + 047 + 130). */
export interface DaemonHealth {
  connections?: number;
  v?: string;
  db?: string;
  schema?: number;
  /** The commit the daemon booted from (ADR 130) — absent when not running from a git checkout. */
  build?: string;
}

/** Fetch the daemon's `/health` (ADR 016 + 047): the live `connections` count drives the guard below. */
async function fetchHealth(): Promise<DaemonHealth> {
  const server = loadConfig().server;
  const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return (await res.json()) as DaemonHealth;
}

/**
 * The daemon env for this install: whatever the installed plist already carries, with
 * `--allowed-hosts` applied on top when passed.
 *
 * THE PRESERVATION RULE IS THE POINT. `install` rewrites the plist from scratch every time, so
 * without reading the old one back, a routine `musterd service install` months later would silently
 * drop an allow-list somebody set once — and the failure it causes (a WS upgrade 403 that surfaces
 * only as "the page never reported ready") points nowhere near the cause. Read-back also means this
 * adopts the hand-edited value already on the real machine instead of clobbering it.
 *
 * PATH is excluded: it is regenerated from the running process on every install and must not be
 * pinned to whatever an older install happened to compute.
 */
export function resolveDaemonEnv(
  existingPlist: string | null,
  allowedHosts: string | undefined,
): Record<string, string> {
  const prior = existingPlist ? parsePlistEnvironment(existingPlist) : null;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(prior ?? {})) if (k !== 'PATH') env[k] = v;
  if (allowedHosts !== undefined) {
    // Normalise: split on commas, trim, drop empties. `--allowed-hosts ''` clears the list, which is
    // the only way to undo one without editing the plist by hand.
    const hosts = allowedHosts
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h !== '');
    if (hosts.length > 0) env['MUSTERD_ALLOWED_HOSTS'] = hosts.join(',');
    else delete env['MUSTERD_ALLOWED_HOSTS'];
  }
  return env;
}

/** Sleep between `/health` polls. Async (unlike the launchctl retry's blocking sleep) — we are
 *  already in an async command and awaiting a fetch. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait for the daemon to answer `/health` after a bounce, or give up.
 *
 * WHY THIS EXISTS. Every restart path used to report success off the **launchctl** exit code, which
 * says only "launchd accepted the command" — not "the daemon is serving". On 2026-07-27 a
 * hand-rolled `bootout` + `bootstrap` silently did not take and left the daemon down ~2 minutes with
 * the whole team offline and no error surfaced anywhere. A ✓ that cannot distinguish a running
 * daemon from a dead one is worse than no ✓, because it stops the operator looking.
 *
 * Returns the health payload, or null if it never came back within the budget. Never throws — the
 * caller decides how loud to be, since `install` and `refresh` want different repair text.
 */
export async function awaitDaemon(
  health: () => Promise<DaemonHealth>,
  opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DaemonHealth | null> {
  const tries = opts.tries ?? 20;
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? delay;
  for (let i = 0; i < tries; i++) {
    try {
      return await health();
    } catch {
      // Not up yet (connection refused, or /health not serving) — launchd boots asynchronously,
      // so the first poll failing is normal, not a verdict.
    }
    if (i < tries - 1) await sleep(delayMs);
  }
  return null;
}

/**
 * Confirm the daemon came back after a bounce, or fail with the exact command that restores it.
 * `what` names the operation for the message ("install", "restart", "refresh").
 *
 * Deliberately a hard failure rather than a warning: the operator is standing right there, and the
 * whole team is offline until someone acts. The restore incantation is spelled out because the one
 * time this happened, recovering it took reading a plist path out of a source file.
 */
async function verifyDaemonUp(
  ctx: ServiceCtx,
  health: () => Promise<DaemonHealth>,
  what: string,
  ok: (s: string) => void,
  sleep?: (ms: number) => Promise<void>,
): Promise<DaemonHealth | null> {
  // BASELINE FIRST — this is what makes the check honest. `/health` being unreachable can mean the
  // daemon is down, or merely that this CLI cannot see it (a daemon bound off-loopback, a `server`
  // pointing elsewhere — the very overlay case this lane is about). Only a daemon that answered
  // BEFORE the bounce and not after is evidence of an outage. Without a baseline we say so and warn,
  // rather than hard-failing a working system: the pre-existing "fail open when health is
  // unreachable" contract stays intact exactly where it was meant to apply.
  const wasUp = await health().then(
    () => true,
    () => false,
  );
  // The long budget buys a booting daemon time before we accuse it of being down. With no baseline
  // we can only ever warn, so a long wait buys nothing but latency on every no-daemon install.
  const up = await awaitDaemon(health, {
    ...(sleep ? { sleep } : {}),
    ...(wasUp ? {} : { tries: 4 }),
  });
  if (!up && !wasUp) {
    process.stdout.write(
      `  ${theme.warn('?')} ${theme.meta(
        `could not confirm the daemon after ${what} — /health was unreachable before it too, ` +
          `so this may be a daemon this CLI cannot see rather than one that is down. ` +
          `Check with \`musterd service status\`.`,
      )}\n`,
    );
    return null;
  }
  if (!up) {
    throw new CliError(
      `${what} reported success but the daemon stopped answering /health — it was up before this ` +
        `bounce and is not now, so it is DOWN and every seat on this machine is offline until it ` +
        `is back.\n\n` +
        `  launchctl bootstrap gui/${String(ctx.uid)} ${ctx.plistPath}\n\n` +
        `Then check ${ctx.stderrPath} for why it failed to boot. ` +
        `(launchd accepting the command is not the same as the daemon serving — that gap is what ` +
        `this check exists to close.)`,
      1,
    );
  }
  ok(`daemon answered /health${up.build ? ` on ${up.build.slice(0, 7)}` : ''}`);
  return up;
}

/**
 * How many commits `origin/main` is ahead of the daemon's running `build` — the numeric core of the
 * skew check, shared by `service status` (the human warning) and `service refresh --auto` (the
 * decision to bounce). Fetches `origin/main` first (best-effort). Returns null when there's no verdict
 * to give: the daemon isn't running from a checkout, the commit is unknown locally, or `origin/main`
 * is unresolved — callers treat null as "leave it alone" (watcher, never gatekeeper).
 */
export function countBehind(build: string, dir: string, run: Runner): number | null {
  // A stamped build can carry a `-dirty` suffix (ADR 135) — strip it before any git plumbing:
  // `rev-list abc-dirty..` fails, which would silently degrade the verdict for exactly the builds
  // most likely to be skewed.
  const sha = build.replace(/-dirty$/, '');
  const git = (...args: string[]): RunResult => run('git', ['-C', dir, ...args]);
  if (git('rev-parse', '--is-inside-work-tree').status !== 0) return null;
  git('fetch', 'origin', 'main', '--quiet'); // best-effort — offline still compares the last-known tip
  const counted = git('rev-list', '--count', `${sha}..origin/main`);
  if (counted.status !== 0) return null; // unknown commit / no origin/main — no verdict
  const behind = Number(counted.stdout.trim());
  return Number.isFinite(behind) ? behind : null;
}

/**
 * Who owns the skew: is an auto-refresher watching this daemon, and has it already tried and failed?
 *
 * Three states, because each asks a different thing of the reader:
 * - `off` — nothing is watching; the manual verb is genuinely the answer.
 * - `watching` — a loaded auto-refresher will pick the skew up on its own interval. Skew here is
 *   benign, transient drift and must NOT read as a chore (the ADR 148 lesson: a chip that cries wolf
 *   on drift the machine already handles gets ignored, and then it can't warn about anything).
 * - `stalled` — the auto-refresher already ATTEMPTED this exact tip and the daemon still is not on
 *   it. The tick marks the attempt *before* building (the debounce), so this covers two cases: a
 *   build in flight right now, and a build that failed and will never be retried until a new commit
 *   lands. We cannot tell them apart from here and do not pretend to — but the failed case has to be
 *   surfaced, because it is invisible everywhere else: the daemon answers /health cheerfully from
 *   the previous build. A successful tick clears the marker, so a healthy settled machine never
 *   reaches this branch (and a settled machine is not behind at all).
 */
type SkewOwner = 'off' | 'watching' | 'stalled';

export function autoRefreshOwnership(dir: string, run: Runner, loaded: boolean): SkewOwner {
  if (!loaded) return 'off';
  // The debounce stamp names the tip the tick last *attempted*. If it already equals origin/main
  // while the daemon is still behind, the attempt failed — the tick is not going to try again.
  try {
    const attempted = readFileSync(autoRefreshStampPath(), 'utf8').trim();
    if (!attempted) return 'watching';
    const tip = run('git', ['-C', dir, 'rev-parse', 'origin/main']);
    if (tip.status !== 0) return 'watching'; // no verdict — assume the watcher is fine (never alarm on ignorance)
    return attempted === tip.stdout.trim() ? 'stalled' : 'watching';
  } catch {
    return 'watching'; // no stamp yet: it has not attempted anything to fail at
  }
}

/**
 * Name the running daemon's build skew against `origin/main` (ADR 130) — the detector half of
 * `service refresh`. Best-effort by design: the daemon may not run from a checkout, the fetch may be
 * offline, the commit may be unknown locally — every failure degrades to just naming the build ref.
 * `status` must never fail because of this check (watcher, never gatekeeper).
 *
 * It also must not tell the reader to do the auto-refresher's job. The unconditional "run `musterd
 * service refresh`" this used to emit was read by every agent on a dogfood machine where the
 * auto-refresher is installed — so musterd was instructing its own team to bypass its own infra, and
 * no amount of documentation beats a live string (nick, 2026-07-31). `ownership` is injected so the
 * launchd probe stays out of this pure formatter and its tests.
 */
export function buildSkewNote(
  build: string,
  dir: string,
  run: Runner,
  ownership: SkewOwner = 'off',
): string {
  const short = build.slice(0, 7) + (build.endsWith('-dirty') ? '-dirty' : '');
  const behind = countBehind(build, dir, run);
  if (behind === null) return short;
  if (behind === 0) return `${short} ${theme.meta('· up to date with origin/main')}`;
  const commits = `${behind} commit${behind === 1 ? '' : 's'} behind origin/main`;
  if (ownership === 'watching') {
    // Calm on purpose: no command, no ⚠. The machine owns this one.
    return `${short} ${theme.meta(`· ${commits} — the auto-refresher will pick this up`)}`;
  }
  if (ownership === 'stalled') {
    // Deliberately not naming a directory: `dir` is whatever checkout this CLI was invoked from,
    // which on a seat's worktree is NOT the daemon's — naming it would print a confident, wrong
    // repair path. The log names the checkout the tick actually syncs.
    return (
      `${short} · ` +
      theme.warn(
        `⚠ ${commits} — the auto-refresher already attempted this tip; either its build is still ` +
          `running or it failed, in which case the daemon is pinned on old code until a new commit ` +
          `lands. Check ~/.musterd/autorefresh/refresh.log — a merge that changed pnpm-lock.yaml ` +
          `needs \`pnpm install\` in the daemon's checkout, which the tick never runs.`,
      )
    );
  }
  return `${short} · ` + theme.warn(`⚠ ${commits} — run \`musterd service refresh\``);
}

/**
 * Refuse to write a plist whose embedded node can't actually run the daemon.
 *
 * `install` embeds `process.execPath` — whatever node ran this CLI (ADR 045, "self-correcting"). If that
 * node's ABI doesn't match the daemon's compiled native module (`better-sqlite3`), the daemon crashloops
 * on boot with a `NODE_MODULE_VERSION` mismatch **while `install` cheerfully reports success** — and the
 * daemon goes dark. That is exactly how the dogfood daemon was taken down (2026-07-12): `install` run from
 * a Node 20 shell against a Node 22 build. `refresh`/`start`/`restart` are unaffected — they reuse the
 * existing plist and never re-embed a node — so this guards the one verb that can do it.
 *
 * Deliberately conservative: it reports a mismatch **only** when the loader says `NODE_MODULE_VERSION`.
 * Any other probe failure (packaged install, module not resolvable, no checkout) returns null and the
 * install proceeds untouched — so this can never block an install it doesn't understand.
 */
export function nodeAbiMismatch(ctx: ServiceCtx): string | null {
  const from = join(ctx.workingDir, 'packages', 'server');
  // NB: we must *construct a Database*, not merely `require` the module. better-sqlite3 binds its native
  // addon lazily on first use, so a bare `require` exits 0 even under a mismatched node — a probe that
  // would have sailed straight past the very outage this guards (verified against the real checkout).
  const probe = ctx.run(ctx.node, [
    '-e',
    `const D=require(require.resolve('better-sqlite3',{paths:[${JSON.stringify(from)}]}));new D(':memory:').close();`,
  ]);
  if (probe.status === 0) return null;
  const err = `${probe.stderr ?? ''}\n${probe.stdout ?? ''}`;
  if (!err.includes('NODE_MODULE_VERSION')) return null; // not an ABI problem — don't get in the way
  // The loader names both ABIs ("compiled against … 127 … requires … 115"); say it in one plain line.
  const abis = [...err.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((m) => m[1]);
  if (abis.length >= 2) {
    return `the daemon's better-sqlite3 is built for NODE_MODULE_VERSION ${abis[0]}, but this node provides ${abis[1]}.`;
  }
  return (
    err
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('NODE_MODULE_VERSION')) ?? err.trim()
  );
}

/**
 * Guard the destructive `service` verbs (ADR 047): refuse to bounce a *shared* daemon while other
 * members hold live sessions, so a restart is a conscious choice, not a silent teammate-drop.
 * Fail-open — if `/health` is unreachable the daemon's already down and can't be disrupting anyone,
 * so let the verb through. `--force` is the universal override.
 */
async function guardLiveSessions(
  health: () => Promise<DaemonHealth>,
  force: boolean,
): Promise<void> {
  if (force) return;
  let connections: number;
  try {
    connections = (await health()).connections ?? 0;
  } catch {
    return; // daemon unreachable — nothing to disrupt
  }
  if (connections <= 0) return;
  const plural = connections === 1 ? '' : 's';
  const it = connections === 1 ? 'it' : 'them';
  throw new CliError(
    `${connections} live session${plural} ${connections === 1 ? 'is' : 'are'} connected to this daemon — restart will drop ${it}.\n` +
      `  Give the team a heads-up (musterd send --to @team --act status_update "bouncing the daemon, ~5s"),\n` +
      `  then re-run with --force.`,
    1,
  );
}

/**
 * `musterd service <sub>` — manage the daemon as a macOS LaunchAgent (ADR 045) so it survives a closed
 * terminal/session, restarts on crash, and starts at login — without raw `launchctl`. The CLI manages
 * **musterd's own daemon's** lifecycle (a human-side concern, like `notify`), NOT member agents: the
 * core principle "musterd connects agents, it does not run them" is intact. macOS only for now;
 * systemd/Windows are the named seam (`serviceSupported`).
 */
export async function serviceCommand(
  parsed: Parsed,
  deps: {
    platform?: NodeJS.Platform;
    ctx?: ServiceCtx;
    liveCtx?: LiveCtx;
    wakeCtx?: WakeHostCtx;
    autoRefreshCtx?: AutoRefreshCtx;
    sweepCtx?: SweepCtx;
    health?: () => Promise<DaemonHealth>;
    /** Probe whether the daemon serves /live (injected so tests skip the network). */
    probeViewer?: (url: string) => Promise<boolean>;
    /** Fire an OS notice (injected so the `--auto --mode notice` tick is testable). */
    notify?: (n: { id: string; title: string; body: string }) => void;
    /** The attempted-tip debounce store (injected in tests; defaults to a file under ~/.musterd). */
    autoState?: { read: () => string | null; write: (sha: string) => void };
    /** Sleep between post-bounce `/health` polls (injected so tests never actually wait). */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const sub = parsed.positionals[0];
  if (!sub) throw new CliError(USAGE, 2);

  const platform = deps.platform ?? osPlatform();
  if (!serviceSupported(platform)) {
    throw new CliError(
      `musterd service is macOS-only for now (this is ${platform}). ` +
        `On Linux run \`musterd serve\` under systemd --user; Windows support is planned. ` +
        `See ADR 045.`,
      2,
    );
  }

  const serveArgs = ['serve'];
  const port = flagStr(parsed.flags, 'port');
  const host = flagStr(parsed.flags, 'host');
  if (port) serveArgs.push('--port', port);
  if (host) serveArgs.push('--host', host);
  // ADR 132: the daemon serves /live from its own origin — point it at the service-owned web-root the
  // `--live` build-publisher publishes into. Inert until populated (serveStatic 404s the UI; API is
  // unaffected — ADR 062), so this is safe on every daemon, viewer installed or not.
  serveArgs.push('--web-root', liveWebRoot());
  const ctx0 = deps.ctx ?? resolveCtx(serveArgs);
  // Carry the daemon env on the ctx so `install`'s plist write picks it up. Resolved for every verb
  // (cheap, one file read) so `status` can report the effective allow-list too.
  const ctx: ServiceCtx = {
    ...ctx0,
    env: resolveDaemonEnv(
      ctx0.readFile?.(ctx0.plistPath) ?? null,
      flagStr(parsed.flags, 'allowed-hosts'),
    ),
  };
  const health = deps.health ?? fetchHealth;
  const force = parsed.flags['force'] === true;

  const ok = (s: string) => process.stdout.write(`${theme.ok('✓')} ${s}\n`);
  const fail = (step: string, r: RunResult): never => {
    throw new CliError(
      `${step} failed (launchctl exit ${r.status})${r.stderr ? `: ${r.stderr.trim()}` : ''}`,
      1,
    );
  };

  // `--live` retargets every verb at the /live build-publisher (ADR 132) instead of the daemon. It runs
  // no server and drops no teammate session, so its ops skip the shared-daemon live-session guard.
  if (parsed.flags['live'] === true) {
    const liveCtx = deps.liveCtx ?? resolveLiveCtx(ctx);
    return liveServiceCommand(sub, liveCtx, parsed, ok, fail, deps.probeViewer ?? probeViewer);
  }

  // `--wake` retargets every verb at the wake actuator (`musterd host` as a LaunchAgent, ADR 131
  // inc 5). Same posture as `--live`: no server, no teammate session dropped, no live-session
  // guard — in-flight wake runs keep their own watchdogs and an interrupted lease expires back to
  // due. The abi guard DOES apply on install: `musterd host` loads the CLI's native modules.
  if (parsed.flags['wake'] === true) {
    const wakeCtx = deps.wakeCtx ?? resolveWakeCtx(ctx.run, parsed);
    return wakeServiceCommand(sub, ctx, wakeCtx, parsed, ok, fail, force);
  }

  // `--auto` targets the auto-refresher (ADR 118/130 fast-follow). `refresh --auto` runs one tick
  // (the actual work: check skew → apply the quiet-period policy → bounce if behind); every other
  // verb manages the interval LaunchAgent that runs that tick, exactly like `--live`/`--wake`.
  if (parsed.flags['auto'] === true) {
    if (sub === 'refresh') {
      const mode = parseAutoRefreshMode(parsed);
      const notify = deps.notify ?? osNotify;
      const autoState = deps.autoState ?? fileAutoState();
      return autoRefreshTick(ctx, health, mode, notify, autoState, ok, fail);
    }
    const arCtx = deps.autoRefreshCtx ?? resolveAutoRefreshCtx(ctx.run, parsed);
    return autoRefreshServiceCommand(sub, arCtx, parsed, ok, fail);
  }

  // `--sweep` targets the ADR 166 liveness sweep. Same posture as `--live`/`--auto`: read-only, no
  // server, no teammate session dropped, so no live-session guard and no ABI guard (it loads the
  // CLI's JS, not its native modules).
  if (parsed.flags['sweep'] === true) {
    const sweepCtx = deps.sweepCtx ?? resolveSweepCtx(ctx.run, parsed);
    return sweepServiceCommand(sub, sweepCtx, parsed, ok, fail);
  }

  switch (sub) {
    case 'install': {
      // The plist is about to embed *this* node. If it can't load the daemon's native modules, installing
      // would silently crashloop the daemon — refuse, and say how to fix it. `--force` overrides.
      const abi = force ? null : nodeAbiMismatch(ctx);
      if (abi) {
        throw new CliError(
          `refusing to install: ${ctx.node} cannot load the daemon's native modules, so the daemon ` +
            `would crashloop on boot (and this command would still report success).\n\n` +
            `  ${abi}\n\n` +
            `The plist embeds the node that runs this CLI, and you are on ${process.version} — this repo ` +
            `needs Node >=${MIN_NODE_MAJOR}. Put a matching node first on PATH and re-run, e.g.\n` +
            `  export PATH="/opt/homebrew/opt/node@${MIN_NODE_MAJOR}/bin:$PATH" && musterd service install\n\n` +
            `(\`musterd service refresh\` is safe — it never rewrites the plist. \`--force\` overrides.)`,
          1,
        );
      }
      const res = install(ctx);
      if (!res.ok) fail('install (bootstrap)', res.bootstrap);
      ctx.run('launchctl', ['kickstart', '-k', `gui/${ctx.uid}/${ctx.label}`]);
      ok(`installed + started the musterd daemon (LaunchAgent ${theme.accent(ctx.label)})`);
      process.stdout.write(theme.meta(`  plist: ${ctx.plistPath}`) + '\n');
      process.stdout.write(theme.meta(`  node:  ${ctx.node}`) + '\n');
      process.stdout.write(theme.meta(`  serve: ${ctx.binJs} ${ctx.serveArgs.join(' ')}`) + '\n');
      if (ctx.env?.['MUSTERD_ALLOWED_HOSTS'])
        process.stdout.write(
          theme.meta(`  hosts: ${ctx.env['MUSTERD_ALLOWED_HOSTS']} (ADR 040 allow-list)`) + '\n',
        );
      process.stdout.write(theme.meta(`  logs:  ${ctx.stdoutPath}`) + '\n');
      await verifyDaemonUp(ctx, health, 'install', ok, deps.sleep);
      return 0;
    }
    case 'uninstall': {
      const res = uninstall(ctx);
      ok(
        res.removed
          ? `stopped + removed the musterd daemon (${ctx.label})`
          : `musterd daemon was not installed — nothing to remove`,
      );
      return 0;
    }
    case 'start': {
      const r = start(ctx);
      if (r.status !== 0) fail('start (bootstrap)', r);
      ok('started the musterd daemon');
      return 0;
    }
    case 'stop': {
      await guardLiveSessions(health, force);
      const r = stop(ctx);
      // bootout returns non-zero when it wasn't loaded — that's already-stopped, not an error.
      ok(r.status === 0 ? 'stopped the musterd daemon' : 'musterd daemon was not running');
      return 0;
    }
    case 'restart': {
      await guardLiveSessions(health, force);
      const r = restart(ctx);
      if (r.status !== 0) fail('restart', r);
      ok('restarted the musterd daemon');
      await verifyDaemonUp(ctx, health, 'restart', ok, deps.sleep);
      return 0;
    }
    case 'refresh':
      return refreshDaemon(ctx, health, force, ok, fail, deps.sleep);
    case 'status':
      return renderStatus(ctx, health);
    case 'logs': {
      const follow = parsed.flags['follow'] === true || parsed.positionals.includes('-f');
      return logs(ctx, follow);
    }
    default:
      throw new CliError(USAGE, 2);
  }
}

/**
 * `musterd service refresh` — the one-command "run latest main" for the daemon (ADR 118). The daemon
 * serves *built* dist, and a long-lived Node process can't hot-swap its code, so picking up merged
 * work is a three-step dance (sync main → `pnpm build` → restart) that also has to be run in the
 * daemon's own checkout, not a worktree. This folds it into one guarded verb:
 *
 *   1. **Guard** the shared daemon exactly like `restart` (refuse with live sessions unless `--force`).
 *   2. **Sync** the daemon's checkout to `origin/main` — detached, so the checkout can't drift onto a
 *      stale feature branch (the exact snag that stranded a rebuild this week). Refuses on uncommitted
 *      changes rather than clobber them.
 *   3. **Build** dist; a failed build aborts *before* the restart, so the daemon never bounces onto
 *      broken code.
 *   4. **Restart** onto the fresh build.
 *
 * All shelling-out goes through `ctx.run` (the injected runner), so it's unit-testable without a repo.
 */
/**
 * The checkout the installed daemon runs from, read back from its plist's `ProgramArguments`
 * (`[node, binJs, 'serve', …]`) — the repo root is four levels up from `…/packages/cli/dist/bin.js`,
 * the same derivation `resolveCtx` uses for the running CLI. Null when no plist is installed or it
 * doesn't parse, so the caller falls back to the invoked CLI's checkout.
 */
function daemonCheckout(ctx: ServiceCtx): string | null {
  const xml = ctx.readFile?.(ctx.plistPath);
  if (!xml) return null;
  const args = parsePlistProgramArguments(xml);
  const binJs = args?.[1];
  if (!binJs) return null;
  return resolvePath(binJs, '../../../..');
}

/**
 * Bounce the other long-lived agents that run from the same checkout the daemon does.
 *
 * `refreshDaemon` rebuilds the **whole** checkout with `pnpm --dir <dir> build`, but then restarts
 * only its own label — so every other KeepAlive process started from that same `dist` keeps running
 * the code it booted with, indefinitely. The wake actuator has always had this problem: the fix was
 * documented as "run `musterd service restart --wake` by hand", which is a currency policy that
 * depends on somebody remembering.
 *
 * Only agents that are (a) installed and (b) resolve to *this* checkout are touched, so a plist
 * pointing at some other clone is left alone. The auto-refresher is deliberately not in the list: it
 * is a `StartInterval` tick that exits, so every firing already runs the newest code. Neither is the
 * `/live` publisher, which lives in its own worktree and re-syncs on its own poll.
 */
function bounceSiblings(ctx: ServiceCtx, dir: string, ok: (s: string) => void): void {
  const siblings: Array<{ label: string; what: string }> = [
    { label: HOST_LABEL, what: 'wake actuator' },
  ];
  for (const { label, what } of siblings) {
    // Beside the daemon's own plist — derived, not `homedir()`, so a test can point the whole set at
    // a temp dir the way every other lifecycle op here is injected.
    const path = join(dirname(ctx.plistPath), `${label}.plist`);
    const xml = ctx.readFile?.(path);
    if (!xml) continue; // not installed
    const binJs = parsePlistProgramArguments(xml)?.[1];
    if (!binJs || resolvePath(binJs, '../../../..') !== dir) continue; // some other checkout
    const r = ctx.run('launchctl', kickstartArgs(ctx.uid, label));
    // Advisory: a sibling that won't bounce must not fail the daemon refresh that already succeeded.
    ok(
      r.status === 0
        ? `restarted the ${what}`
        : theme.meta(`could not restart the ${what} — run \`musterd service restart --wake\``),
    );
  }
}

/**
 * Whether `<dir>/node_modules` matches `<dir>/pnpm-lock.yaml`. The evidence is pnpm's own
 * installed-state record: every successful install writes the lockfile it installed to
 * `node_modules/.pnpm/lock.yaml` (verified byte-identical to the project lockfile on the healthy
 * daemon checkout, 2026-08-01). Missing copy or any difference → the checkout needs an install,
 * whatever hop history led here. A checkout with no `pnpm-lock.yaml` at all is not a pnpm workspace
 * this check can judge — leave it alone. Unreadable-but-present states fall toward `true`, which
 * costs one idempotent install rather than a pinned daemon: the failure modes are asymmetric.
 */
function needsInstall(dir: string): boolean {
  let want: Buffer;
  try {
    want = readFileSync(join(dir, 'pnpm-lock.yaml'));
  } catch {
    return false; // no lockfile → nothing to be consistent with
  }
  try {
    return !want.equals(readFileSync(join(dir, 'node_modules', '.pnpm', 'lock.yaml')));
  } catch {
    return true; // lockfile exists but no installed-state record → never installed (or wiped)
  }
}

async function refreshDaemon(
  ctx: ServiceCtx,
  health: () => Promise<DaemonHealth>,
  force: boolean,
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
  sleep?: (ms: number) => Promise<void>,
): Promise<number> {
  // The checkout the daemon ACTUALLY runs from — read back from its installed plist, not derived
  // from where this CLI was invoked. `restart` already cycles the daemon by launchd label, but the
  // sync+build must target the daemon's own checkout: run `refresh` from a seat worktree and the
  // old behavior silently rebuilt the worktree, then restarted the daemon on its unchanged (stale)
  // dist — every ✓ printed like success (issue #289). Fall back to the invoked checkout only when
  // no installed plist resolves (e.g. the daemon isn't installed yet).
  const dir = daemonCheckout(ctx) ?? ctx.workingDir;
  if (dir !== ctx.workingDir) {
    ok(
      `targeting the daemon's own checkout ${theme.accent(dir)} ` +
        theme.meta(`(you invoked musterd from ${ctx.workingDir})`),
    );
  }
  const git = (...args: string[]): RunResult => ctx.run('git', ['-C', dir, ...args]);

  if (git('rev-parse', '--is-inside-work-tree').status !== 0) {
    throw new CliError(
      `${dir} is not a git checkout — \`service refresh\` rebuilds the daemon from its own source, ` +
        `which only works when the daemon runs from a repo.`,
      1,
    );
  }
  // Never clobber someone's in-progress edits in the shared checkout.
  if (git('status', '--porcelain').stdout.trim()) {
    throw new CliError(
      `${dir} has uncommitted changes — commit or stash them first (refresh won't discard work).`,
      1,
    );
  }
  // Guard the bounce up front (like restart/stop): fail fast before any sync/build side effects.
  await guardLiveSessions(health, force);

  const before = git('rev-parse', '--short', 'HEAD').stdout.trim();
  const fetched = git('fetch', 'origin', 'main', '--quiet');
  if (fetched.status !== 0) fail('git fetch origin main', fetched);
  const switched = git('switch', '--detach', 'origin/main');
  if (switched.status !== 0) fail('git switch origin/main', switched);
  const after = git('rev-parse', '--short', 'HEAD').stdout.trim();
  ok(
    after === before
      ? `already on the latest main (${after})`
      : `synced ${dir} → ${after} ${theme.meta(`(was ${before})`)}`,
  );

  // Install when `node_modules` does not match the (post-sync) lockfile. A refresh is sync → build
  // → restart, with no install — fast and correct for the ~99% of merges that touch no dependency.
  // The predecessor of this check decided on the lockfile diff of the CURRENT hop
  // (`before..after`, #570), which had a retry hole: an install that failed — or a hop whose build
  // died before its lockfile change was ever installed — left the lockfile-moving commit behind
  // `before` forever, so no later refresh would install and the daemon stayed pinned until a human
  // ran `pnpm install` by hand (exactly how the #565 incident actually healed, 2026-08-01).
  // Consistency is a standing fact where the hop diff is a one-shot event: it stays true until the
  // install succeeds, so every refresh retries and the checkout self-heals — including a daemon
  // pinned AT the tip, where there is no hop at all.
  if (needsInstall(dir)) {
    process.stdout.write(
      theme.meta('  node_modules out of sync with pnpm-lock.yaml — installing…') + '\n',
    );
    const installed = ctx.run('pnpm', ['--dir', dir, 'install', '--frozen-lockfile']);
    // Advisory, not fatal: if the install fails the build below will say so with a better error,
    // and a refresh that could still succeed (a lockfile touched with no new package) must not be
    // aborted by this. Never silent, though — a skipped install is the thing that hid last time.
    ok(
      installed.status === 0
        ? 'installed new dependencies'
        : theme.meta('install failed — continuing to the build, which will name what is missing'),
    );
  }

  process.stdout.write(theme.meta('  building…') + '\n');
  const built = ctx.run('pnpm', ['--dir', dir, 'build']);
  if (built.status !== 0) {
    throw new CliError(
      `build failed — the daemon is still running the previous code (not bounced):\n` +
        (built.stderr || built.stdout || '').trim(),
      1,
    );
  }
  ok('rebuilt dist');

  const r = restart(ctx);
  if (r.status !== 0) fail('restart', r);
  ok(`restarted the musterd daemon on ${after}`);
  // Confirm it is actually serving before claiming the refresh worked — a rebuilt dist that fails to
  // boot (a bad native module, a bad merge) looks identical to success at the launchctl layer.
  await verifyDaemonUp(ctx, health, 'refresh', ok, sleep);
  // The rebuild above is checkout-wide, so anything else running from it is now stale too.
  bounceSiblings(ctx, dir, ok);
  return 0;
}

/** File-backed attempted-tip store for the auto-refresher debounce (§ {@link autoRefreshStampPath}). */
function fileAutoState(): { read: () => string | null; write: (sha: string) => void } {
  const p = autoRefreshStampPath();
  return {
    read: () => {
      try {
        return readFileSync(p, 'utf8').trim() || null;
      } catch {
        return null;
      }
    },
    write: (sha: string) => {
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, sha, 'utf8');
      } catch {
        // best-effort: a missing stamp only costs one redundant rebuild attempt, never correctness
      }
    },
  };
}

/**
 * One auto-refresh tick (`service refresh --auto`, ADR 118/130 fast-follow): decide whether the
 * running daemon is behind `origin/main` and, if so, whether it's safe to bounce it *now* — then
 * delegate the actual sync+build+restart to {@link refreshDaemon} (self-locates the daemon's
 * checkout, refuses on a dirty tree, aborts before the bounce on a build failure). This is the whole
 * quiet-period policy; the LaunchAgent just runs this on an interval.
 *
 *   1. **Skew** — compare the daemon's running `/health.build` to `origin/main`. Not behind → no-op
 *      (never rebuilds/bounces a current daemon). Unreachable / unknown ref → no-op (watcher, never
 *      gatekeeper — a dogfood daemon must never be worse off for running this).
 *   2. **Debounce** — if we already *attempted* this exact tip and the daemon still isn't on it (a
 *      build that failed), skip until a new commit lands, so a broken `main` doesn't rebuild every
 *      interval forever (mirrors the /live publisher's `.published-sha`).
 *   3. **Quiet period** — with live sessions connected: `idle` defers (retries next tick); `notice`
 *      fires an OS notice to the operator, then force-refreshes (the announced, conscious bounce —
 *      the team-facing announcement belongs to the future platform-guardian seat, not this schedule).
 *      With no live sessions, refresh straight through (the ADR 047 guard passes cleanly).
 */
async function autoRefreshTick(
  ctx: ServiceCtx,
  health: () => Promise<DaemonHealth>,
  mode: AutoRefreshMode,
  notify: (n: { id: string; title: string; body: string }) => void,
  autoState: { read: () => string | null; write: (sha: string) => void },
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
): Promise<number> {
  const dir = daemonCheckout(ctx) ?? ctx.workingDir;
  let health0: DaemonHealth;
  try {
    health0 = await health();
  } catch {
    ok('daemon unreachable — nothing to refresh');
    return 0;
  }
  if (!health0.build) {
    ok('daemon reports no build ref (not running from a checkout) — skipping');
    return 0;
  }
  const behind = countBehind(health0.build, dir, ctx.run); // fetches origin/main
  if (behind === null) {
    ok('build skew unknown — skipping');
    return 0;
  }
  const tip = ctx.run('git', ['-C', dir, 'rev-parse', 'origin/main']).stdout.trim();
  if (behind === 0) {
    if (autoState.read()) autoState.write(''); // reached tip — clear any stale attempt marker
    ok(`daemon up to date with origin/main (${health0.build.slice(0, 7)})`);
    return 0;
  }
  // Debounce: don't re-attempt a tip we already tried that didn't stick (a failed build) — UNLESS
  // the checkout's node_modules is out of sync with its lockfile. That state means the failed
  // attempt died for want of an install (the #565 pin), and a retry now runs one, so the retry has
  // genuinely new odds — where re-building a broken main would just fail identically every interval.
  // If the install keeps failing the tick keeps retrying, which is deliberate: an inconsistent
  // checkout is an outage-in-waiting for every seat adapter loading its dist, not a parkable state.
  if (tip && autoState.read() === tip) {
    if (!needsInstall(dir)) {
      ok(
        `already attempted ${tip.slice(0, 7)} (build did not stick) — waiting for a new commit ` +
          `or a manual \`musterd service refresh\``,
      );
      return 0;
    }
    ok(
      `retrying ${tip.slice(0, 7)} — node_modules is out of sync with pnpm-lock.yaml, ` +
        `so this attempt will install first`,
    );
  }
  const s = (n: number) => (n === 1 ? '' : 's');
  const conns = health0.connections ?? 0;
  if (conns > 0 && mode === 'idle') {
    ok(`${conns} live session${s(conns)} connected — deferring refresh (idle mode); will retry`);
    return 0;
  }
  const force = conns > 0; // notice mode with live sessions → announced, forced bounce
  if (force) {
    notify({
      id: 'musterd-autorefresh',
      title: 'musterd auto-refresh',
      body: `Updating the daemon to latest main (${behind} commit${s(behind)} behind); ${conns} live session${s(conns)} will briefly reconnect.`,
    });
    ok(`${conns} live session${s(conns)} — notified the operator, forcing the bounce`);
  }
  if (tip) autoState.write(tip); // mark the attempt BEFORE building, so a failed build debounces next tick
  try {
    return await refreshDaemon(ctx, health, force, ok, fail);
  } catch (err) {
    // A failed tick is the one state nothing else surfaces. The debounce then parks it, so the
    // daemon stays pinned on old code across every later merge while /health answers cheerfully —
    // and the only evidence is a log nobody reads unprompted. Say it out loud, once per tip (the
    // debounce above guarantees that), then rethrow so the log keeps the full error.
    notify({
      id: 'musterd-autorefresh-failed',
      title: 'musterd auto-refresh failed',
      body:
        `The daemon is pinned on ${health0.build.slice(0, 7)} — the refresh to ${tip.slice(0, 7)} ` +
        `did not build, and nothing will retry until a new commit lands. ` +
        `See ~/.musterd/autorefresh/refresh.log.`,
    });
    throw err;
  }
}

/**
 * `musterd service <verb> --auto` — manage the daemon auto-refresher (ADR 118/130 fast-follow): a
 * `StartInterval` agent that runs {@link autoRefreshTick} on a poll and, when the daemon is behind
 * `origin/main`, rebuilds + bounces it under the quiet-period policy. Bouncing it drops nobody (it
 * runs no server); the tick it schedules is what carries the live-session guard. (`refresh --auto`
 * is handled upstream — it IS the tick, not a lifecycle op.)
 */
async function autoRefreshServiceCommand(
  sub: string,
  ctx: AutoRefreshCtx,
  parsed: Parsed,
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
): Promise<number> {
  const meta = (s: string) => process.stdout.write(theme.meta(s) + '\n');
  const mode = ctx.refreshArgs[ctx.refreshArgs.indexOf('--mode') + 1] ?? DEFAULT_AUTOREFRESH_MODE;
  const quiet =
    mode === 'idle'
      ? 'idle only — never bounces a daemon with live sessions'
      : 'idle, else notify the operator then bounce';
  switch (sub) {
    case 'install': {
      const res = installAutoRefresh(ctx);
      if (res.status !== 0) fail('auto-refresher (bootstrap)', res);
      ok(`installed + started the daemon auto-refresher (${theme.accent(ctx.label)})`);
      meta(`  runs:    musterd service refresh --auto --mode ${mode}`);
      meta(
        `  cadence: on load + every ${ctx.intervalSeconds}s (only acts when behind origin/main)`,
      );
      meta(`  quiet:   ${quiet}`);
      meta(`  logs:    ${ctx.logPath}`);
      return 0;
    }
    case 'uninstall': {
      const res = uninstallAutoRefresh(ctx);
      ok(
        res.removedPlist
          ? 'stopped + removed the daemon auto-refresher'
          : 'daemon auto-refresher was not installed — nothing to remove',
      );
      return 0;
    }
    case 'start': {
      const r = startAutoRefresh(ctx);
      if (r.status !== 0) fail('start (auto-refresher)', r);
      ok('started the daemon auto-refresher');
      return 0;
    }
    case 'stop': {
      stopAutoRefresh(ctx);
      ok('stopped the daemon auto-refresher');
      return 0;
    }
    case 'restart': {
      const r = refreshAutoRefresh(ctx);
      if (r.status !== 0) fail('restart (auto-refresher)', r);
      ok('restarted the daemon auto-refresher (a tick runs now)');
      return 0;
    }
    case 'status': {
      const st = statusAutoRefresh(ctx);
      ok(
        `daemon auto-refresher: ${st.loaded ? theme.ok(st.state ?? 'loaded') : theme.warn('not installed')}`,
      );
      const autoDead = agentFailureNote(st, agentProgramExists(ctx.plistPath));
      if (autoDead) process.stdout.write(`  ${theme.err('✗')} ${autoDead}\n`);
      meta(`  runs:  musterd service refresh --auto --mode ${mode} every ${ctx.intervalSeconds}s`);
      meta(`  logs:  ${ctx.logPath}`);
      return 0;
    }
    case 'logs': {
      const follow = parsed.flags['follow'] === true || parsed.positionals.includes('-f');
      if (!follow) {
        const lines = tailFile(ctx.logPath, 40);
        process.stdout.write(theme.meta(`── ${ctx.logPath} ──`) + '\n');
        process.stdout.write(
          (lines.length ? lines.join('\n') : '(no auto-refresh runs yet)') + '\n',
        );
        return 0;
      }
      return new Promise<number>((resolveP) => {
        const child = spawn('tail', ['-f', ctx.logPath], { stdio: 'inherit' });
        const stopFollow = () => {
          child.kill();
          resolveP(0);
        };
        process.on('SIGINT', stopFollow);
        child.on('error', () => resolveP(0));
        child.on('exit', () => resolveP(0));
      });
    }
    default:
      throw new CliError(USAGE, 2);
  }
}

/**
 * `musterd service <verb> --sweep` — manage the ADR 166 liveness sweep: a `StartInterval` agent
 * that runs the fleet sweep and appends one JSONL row per run. It is the only thing watching
 * `demoted` after increment 2's flip, so leaving it unscheduled left the guardrail unobserved.
 * Read-only and bounce-safe: nothing long-lived is stopped, no seat or lane is touched.
 */
async function sweepServiceCommand(
  sub: string,
  ctx: SweepCtx,
  parsed: Parsed,
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
): Promise<number> {
  const meta = (s: string) => process.stdout.write(theme.meta(s) + '\n');
  switch (sub) {
    case 'install': {
      if (!existsSync(ctx.scriptPath))
        throw new CliError(
          `refusing to install: the sweep script is not at ${ctx.scriptPath}. ` +
            `The agent runs it out of the checkout this CLI was launched from — run \`musterd service ` +
            `install --sweep\` from a full checkout, not a published package.`,
          2,
        );
      const res = installSweep(ctx);
      if (res.status !== 0) fail('liveness sweep (bootstrap)', res);
      ok(`installed + started the ADR 166 liveness sweep (${theme.accent(ctx.label)})`);
      meta(`  runs:    ${ctx.scriptPath} ${ctx.scriptArgs.join(' ')}`);
      meta(
        `  cadence: on load + every ${ctx.intervalSeconds}s ` +
          `(a demotion persists ≥600s, so ≤600s cannot miss one)`,
      );
      meta(`  reports: a demoted workspace shows in \`musterd report\`; a repeat fires an OS push`);
      meta(`  logs:    ${ctx.logPath} (findings only — a clean run is silent)`);
      return 0;
    }
    case 'uninstall': {
      const res = uninstallSweep(ctx);
      ok(
        res.removedPlist
          ? 'stopped + removed the liveness sweep (the JSONL series is kept)'
          : 'liveness sweep was not installed — nothing to remove',
      );
      return 0;
    }
    case 'start': {
      const r = startSweep(ctx);
      if (r.status !== 0) fail('start (liveness sweep)', r);
      ok('started the liveness sweep');
      return 0;
    }
    case 'stop': {
      stopSweep(ctx);
      ok('stopped the liveness sweep');
      return 0;
    }
    case 'restart': {
      const r = refreshSweep(ctx);
      if (r.status !== 0) fail('restart (liveness sweep)', r);
      ok('restarted the liveness sweep (a sweep runs now)');
      return 0;
    }
    case 'status': {
      const st = statusSweep(ctx);
      ok(
        `liveness sweep: ${st.loaded ? theme.ok(st.state ?? 'loaded') : theme.warn('not installed')}`,
      );
      const dead = agentFailureNote(st, agentProgramExists(ctx.plistPath));
      if (dead) process.stdout.write(`  ${theme.err('✗')} ${dead}\n`);
      meta(`  runs:  ${ctx.scriptPath} every ${ctx.intervalSeconds}s`);
      meta(`  logs:  ${ctx.logPath}`);
      return 0;
    }
    case 'logs': {
      const follow = parsed.flags['follow'] === true || parsed.positionals.includes('-f');
      const lines = tailFile(ctx.logPath, 40);
      if (!follow) {
        process.stdout.write(theme.meta(`── ${ctx.logPath} ──`) + '\n');
        // "No findings" is the healthy state here, unlike the other agents' logs — say so, rather
        // than leaving an empty tail to read as "the agent never ran".
        process.stdout.write(
          (lines.length ? lines.join('\n') : '(no findings logged — a clean sweep is silent)') +
            '\n',
        );
        return 0;
      }
      return new Promise<number>((resolveP) => {
        const child = spawn('tail', ['-f', ctx.logPath], { stdio: 'inherit' });
        const stopFollow = () => {
          child.kill();
          resolveP(0);
        };
        process.on('SIGINT', stopFollow);
        child.on('error', () => resolveP(0));
        child.on('exit', () => resolveP(0));
      });
    }
    default:
      throw new CliError(USAGE, 2);
  }
}

/**
 * `musterd service <verb> --live` — manage the /live build-publisher (ADR 132): a single interval agent
 * that advances the `…/agents-live` worktree to `origin/main`, builds the web app, and atomically
 * publishes it into the daemon's web-root, which the daemon serves at `/live` from its own origin. No dev
 * server, no `:5173`. Unlike the daemon verbs these drop no teammate session (nothing long-lived is
 * bounced), so there's no live-session guard.
 */
/** Does the daemon serve `/live`? A short-timeout GET against the daemon's own origin, so `status --live`
 * reflects "is the page actually served" (the real surface now), not just "agent loaded". Injected in
 * `serviceCommand` so tests never touch the network. */
async function probeViewer(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/live`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function liveServiceCommand(
  sub: string,
  ctx: LiveCtx,
  parsed: Parsed,
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
  probe: (url: string) => Promise<boolean>,
): Promise<number> {
  const meta = (s: string) => process.stdout.write(theme.meta(s) + '\n');
  switch (sub) {
    case 'install': {
      const res = installLive(ctx);
      if (res.worktree.result && !res.worktree.created && res.worktree.result.status !== 0)
        fail('git worktree add', res.worktree.result);
      if (res.build.status !== 0) fail('build-publisher (bootstrap)', res.build);
      ok(`installed + started the /live build-publisher (${theme.accent(ctx.buildLabel)})`);
      meta(`  worktree:  ${ctx.worktree}${res.worktree.created ? ' (created)' : ''}`);
      meta(`  builds →   ${ctx.webRoot}  (the daemon serves this at /live)`);
      meta(`  publishes: on load + every ${ctx.intervalSeconds}s when origin/main moves`);
      meta(`  logs:      ${ctx.buildLogPath}`);
      return 0;
    }
    case 'uninstall': {
      const purge = parsed.flags['purge'] === true;
      const res = uninstallLive(ctx, purge);
      ok(
        res.removedPlists > 0
          ? `stopped + removed the /live build-publisher${purge ? ' + worktree' : ''}`
          : `/live build-publisher was not installed — nothing to remove`,
      );
      return 0;
    }
    case 'start': {
      const r = startLive(ctx);
      if (r.build.status !== 0) fail('start (build-publisher)', r.build);
      ok('started the /live build-publisher');
      return 0;
    }
    case 'stop': {
      stopLive(ctx);
      ok('stopped the /live build-publisher');
      return 0;
    }
    case 'restart':
    case 'refresh': {
      const r = refreshLive(ctx);
      if (r.status !== 0) fail('refresh', r);
      ok(`triggered a /live rebuild — it will publish the tip of origin/main`);
      return 0;
    }
    case 'status':
      return renderLiveStatus(ctx, probe);
    case 'logs': {
      const follow = parsed.flags['follow'] === true || parsed.positionals.includes('-f');
      return liveLogs(ctx, follow);
    }
    default:
      throw new CliError(USAGE, 2);
  }
}

/**
 * `musterd service <verb> --wake` — manage the wake actuator (`musterd host`) as a LaunchAgent
 * (ADR 131 inc 5), so residency survives a reboot instead of depending on a terminal someone left
 * open. Same posture as `--live`: no server, no live-session guard (bouncing it drops nobody; an
 * interrupted lease expires back to due). The one daemon-shaped concern that DOES carry over is
 * the abi guard on `install`: the plist embeds `process.execPath`, and `musterd host` loads the
 * CLI's native modules (the CLI links @musterd/server statically) — a Node-20 install would
 * crashloop it exactly like the daemon.
 */
async function wakeServiceCommand(
  sub: string,
  daemonCtx: ServiceCtx,
  ctx: WakeHostCtx,
  parsed: Parsed,
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
  force: boolean,
): Promise<number> {
  const meta = (s: string) => process.stdout.write(theme.meta(s) + '\n');
  const registrySummary = () => {
    const entries = loadHostRegistry().entries;
    return entries.length === 0
      ? theme.warn('0 seats registered — run `musterd residency on` in a seat workspace')
      : `${entries.length} seat${entries.length === 1 ? '' : 's'} registered (${entries.map((e) => e.seat).join(', ')})`;
  };
  switch (sub) {
    case 'install': {
      const abi = force ? null : nodeAbiMismatch(daemonCtx);
      if (abi) {
        throw new CliError(
          `refusing to install: ${ctx.node} cannot load the CLI's native modules, so the wake ` +
            `actuator would crashloop on boot.\n\n  ${abi}\n\n` +
            `Put a matching node first on PATH and re-run, e.g.\n` +
            `  export PATH="/opt/homebrew/opt/node@${MIN_NODE_MAJOR}/bin:$PATH" && musterd service install --wake\n\n` +
            `(\`--force\` overrides.)`,
          1,
        );
      }
      const res = installWakeHost(ctx);
      if (res.status !== 0) fail('install --wake (bootstrap)', res);
      ok(`installed + started the wake actuator (LaunchAgent ${theme.accent(ctx.label)})`);
      meta(`  plist:    ${ctx.plistPath}`);
      meta(`  runs:     ${ctx.binJs} host ${ctx.hostArgs.join(' ')}`.trimEnd());
      meta(`  registry: ${registrySummary()}`);
      meta(`  logs:     ${ctx.logPath}`);
      return 0;
    }
    case 'uninstall': {
      const res = uninstallWakeHost(ctx);
      ok(
        res.removedPlist
          ? `stopped + removed the wake actuator (${ctx.label})`
          : `wake actuator was not installed — nothing to remove`,
      );
      return 0;
    }
    case 'start': {
      const r = startWakeHost(ctx);
      if (r.status !== 0) fail('start --wake (bootstrap)', r);
      ok('started the wake actuator');
      return 0;
    }
    case 'stop': {
      const r = stopWakeHost(ctx);
      ok(r.status === 0 ? 'stopped the wake actuator' : 'wake actuator was not running');
      return 0;
    }
    case 'restart':
    case 'refresh': {
      // The loop re-reads its registry every tick, so enrollment changes need NO service op; a
      // restart only matters to pick up a rebuilt dist (`service refresh` on the daemon checkout
      // rebuilds it — then this).
      const r = restartWakeHost(ctx);
      if (r.status !== 0) fail('restart --wake', r);
      ok('restarted the wake actuator (picks up the current dist + registry)');
      return 0;
    }
    case 'status': {
      const s = statusWakeHost(ctx);
      const line = s.loaded
        ? theme.ok(`loaded${s.pid ? ` · pid ${s.pid}` : ''}${s.state ? ` · ${s.state}` : ''}`)
        : theme.warn('not loaded');
      process.stdout.write(`${theme.accent(ctx.label)}  ${line}\n`);
      const wakeDead = agentFailureNote(s, agentProgramExists(ctx.plistPath));
      if (wakeDead) process.stdout.write(`  ${theme.err('✗')} ${wakeDead}\n`);
      meta(`  plist:    ${ctx.plistPath}`);
      meta(`  registry: ${registrySummary()}`);
      meta(`  logs:     ${ctx.logPath}`);
      return 0;
    }
    case 'logs': {
      const follow = parsed.flags['follow'] === true || parsed.positionals.includes('-f');
      if (!follow) {
        for (const [label, path] of [
          ['host', ctx.logPath],
          ['stderr', ctx.errLogPath],
        ] as const) {
          const lines = tailFile(path, 40);
          if (lines.length === 0) continue;
          process.stdout.write(theme.meta(`── ${label}: ${path} ──`) + '\n');
          process.stdout.write(lines.join('\n') + '\n');
        }
        return 0;
      }
      return new Promise<number>((resolveP) => {
        const child = spawn('tail', ['-f', ctx.logPath], { stdio: 'inherit' });
        const stopFollow = () => {
          child.kill();
          resolveP(0);
        };
        process.on('SIGINT', stopFollow);
        child.on('error', () => resolveP(0));
        child.on('exit', () => resolveP(0));
      });
    }
    default:
      throw new CliError(USAGE, 2);
  }
}

async function renderLiveStatus(
  ctx: LiveCtx,
  probe: (url: string) => Promise<boolean>,
): Promise<number> {
  const s = statusLive(ctx).build;
  const line = s.loaded
    ? theme.ok(`loaded${s.pid ? ` · pid ${s.pid}` : ''}${s.state ? ` · ${s.state}` : ''}`)
    : theme.warn('not loaded');
  process.stdout.write(`${theme.accent(ctx.buildLabel)}  ${line}\n`);
  process.stdout.write(theme.meta(`  worktree: ${ctx.worktree}`) + '\n');
  process.stdout.write(theme.meta(`  web-root: ${ctx.webRoot}`) + '\n');
  // Probe the *daemon's* /live — the real serving surface now — instead of a dev port.
  const server = loadConfig().server;
  const up = await probe(server);
  process.stdout.write(
    `  ${theme.meta('viewer:')} ${up ? theme.ok('up') : theme.err('unreachable')}${theme.meta(` · ${server}/live`)}\n`,
  );
  return 0;
}

function liveLogs(ctx: LiveCtx, follow: boolean): Promise<number> {
  if (!follow) {
    const lines = tailFile(ctx.buildLogPath, 40);
    if (lines.length) {
      process.stdout.write(theme.meta(`── build: ${ctx.buildLogPath} ──`) + '\n');
      process.stdout.write(lines.join('\n') + '\n');
    }
    return Promise.resolve(0);
  }
  return new Promise<number>((resolveP) => {
    const child = spawn('tail', ['-f', ctx.buildLogPath], { stdio: 'inherit' });
    const stopFollow = () => {
      child.kill();
      resolveP(0);
    };
    process.on('SIGINT', stopFollow);
    child.on('error', () => resolveP(0));
    child.on('exit', () => resolveP(0));
  });
}

async function renderStatus(
  ctx: ServiceCtx,
  fetchHealthFn: () => Promise<DaemonHealth>,
): Promise<number> {
  const st = status(ctx);
  const server = loadConfig().server;
  let health: DaemonHealth | undefined;
  try {
    health = await fetchHealthFn();
  } catch {
    // daemon may be down or unreachable — reflected below
  }

  const dead = agentFailureNote(st, agentProgramExists(ctx.plistPath));
  const loaded = st.loaded
    ? theme.ok(`loaded${st.pid ? ` · pid ${st.pid}` : ''}${st.state ? ` · ${st.state}` : ''}`)
    : theme.warn('not loaded');
  process.stdout.write(`${theme.accent(ctx.label)}  ${loaded}\n`);
  // A crash-looping agent stays "loaded", so the state line alone reads like health. Say it plainly.
  if (dead) process.stdout.write(`  ${theme.err('✗')} ${dead}\n`);
  process.stdout.write(theme.meta(`  plist:  ${ctx.plistPath}`) + '\n');
  process.stdout.write(
    `  ${theme.meta('health:')} ${
      health
        ? theme.ok(`up`) + theme.meta(` · ${server} · ${health.db} (schema ${health.schema})`)
        : theme.err('unreachable') + theme.meta(` · ${server}`)
    }\n`,
  );
  // The ADR 040 allow-list, so a broken overlay is diagnosable without reading a plist. Labelled
  // plist-derived on purpose: this is what someone WROTE, not what the running daemon enforces, and
  // the two can disagree (a plist edited after the last bounce). `musterd stream doctor` settles it
  // empirically by attempting a real upgrade — trust that over this line when they conflict.
  const hosts = ctx.env?.['MUSTERD_ALLOWED_HOSTS'];
  if (hosts)
    process.stdout.write(
      `  ${theme.meta('hosts:')}  ${hosts} ${theme.meta('(plist-derived; ADR 040 allow-list)')}\n`,
    );
  // Build provenance + skew (ADR 130): the running daemon names its commit; we name the gap — and
  // who owns closing it, so a machine with the auto-refresher installed never reads as a chore.
  if (health?.build) {
    const loaded = statusAutoRefresh(
      resolveAutoRefreshCtx(ctx.run, { flags: {}, positionals: [], metaPairs: [] }),
    ).loaded;
    const ownership = autoRefreshOwnership(ctx.workingDir, ctx.run, loaded);
    process.stdout.write(
      `  ${theme.meta('build:')}  ${buildSkewNote(health.build, ctx.workingDir, ctx.run, ownership)}\n`,
    );
  }
  return 0;
}

function logs(ctx: ServiceCtx, follow: boolean): Promise<number> {
  if (!follow) {
    for (const [label, path] of [
      ['stdout', ctx.stdoutPath],
      ['stderr', ctx.stderrPath],
    ] as const) {
      const lines = tailFile(path, 40);
      if (lines.length === 0) continue;
      process.stdout.write(theme.meta(`── ${label}: ${path} ──`) + '\n');
      process.stdout.write(lines.join('\n') + '\n');
    }
    return Promise.resolve(0);
  }
  // Follow mode: hand off to `tail -f` (a standard OS tool, like notify's osascript), inheriting stdio.
  return new Promise<number>((resolveP) => {
    const child = spawn('tail', ['-f', ctx.stdoutPath, ctx.stderrPath], { stdio: 'inherit' });
    const stopFollow = () => {
      child.kill();
      resolveP(0);
    };
    process.on('SIGINT', stopFollow);
    child.on('error', () => resolveP(0));
    child.on('exit', () => resolveP(0));
  });
}
