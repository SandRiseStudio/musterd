import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { configPath, loadConfig, serverProvenance } from '../config.js';
import { CliError } from '../errors.js';
import { actOn } from '../guardian/act.js';
import { resolveGuardianTiers, DEFAULT_TIERS } from '../guardian/classify.js';
import { collectSignals, type HealthPayload } from '../guardian/signals.js';
import { loadHostRegistry } from '../host/registry.js';
import { infraTouchWarning } from '../infra-gate.js';
import { osNotify, type NotifyItem } from '../notify/os.js';
import { theme } from '../render/theme.js';
import { sym } from '../render/ui.js';
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
import { guardianStatusLine, guardianTick } from '../service/guardian.js';
import { clearHandover, readHandover, writeHandover } from '../service/handover.js';
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
  STREAMWATCH_LABEL,
  SWEEP_LABEL,
  GUARDIAN_LABEL,
  printArgs,
  agentFailureNote,
  intervalAgentLabel,
  parsePlistEnvironment,
  parsePlistProgramArguments,
  SERVICE_LABEL,
  serviceSupported,
  stableNodePath,
  type LaunchctlStatus,
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
import { mb, trimServiceLogs, type TrimmedLog } from '../service/logTrim.js';
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
  DEFAULT_STREAMWATCH_INTERVAL,
  installStreamwatch,
  statusStreamwatch,
  uninstallStreamwatch,
  type StreamwatchCtx,
} from '../service/streamwatch.js';
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
  'usage: musterd service <install|uninstall|start|stop|restart|refresh|status|logs> [--live | --wake | --auto | --sweep | --guardian | --stream] [--port <n>] [--host <h>] [--allowed-hosts <a,b>] [--otlp-endpoint <url>] [--interval <s>] [--timeout <s>] [--mode <idle|notice>] [--settle <s>] [--pin <ref>] [--follow] [--force]';

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

/**
 * The settle window: how long `origin/main` must hold still before the tick bounces onto it, and the
 * hard cap on how long that deferral may accumulate.
 *
 * The tick used to bounce on ANY skew, so a merge burst became a bounce storm — each merge paying a
 * full sync → build → restart daemon → restart wake actuator, an operator notification, and every
 * live seat dropping and reconnecting. Measured 2026-08-03: 19 merges in a day, 11 of them inside
 * three hours, including two complete bounces two minutes apart (#610 15:27, #611 15:29) for a
 * daemon that landed on the same tip either way. The operator read the volume as autorefresh
 * failures; there were none. `--mode notice` is right about the *tradeoff* (interrupt live seats to
 * stay current) and was simply paying it per commit rather than per catch-up.
 *
 * Defaults are fitted to that real trace, not guessed: replaying it, 600s/900s turns 19 bounces into
 * 12 while bounding worst-case staleness at 15 minutes. (300s saves only 3; 900s saves 12 but lets
 * the daemon sit 55 minutes behind.) `--settle 0` restores the old bounce-immediately behaviour.
 *
 * The cap is measured from the OLDEST unapplied commit, which is what makes this safe: a
 * continuously busy main can delay a bounce but can never cancel one, so the daemon's staleness is
 * bounded by wall-clock rather than by whether anyone stops merging.
 */
const DEFAULT_AUTOREFRESH_SETTLE = 600;
const DEFAULT_AUTOREFRESH_SETTLE_CAP = 900;
/** Quiet floor default (quiescence inc 2): hold a bounce while an agent acted in the last 2 min. */
const DEFAULT_AUTOREFRESH_QUIET_FLOOR = 120;

function parseSeconds(parsed: Parsed, flag: string, fallback: number): number {
  const raw = flagStr(parsed.flags, flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new CliError(`--${flag} must be seconds >= 0`, 2);
  return Math.floor(n);
}

/**
 * Should this tick bounce now, or wait for the burst to settle? Pure so the policy is testable
 * without git, and so the two clocks stay legible as the different things they are.
 *
 * `tipAge` is how long the newest commit has sat (is main still moving?); `oldestAge` is how long
 * the daemon has been behind (how stale are we allowed to get?). Deliberately NOT the `.attempted-sha`
 * debounce, which answers a third question — "did the build for this tip already fail?" — and whose
 * conflation with tick liveness produced #587 and #600.
 *
 * Unknown ages mean bounce: degrade to the old behaviour, never to an indefinite hold.
 */
export function shouldWaitForSettle(a: {
  tipAgeSeconds: number | null;
  oldestAgeSeconds: number | null;
  settleSeconds: number;
  capSeconds: number;
}): boolean {
  if (a.settleSeconds <= 0) return false;
  if (a.tipAgeSeconds === null) return false; // can't tell → don't hold the daemon back
  if (a.tipAgeSeconds >= a.settleSeconds) return false; // main has held still: go
  // Main is still moving. Wait — unless we've already waited long enough.
  if (a.oldestAgeSeconds !== null && a.oldestAgeSeconds >= a.capSeconds) return false;
  return true;
}

/**
 * The quiet floor (quiescence inc 2 — spec: docs/superpowers/specs/2026-08-03-quiescence-signal-
 * design.md). The settle window answers "is MAIN still moving?"; this answers "is a SEAT still
 * moving?" — hold the bounce while an agent acted within the floor, so the restart lands in a lull
 * instead of mid-tool-call. Measured basis: gating on connections would defer 95% of refreshes
 * (seats stay attached all day), while the audit trail shows 44 lulls ≥ 2 min in 6 busy hours — a
 * lull is almost always near, so this delays by seconds-to-minutes, not hours.
 *
 * Same safety shape as settle, deliberately: the staleness cap forces through BOTH gates, so
 * quiet-seeking can only steer a bounce toward a lull, never cancel it. And `undefined` (an old
 * daemon, or no evidence) means bounce — the floor acts only on positive evidence of work.
 */
export function shouldWaitForQuiet(a: {
  quietestBusyMs: number | undefined;
  oldestAgeSeconds: number | null;
  floorSeconds: number;
  capSeconds: number;
}): boolean {
  if (a.floorSeconds <= 0) return false;
  if (a.quietestBusyMs === undefined) return false; // unknown → degrade to today, never hold
  if (a.quietestBusyMs >= a.floorSeconds * 1000) return false; // the lull is here: go
  if (a.oldestAgeSeconds !== null && a.oldestAgeSeconds >= a.capSeconds) return false; // cap wins
  return true;
}

/** Committer time (epoch seconds) of `rev`, or null when it can't be read. */
function commitTime(dir: string, rev: string, run: Runner, oldestSince?: string): number | null {
  const args = oldestSince
    ? ['-C', dir, 'log', '--reverse', '--format=%ct', `${oldestSince}..${rev}`]
    : ['-C', dir, 'log', '-1', '--format=%ct', rev];
  const r = run('git', args);
  if (r.status !== 0) return null;
  const first = r.stdout.trim().split('\n')[0];
  const n = Number(first);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Local wall-clock prefix for one line of unattended log (`YYYY-MM-DD HH:MM:SS`, the /live
 * publisher's format so both service logs read alike). Local, not UTC: the reader is a human at
 * this machine correlating a log line against something they just watched happen on this screen.
 */
function stamp(when: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
  return theme.meta(`${d} ${p(when.getHours())}:${p(when.getMinutes())}:${p(when.getSeconds())}`);
}

/** Where the auto-refresher records the last origin/main tip it *attempted* to refresh onto, so a
 *  build that fails against a given tip isn't re-attempted every interval (the debounce mirrors the
 *  /live publisher's `.published-sha`). Cleared once the daemon actually reaches that tip. */
function autoRefreshStampPath(): string {
  return join(dirname(configPath()), 'autorefresh', '.attempted-sha');
}

/** ADR 274's explicit daemon-restart state; never reuse the attempted-tip debounce for liveness. */
function refreshHandoverPath(): string {
  return join(dirname(configPath()), 'autorefresh', 'handover.json');
}

/**
 * Resolve the ADR 166 liveness sweep from the running process. The plist runs the research script
 * out of the CHECKOUT this CLI was launched from — deliberately the daemon's own checkout on a
 * dogfood machine, because the auto-refresher already keeps that one built and the sweep imports
 * `packages/cli/dist`: running anywhere else would measure with an artifact production is not
 * using. `--interval` (bare seconds) is baked at install, like the other interval agents.
 */
/**
 * Resolve the ADR 293 stream supervisor from the running process: the plist runs `node bin.js
 * stream ensure` on an interval. PATH carries the homebrew dirs — the reconcile shells `fly` and
 * `tailscale`, and launchd's default PATH has neither.
 */
function resolveStreamwatchCtx(run: Runner, parsed: Parsed): StreamwatchCtx {
  const binJs = resolvePath(process.argv[1] ?? '');
  const home = dirname(configPath()); // ~/.musterd
  const interval = flagStr(parsed.flags, 'interval');
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : '',
    label: STREAMWATCH_LABEL,
    plistPath: join(homedir(), 'Library', 'LaunchAgents', `${STREAMWATCH_LABEL}.plist`),
    node: agentNode(),
    binJs,
    workingDir: dirname(binJs),
    logPath: join(home, 'stream', 'ensure.log'),
    errLogPath: join(home, 'stream', 'ensure.log'),
    path: [
      dirname(process.execPath),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':'),
    intervalSeconds: interval ? Number(interval) : DEFAULT_STREAMWATCH_INTERVAL,
    run,
  };
}

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
  // Bake `--settle` only when it differs from the default, so an existing plist keeps working AND
  // picks up a changed default on the next build — the same reason the entry bakes as little as
  // possible elsewhere (ADR 165): a value frozen in a plist is a value no later change can correct.
  const settle = parseSeconds(parsed, 'settle', DEFAULT_AUTOREFRESH_SETTLE);
  const settleCap = parseSeconds(parsed, 'settle-cap', DEFAULT_AUTOREFRESH_SETTLE_CAP);
  const settleArgs = [
    ...(settle === DEFAULT_AUTOREFRESH_SETTLE ? [] : ['--settle', String(settle)]),
    ...(settleCap === DEFAULT_AUTOREFRESH_SETTLE_CAP ? [] : ['--settle-cap', String(settleCap)]),
  ];
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : '',
    label: AUTOREFRESH_LABEL,
    plistPath: join(homedir(), 'Library', 'LaunchAgents', `${AUTOREFRESH_LABEL}.plist`),
    node: agentNode(),
    binJs,
    refreshArgs: ['refresh', '--auto', '--mode', mode, ...settleArgs],
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
    // ADR 232 §5: the service seat's token file rides the plist environment — the tick reads it
    // back to announce as `autorefresh`, never inheriting the folder binding it runs inside.
    env: { MUSTERD_SERVICE_TOKEN_FILE: join(home, 'autorefresh', 'seat-token') },
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
  /** Quiescence (2026-08-03 design): ms since the newest audited action by a live agent seat.
   *  Absent = unknown (old daemon, or no agent action in the lookback) — never treated as 0. */
  quietest_busy_ms?: number;
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
  otlpEndpoint?: string,
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
  if (otlpEndpoint !== undefined) {
    const endpoint = otlpEndpoint.trim();
    if (endpoint) env['OTEL_EXPORTER_OTLP_ENDPOINT'] = endpoint;
    else delete env['OTEL_EXPORTER_OTLP_ENDPOINT'];
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
  baseline?: DaemonHealth,
): Promise<DaemonHealth | null> {
  // BASELINE FIRST — this is what makes the check honest. `/health` being unreachable can mean the
  // daemon is down, or merely that this CLI cannot see it (a daemon bound off-loopback, a `server`
  // pointing elsewhere — the very overlay case this lane is about). Only a daemon that answered
  // BEFORE the bounce and not after is evidence of an outage. Without a baseline we say so and warn,
  // rather than hard-failing a working system: the pre-existing "fail open when health is
  // unreachable" contract stays intact exactly where it was meant to apply.
  const wasUp =
    baseline !== undefined ||
    (await health().then(
      () => true,
      () => false,
    ));
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
 * - `refreshing` — the auto-refresher already attempted this exact tip and launchd shows its one-shot
 *   tick is still running. The daemon is behind only because the sync/build/bounce has not completed.
 * - `stalled` — the same attempt exists but no tick is running. The build or restart failed and the
 *   debounce will hold the daemon on the previous build until a new tip lands. A successful tick
 *   clears the marker, so a healthy settled machine never reaches this branch.
 */
type SkewOwner = 'off' | 'watching' | 'refreshing' | 'stalled';

export function autoRefreshOwnership(
  dir: string,
  run: Runner,
  autoRefresh: Pick<LaunchctlStatus, 'loaded' | 'pid'>,
): SkewOwner {
  if (!autoRefresh.loaded) return 'off';
  // The debounce stamp names the tip the tick last *attempted*. If it already equals origin/main
  // while the daemon is still behind, the attempt failed — the tick is not going to try again.
  try {
    const attempted = readFileSync(autoRefreshStampPath(), 'utf8').trim();
    if (!attempted) return 'watching';
    const tip = run('git', ['-C', dir, 'rev-parse', 'origin/main']);
    if (tip.status !== 0) return 'watching'; // no verdict — assume the watcher is fine (never alarm on ignorance)
    if (attempted !== tip.stdout.trim()) return 'watching';
    return autoRefresh.pid !== null ? 'refreshing' : 'stalled';
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
  if (ownership === 'refreshing') {
    return `${short} ${theme.meta(`· ${commits} — refresh in progress`)}`;
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
          `lands. Check ~/.musterd/autorefresh/refresh.log for what the tick actually said.`,
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
    guardianCtx?: AutoRefreshCtx;
    sweepCtx?: SweepCtx;
    streamwatchCtx?: StreamwatchCtx;
    health?: () => Promise<DaemonHealth>;
    /** Probe whether the daemon serves /live (injected so tests skip the network). */
    probeViewer?: (url: string) => Promise<boolean>;
    /** Fire an OS notice (injected so the `--auto --mode notice` tick is testable). */
    notify?: (n: { id: string; title: string; body: string }) => void;
    /** The attempted-tip debounce store (injected in tests; defaults to a file under ~/.musterd). */
    autoState?: { read: () => string | null; write: (sha: string) => void };
    /** ADR 230: the outage run/escalation marker — SEPARATE from the build debounce, so an outage
     *  can never clobber the broken-`main` attempted-tip marker (or be clobbered by it). */
    outageState?: { read: () => string | null; write: (s: string) => void };
    /** Sleep between post-bounce `/health` polls (injected so tests never actually wait). */
    sleep?: (ms: number) => Promise<void>;
    /** ADR 224 log trim (injected so the tick's tests never touch the real ~/.musterd logs). */
    trimLogs?: () => TrimmedLog[];
    /** ADR 227 inc 2: the warn-only infra-touch gate (injected so tests never reach a daemon). */
    infraGate?: (verb: string) => Promise<string | null>;
    /** ADR 232 §3 amendment: the per-tick service-seat presence heartbeat (injected so tests
     *  never read the real token file or reach a daemon). */
    touch?: (ok: (s: string) => void) => Promise<void>;
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

  if (parsed.flags['otlp-endpoint'] === true) {
    throw new CliError("--otlp-endpoint requires a URL (pass '' to clear)", 2);
  }
  const otlpEndpoint = flagStr(parsed.flags, 'otlp-endpoint');
  const targetsAnotherService = ['live', 'wake', 'auto', 'guardian', 'sweep'].some(
    (flag) => parsed.flags[flag] === true,
  );
  if (otlpEndpoint !== undefined && (sub !== 'install' || targetsAnotherService)) {
    throw new CliError('--otlp-endpoint is only valid for daemon service install', 2);
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
      otlpEndpoint,
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
      const settle = {
        seconds: parseSeconds(parsed, 'settle', DEFAULT_AUTOREFRESH_SETTLE),
        capSeconds: parseSeconds(parsed, 'settle-cap', DEFAULT_AUTOREFRESH_SETTLE_CAP),
        quietFloorSeconds: parseSeconds(parsed, 'quiet-floor', DEFAULT_AUTOREFRESH_QUIET_FLOOR),
      };
      const autoState = deps.autoState ?? fileAutoState();
      const outageState = deps.outageState ?? fileOutageState();
      // Unattended output: stamp it and record what the operator was actually shown. `refresh.log`
      // is read after the fact, by a human asking "why did my machine just do that?" — and it
      // answered neither half. Every line looked alike whether it was emitted 2 minutes or 2 days
      // ago (StartInterval appends, launchd writes no timestamps), and a fired OS notification left
      // no trace at all, so a report of three notices could not be checked against the log that
      // caused them (#631, diagnosed by reasoning because the evidence did not exist).
      const okStamped = (s: string) => process.stdout.write(`${stamp()} ${theme.ok('✓')} ${s}\n`);
      // Log hygiene (ADR 224) runs BEFORE the skew check and independently of it: the logs grow
      // from the daemon's own traffic, not from refreshes, so a machine that is perfectly up to
      // date is exactly the one whose logs nobody is bounding. Silent under the cap.
      for (const t of deps.trimLogs?.() ?? trimServiceLogs(dirname(configPath())))
        okStamped(
          `trimmed ${t.path} — ${mb(t.before)} over the cap; previous contents in ${t.path}.1`,
        );
      const notifier = deps.notify ?? osNotify;
      const notify = (n: NotifyItem) => {
        notifier(n);
        // A ledger entry, not a step — the failure notice has no ✓ line of its own, so this is the
        // only place the log ever admits the operator's screen was interrupted.
        process.stdout.write(
          `${stamp()} ${theme.meta(`· notified the operator: "${n.title}" — ${n.body}`)}\n`,
        );
      };
      return autoRefreshTick(
        ctx,
        health,
        mode,
        settle,
        notify,
        autoState,
        outageState,
        okStamped,
        fail,
        deps.touch,
      );
    }
    const arCtx = deps.autoRefreshCtx ?? resolveAutoRefreshCtx(ctx.run, parsed);
    return autoRefreshServiceCommand(sub, arCtx, parsed, ok, fail);
  }

  // `--guardian` targets the on-call probe (2026-08-13 guardian spec): `guardian-tick` runs one
  // probe (collect → classify → act), every other verb manages the interval LaunchAgent that runs
  // it — the exact `--auto` shape, reusing the autorefresh lifecycle module.
  if (sub === 'guardian-tick') {
    return runGuardianTick(ctx, parsed);
  }
  if (parsed.flags['guardian'] === true) {
    const gCtx = deps.guardianCtx ?? resolveGuardianCtx(ctx.run, parsed);
    return guardianServiceCommand(sub, gCtx, ok, fail);
  }

  // `--sweep` targets the ADR 166 liveness sweep. Same posture as `--live`/`--auto`: read-only, no
  // server, no teammate session dropped, so no live-session guard and no ABI guard (it loads the
  // CLI's JS, not its native modules).
  if (parsed.flags['sweep'] === true) {
    const sweepCtx = deps.sweepCtx ?? resolveSweepCtx(ctx.run, parsed);
    return sweepServiceCommand(sub, sweepCtx, parsed, ok, fail);
  }

  // `--stream` targets the ADR 293 stream supervisor. Same posture as `--sweep`: no server touched,
  // no teammate session dropped, so no live-session guard and no ABI guard.
  if (parsed.flags['stream'] === true) {
    const swCtx = deps.streamwatchCtx ?? resolveStreamwatchCtx(ctx.run, parsed);
    return streamwatchServiceCommand(sub, swCtx, ok, fail);
  }

  // The warn-only infra-touch gate (ADR 227 inc 2), on the daemon-targeted verbs only — the
  // `--live`/`--wake`/`--auto`/`--sweep` retargets above run no server and drop no teammate
  // session, so they returned before this line. A non-`platform` agent seat gets one line naming
  // the current holders (the daemon writes the audit row); everything else — holder, human shell,
  // unbound folder, daemon unreachable — is silence, and either way the verb PROCEEDS.
  if (sub === 'install' || sub === 'restart' || sub === 'refresh') {
    const warn = await (deps.infraGate ?? infraTouchWarning)(sub);
    if (warn) process.stdout.write(`${theme.warn(sym.warn)} ${theme.warn(warn)}\n`);
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
    case 'refresh': {
      const pin = typeof parsed.flags['pin'] === 'string' ? parsed.flags['pin'] : undefined;
      return refreshDaemon(ctx, health, force, ok, fail, deps.sleep, undefined, undefined, pin);
    }
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
  baseline?: DaemonHealth,
  /**
   * Fired once, immediately before the bounce — after the sync and the build have both succeeded.
   * The auto-refresher uses it to announce the reconnect to the operator. Deliberately NOT called
   * up front: everything before this point can throw (dirty checkout, failed build) and leave the
   * daemon exactly where it was, so an early announcement is a promise about a bounce that may
   * never happen — and it stacks with the failure notice for the same tip (#631).
   */
  announce?: () => void,
  /**
   * Guardian crashloop rollback (2026-08-13 spec §4): refresh to this ref instead of origin/main.
   * No fetch — a pin target is a commit this checkout already ran. Everything downstream (install
   * consistency, build, restart, verify, sibling bounce) is identical to a normal refresh.
   */
  pinRef?: string,
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
  if (pinRef !== undefined) {
    const switched = git('switch', '--detach', pinRef);
    if (switched.status !== 0) fail(`git switch ${pinRef}`, switched);
    const after = git('rev-parse', '--short', 'HEAD').stdout.trim();
    ok(`pinned ${dir} → ${after} ${theme.meta(`(was ${before})`)}`);
  } else {
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
  }
  const after = git('rev-parse', '--short', 'HEAD').stdout.trim();

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

  announce?.();
  // This record starts at the only point a refresh becomes a handover: the build has succeeded and
  // the next operation restarts the daemon. A failed verification intentionally leaves it behind;
  // the guardian's bounded reader then turns the remaining outage loud after its grace window.
  const handoverPath = refreshHandoverPath();
  writeHandover(handoverPath, { startedAt: Date.now(), targetBuild: after });
  const r = restart(ctx);
  if (r.status !== 0) fail('restart', r);
  ok(`restarted the musterd daemon on ${after}`);
  // Confirm it is actually serving before claiming the refresh worked — a rebuilt dist that fails to
  // boot (a bad native module, a bad merge) looks identical to success at the launchctl layer.
  await verifyDaemonUp(ctx, health, 'refresh', ok, sleep, baseline);
  clearHandover(handoverPath);
  // The rebuild above is checkout-wide, so anything else running from it is now stale too.
  bounceSiblings(ctx, dir, ok);
  return 0;
}

/** The auto-refresher's ledger-seat name (ADR 232) — the first attributed unattended actor. */
const AUTOREFRESH_SEAT = 'autorefresh';

/** Where `service install --auto` delivers the service seat's token (0600, never logged). */
export function serviceTokenPath(): string {
  return join(dirname(configPath()), 'autorefresh', 'seat-token');
}

/**
 * Provision a platform service's ledger seat + token (ADR 232 §5–§6) — best-effort, at install
 * time, with the OPERATOR's stored identity (they are running `service install`; the daemon's admin
 * gate decides). The token lands as a 0600 file under `~/.musterd/<home>/seat-token`; a tick that
 * speaks reads it back from the plist environment and never sees a binding — which is the point:
 * the tick runs in a folder bound to the operator, and inheriting that binding is the
 * misattribution the seat exists to end.
 *
 * ONE function for every platform service (lane 01M1Q9D90X). It was three copies — autorefresh,
 * guardian, streamwatch — and the three services that shipped WITHOUT a copy (wake host, /live
 * publisher, sweep) are exactly the three the census named as unattributed actors 23 days after
 * ADR 232 said `service install` would seat them. A seat is owed at install whether or not the tick
 * has anything to say yet: the roster is the census of what runs unattended here, and a silent
 * service is still an actor.
 *
 * Every failure is a meta line, never a hard stop: an unprovisioned service is exactly the pre-232
 * behaviour, and `install` must keep working on teams that haven't declared the seat.
 */
async function provisionServiceSeat(
  svc: {
    /** Roster seat name; also the LaunchAgent label suffix the census matches on. */
    name: string;
    /** Directory under `~/.musterd` that holds this service's token (and usually its stamp/logs). */
    home: string;
    /** The `musterd service install …` spelling that re-runs this. */
    rerun: string;
    /** What the operator loses while the seat is missing — one clause, in the failure line. */
    consequence: string;
  },
  ok: (s: string) => void,
  meta: (s: string) => void,
): Promise<void> {
  const config = loadConfig();
  const team = config.current;
  const identity = team ? config.identities[team] : undefined;
  if (!team || !identity) {
    meta(
      `  seat:    no current team identity — skipped the ${svc.name} service seat token (ADR 232); ` +
        `join your team, then rerun \`${svc.rerun}\``,
    );
    return;
  }
  try {
    const http = new HttpClient({ server: config.server, key: identity.key, surface: 'cli' });
    const res = (await http.addMember(team, {
      name: svc.name,
      kind: 'service',
      role: 'platform',
    })) as { token?: string };
    if (!res.token) throw new Error('daemon returned no token');
    const p = join(dirname(configPath()), svc.home, 'seat-token');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, res.token + '\n', { encoding: 'utf8', mode: 0o600 });
    ok(`minted the ${svc.name} service seat token → ${theme.accent(p)} (0600)`);
  } catch (err) {
    meta(
      `  seat:    could not provision the ${svc.name} service seat (${(err as Error).message}) — ` +
        `${svc.consequence}. For a file-backed roster, write seats/${svc.name}.toml ` +
        `(kind = "service", roles = ["platform"]) and rerun install.`,
    );
  }
}

/** The auto-refresher's seat (ADR 232 increment 1) — the first attributed unattended actor. */
function provisionAutoRefreshToken(
  ok: (s: string) => void,
  meta: (s: string) => void,
): Promise<void> {
  return provisionServiceSeat(
    {
      name: AUTOREFRESH_SEAT,
      home: 'autorefresh',
      rerun: 'musterd service install --auto',
      consequence: 'the tick will run unattributed (pre-ADR 232 behaviour)',
    },
    ok,
    meta,
  );
}

/**
 * The in-band bounce announcement (ADR 232 §2) — the seat the ADR 152 comment promised: on a REAL
 * bounce, and only then, the auto-refresher says what it did in the stream the team already reads.
 * Never on a no-op tick: the named failure mode is service chatter drowning the stream, and the fix
 * is quieter services, never filtering the stream by kind.
 *
 * Silent no-op when the seat isn't provisioned (no token file): an unprovisioned install stays
 * bit-identical to pre-232. A failed send is one meta line — the bounce already happened, and the
 * announcement must never turn a successful refresh into a failed tick.
 */
/**
 * The service seat's authenticated client, or null when unprovisioned. Null is the pre-232
 * posture — every caller must degrade to silence, never to a failed tick.
 */
function serviceSeatAuth(): { http: HttpClient; team: string } | null {
  const tokenFile = process.env['MUSTERD_SERVICE_TOKEN_FILE'] ?? serviceTokenPath();
  let token: string;
  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return null; // unprovisioned — pre-232 behaviour, silently
  }
  const config = loadConfig();
  const team = process.env['MUSTERD_SERVICE_TEAM'] ?? config.current;
  if (!token || !team) return null;
  return { http: new HttpClient({ server: config.server, key: token, surface: 'cli' }), team };
}

/**
 * The per-tick heartbeat (ADR 232 §3 amendment): one authenticated presence touch as the service
 * seat, on EVERY tick that finds the daemon reachable — including the ~99% that refresh nothing.
 *
 * §3 as written assumed the announcement alone would keep ambient presence fresh, but §2
 * correctly forbids idle-tick chatter, so a HEALTHY service's only authenticated call was the
 * rare bounce announcement and it read offline within minutes of working correctly. Silence can
 * only be signal if health is audible; this is the audible half, kept deliberately out of the
 * message stream (a presence row, never an envelope) so §2's no-chatter rule stays intact.
 *
 * Best-effort like the announcement: a failed touch is one meta line, never a failed tick.
 */
export async function touchServicePresence(ok: (s: string) => void): Promise<void> {
  const auth = serviceSeatAuth();
  if (!auth) return; // unprovisioned — pre-232 behaviour, silently
  try {
    await auth.http.presence(auth.team, 'cli');
  } catch (err) {
    ok(theme.meta(`presence touch failed (${(err as Error).message}) — the tick is unaffected`));
  }
}

async function announceRefreshBounce(
  sha: string,
  conns: number,
  ok: (s: string) => void,
): Promise<void> {
  const auth = serviceSeatAuth();
  if (!auth) return; // unprovisioned — pre-232 behaviour, silently
  const { http, team } = auth;
  const s = conns === 1 ? '' : 's';
  try {
    await http.send(
      team,
      makeEnvelope({
        id: ulid(),
        team,
        from: AUTOREFRESH_SEAT,
        to: { kind: 'team' },
        act: 'status_update',
        body: `bounced the daemon on ${sha}, ${conns} live session${s} notified`,
      }),
    );
    ok(`announced the bounce in-band as ${AUTOREFRESH_SEAT}`);
  } catch (err) {
    ok(
      theme.meta(
        `bounce announcement failed (${(err as Error).message}) — the refresh itself succeeded`,
      ),
    );
  }
}

/**
 * The daemon's CURRENT connection count, or 0 when it cannot be read.
 *
 * Unreachable means 0 on purpose — there is nothing to disrupt, which is the same reading
 * {@link guardLiveSessions} takes. What this must never do is reuse an earlier tick's count: the
 * whole defect this exists for is a decision made from a stale reading meeting a guard that takes a
 * fresh one.
 */
async function liveConnections(health: () => Promise<DaemonHealth>): Promise<number> {
  try {
    return (await health()).connections ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The one-line cause for the failure notice — the thrown error's first line, clipped.
 *
 * WHY THIS EXISTS. The notice used to assert "the refresh to <tip> did not build" for ANY throw out
 * of {@link refreshDaemon}, which spans git sync, install, build, restart and the health verify.
 * Measured 2026-08-12: a tick died at the git stage during a merge burst and told the operator the
 * tip "did not build" — while the log carried no `synced →` and no `building…` line for that tip,
 * because nothing was ever built. `main` compiled clean the whole time. The notice is the only
 * surface an unattended failure has, so an invented cause there sends whoever answers it to debug a
 * phantom break in a healthy tree, which is strictly worse than saying nothing.
 *
 * Every stage already throws a message naming itself (`fail(step, r)` → "<step> failed …", the
 * build's own CliError → "build failed …"). This carries that instead of overwriting it — the same
 * discipline as #761, where a claim timeout stopped blaming an approval nobody had requested: never
 * assert a cause the code does not know.
 *
 * First line only, because a notification body is a glance and the log keeps the full error (which
 * is what the trailing "See …refresh.log" points at).
 */
function failureCause(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split('\n')[0]?.trim() ?? '';
  if (!first) return 'no cause reported — see the log';
  return first.length <= 120 ? first : `${first.slice(0, 119)}…`;
}

/** File-backed outage marker for the ADR 230 escalation ladder — its own file beside the attempted-tip
 *  stamp, so the two lifecycles (a broken build vs. a dead daemon) can never overwrite each other. */
function fileOutageState(): { read: () => string | null; write: (s: string) => void } {
  const p = join(dirname(configPath()), 'autorefresh', '.outage');
  return {
    read: () => {
      try {
        return readFileSync(p, 'utf8').trim() || null;
      } catch {
        return null;
      }
    },
    write: (v: string) => {
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v, 'utf8');
      } catch {
        // best-effort: a marker we cannot persist degrades to "first miss every tick", which is
        // silent-and-safe (it never escalates), exactly like the pre-229 behaviour.
      }
    },
  };
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
 *      force-refreshes and fires an OS notice to the operator at the bounce itself, once the build
 *      has landed, so one merge is one notification (the announced, conscious bounce). The
 *      team-facing announcement lives with the `autorefresh` ledger seat now (ADR 232 — the seat
 *      the old comment here promised): a completed bounce lands in-band as an attributed
 *      status_update, and a no-op tick says nothing.
 *      With no live sessions, refresh straight through (the ADR 047 guard passes cleanly).
 */
/**
 * A dead daemon is not a success (ADR 230).
 *
 * The tick used to log `✓ unreachable — nothing to refresh` and exit 0 — the report of a healthy
 * no-op, used for an outage. Measured on the live machine 2026-08-04: **1,136 such ticks across 29
 * contiguous blocks** at the verified 120s interval, i.e. the only unattended actor on running
 * infrastructure reporting success in exactly the condition it exists to notice.
 *
 * Escalating needs TWO independent sources, never one probe — ADR 205 exists because a single
 * transient miss produced a false failure report, and repeating that here would fire a notification
 * during every ordinary bounce and train the operator to ignore the one channel that matters:
 *
 *   1. two CONSECUTIVE failed `/health` probes (~4 min at the tick interval), counted in a store
 *      that survives across ticks (each tick is a separate launchd invocation); and
 *   2. `launchctl` agreeing the job is not running — a different source, not a second opinion from
 *      the same one. A daemon mid-restart fails a probe while launchctl is content; that is normal.
 *
 * On confirmation: ONE OS notice, then it stands down until the outage ends. **Deliberately no
 * restart** — re-evaluated with nick 2026-08-04, the same day ADR 227 shipped "only designated
 * platform agents touch running infrastructure": this tick has no seat, no role, and no identity
 * (the infra-gate cannot even see it — an unbound context is silence by design), so granting it
 * restart autonomy would make the role system's biggest infra toucher the one actor outside the
 * role system. Restart autonomy arrives through the automated-actors-under-roles design (the seed
 * doc's autonomy-tiers-as-team-policy question) or not at all. It also never spends a wake: a woken
 * seat would coordinate through the daemon that is down.
 */
async function handleUnreachable(
  ctx: ServiceCtx,
  notify: (n: { id: string; title: string; body: string }) => void,
  outageState: { read: () => string | null; write: (s: string) => void },
  ok: (s: string) => void,
): Promise<number> {
  const prior = outageState.read() ?? '';
  // Already escalated in this outage — say nothing further and touch nothing. The stop rule.
  if (prior.startsWith('down:notified')) {
    ok('daemon still unreachable — already notified this outage, standing down');
    return 0;
  }
  // First miss: record the run and wait for corroboration. A single probe is a shrug.
  if (!prior.startsWith('down:')) {
    outageState.write('down:1');
    ok('daemon unreachable — one failed probe, waiting for a second before calling it down');
    return 0;
  }
  // Second consecutive miss. Ask the independent source before acting.
  if (!jobIsDown(ctx)) {
    ok(
      'daemon unreachable, but launchctl reports the job running — holding off ' +
        '(a bouncing daemon looks like this; one source is never enough)',
    );
    return 0;
  }

  outageState.write('down:notified');
  notify({
    id: 'musterd-daemon-down',
    title: 'musterd daemon is down',
    // Self-contained on purpose: a push body is read on a lock screen where the title may be
    // truncated or absent, so it names WHAT is down rather than relying on "it".
    body: 'The musterd daemon stopped answering /health and launchctl shows the job not running. Run: musterd service restart',
  });
  ok(
    `daemon down (confirmed: 2 consecutive failed probes + launchctl) — notified the operator, standing down`,
  );
  return 0;
}

/**
 * Does `launchctl` agree the daemon job is not running? The independent second source behind the
 * ADR 230 confirmation. `launchctl print` exits non-zero when the service is unknown/unloaded; a
 * loaded-but-crashlooping job still prints, so this is deliberately the CONSERVATIVE half — it says
 * "down" only when launchd itself has nothing running, and a false "up" merely withholds an
 * escalation rather than causing one.
 */
function jobIsDown(ctx: ServiceCtx): boolean {
  return ctx.run('launchctl', ['print', `gui/${String(ctx.uid)}/${ctx.label}`]).status !== 0;
}

async function autoRefreshTick(
  ctx: ServiceCtx,
  health: () => Promise<DaemonHealth>,
  mode: AutoRefreshMode,
  settle: { seconds: number; capSeconds: number; quietFloorSeconds: number },
  notify: (n: { id: string; title: string; body: string }) => void,
  autoState: { read: () => string | null; write: (sha: string) => void },
  outageState: { read: () => string | null; write: (s: string) => void },
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
  touch: (ok: (s: string) => void) => Promise<void> = touchServicePresence,
): Promise<number> {
  const dir = daemonCheckout(ctx) ?? ctx.workingDir;
  let health0: DaemonHealth;
  try {
    health0 = await health();
  } catch {
    return handleUnreachable(ctx, notify, outageState, ok);
  }
  // Reachable: whatever outage we were tracking is over (ADR 230). Clearing here — rather than only
  // on the up-to-date path — is what makes the run counter mean "consecutive", so a blip between two
  // healthy ticks can never accumulate into a false confirmation.
  if (outageState.read()) outageState.write('');
  // The §3-amendment heartbeat: one authenticated presence touch per reachable tick, so a healthy
  // interval service reads present-with-freshness instead of offline-in-minutes. Before the skew
  // gates on purpose — every no-op exit below is still a live, correctly-working service. The
  // catch enforces the amendment's contract at the seam: a heartbeat can never fail the tick.
  await touch(ok).catch(() => {});
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
  // The settle window: main is still moving, so wait for the burst rather than bouncing per commit
  // (each bounce costs every live seat a reconnect). Checked AFTER the debounce so a failed build
  // still parks, and BEFORE any build so a deferred tick is genuinely free. Said out loud, because a
  // silent wait is indistinguishable from the stuck daemon this whole surface exists to make visible.
  const nowSec = Math.floor(Date.now() / 1000);
  const tipTime = commitTime(dir, 'origin/main', ctx.run);
  const oldestTime = commitTime(dir, 'origin/main', ctx.run, health0.build);
  const tipAgeSeconds = tipTime === null ? null : nowSec - tipTime;
  const oldestAgeSeconds = oldestTime === null ? null : nowSec - oldestTime;
  if (
    shouldWaitForSettle({
      tipAgeSeconds,
      oldestAgeSeconds,
      settleSeconds: settle.seconds,
      capSeconds: settle.capSeconds,
    })
  ) {
    const mins = (n: number) => `${Math.round(n / 60)}m`;
    ok(
      `origin/main is still moving (newest commit ${mins(tipAgeSeconds ?? 0)} old, settling for ` +
        `${mins(settle.seconds)}) — holding the bounce so a merge burst costs one restart, not one ` +
        `per commit. Will refresh once the tip holds still, or after ${mins(settle.capSeconds)} behind.`,
    );
    return 0;
  }
  // The quiet floor (quiescence inc 2): main has settled — now land the restart in a lull rather
  // than mid-tool-call. Reads /health's quietest_busy_ms (audit-derived, agents only). The same
  // staleness cap forces through this gate too; unknown (absent field) bounces.
  if (
    shouldWaitForQuiet({
      quietestBusyMs: health0.quietest_busy_ms,
      oldestAgeSeconds,
      floorSeconds: settle.quietFloorSeconds,
      capSeconds: settle.capSeconds,
    })
  ) {
    ok(
      `a seat is actively working (last action ${Math.round((health0.quietest_busy_ms ?? 0) / 1000)}s ` +
        `ago; quiet floor ${settle.quietFloorSeconds}s) — holding the bounce for a lull. ` +
        `The staleness cap (${Math.round(settle.capSeconds / 60)}m) still forces a refresh.`,
    );
    return 0;
  }
  const s = (n: number) => (n === 1 ? '' : 's');
  const conns = health0.connections ?? 0;
  if (conns > 0 && mode === 'idle') {
    ok(`${conns} live session${s(conns)} connected — deferring refresh (idle mode); will retry`);
    return 0;
  }
  // Notice mode means "tell them, then bounce", so it ALWAYS forces — decoupled from `conns`, which
  // now decides only whether there is anyone to announce to. They were one expression, and that
  // conflation cost 35 minutes on 2026-08-12: a health probe blipped, `health0.connections` came
  // back absent, `conns` read 0, `force` computed false — and then `guardLiveSessions` took its own
  // FRESH reading, found the 1 session that had reconnected, and refused the bounce it was never
  // meant to refuse in notice mode. A decision made from a stale count cannot survive a guard that
  // re-reads; the only fix is to stop deriving the decision from the count.
  const force = mode === 'notice';
  // Announced at the bounce, not at the decision: the announcement is "your session is about to
  // reconnect", which is only true once the sync and build have landed. Firing it up front made one
  // merge cost the operator up to three notifications — announce, failure, then announce again on
  // the retry — for a daemon that never moved (#631). Gated on `conns` rather than `force`: with
  // nobody connected there is no reconnect to warn about.
  const announce =
    force && conns > 0
      ? () => {
          notify({
            id: 'musterd-autorefresh',
            title: 'musterd auto-refresh',
            body: `Updating the daemon to latest main (${behind} commit${s(behind)} behind); ${conns} live session${s(conns)} will briefly reconnect.`,
          });
          ok(`${conns} live session${s(conns)} — notified the operator, forcing the bounce`);
        }
      : undefined;
  // A live-session refusal is a HOLD, not a failure, so it is settled BEFORE the attempt is stamped.
  // `guardLiveSessions` re-reads health, so it can refuse on evidence this tick never saw — and on
  // 2026-08-12 that refusal was stamped as an attempt and notified as a build failure, parking the
  // tip until an unrelated merge cleared it. 35 minutes pinned, on a daemon whose only problem was
  // that somebody was using it. A hold must retry; only a failure may debounce.
  if (!force) {
    const live = await liveConnections(health);
    if (live > 0) {
      ok(
        `${live} live session${s(live)} connected — holding the refresh (idle mode); ` +
          `the tip stays unstamped, so the next tick retries`,
      );
      return 0;
    }
  }
  if (tip) autoState.write(tip); // mark the attempt BEFORE building, so a failed build debounces next tick
  try {
    const code = await refreshDaemon(ctx, health, force, ok, fail, undefined, health0, announce);
    // The bounce landed and the daemon verified up — say so IN-BAND, as the service seat
    // (ADR 232 §2). After the verify on purpose: announcing a bounce that didn't happen is the
    // same lie the OS notice was moved off of (#631).
    if (code === 0) await announceRefreshBounce(tip.slice(0, 7), conns, ok);
    return code;
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
        `failed: ${failureCause(err)}. Nothing will retry until a new commit lands. ` +
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
const GUARDIAN_SEAT = 'guardian';

function guardianHome(): string {
  return join(dirname(configPath()), 'guardian');
}

/**
 * The guardian probe's LaunchAgent ctx (2026-08-13 guardian spec §1) — the autorefresh shape
 * verbatim (same lifecycle module), pointed at `service guardian-tick`. Outside the daemon and
 * autorefresh, both of which it watches; ~2-minute cadence; token file rides the plist env so the
 * tick attributes as the `guardian` service seat, never a folder binding (ADR 232 §5).
 */
function resolveGuardianCtx(run: Runner, parsed: Parsed): AutoRefreshCtx {
  const binJs = resolvePath(process.argv[1] ?? '');
  const home = dirname(configPath());
  const interval = flagStr(parsed.flags, 'interval');
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : '',
    label: GUARDIAN_LABEL,
    plistPath: join(homedir(), 'Library', 'LaunchAgents', `${GUARDIAN_LABEL}.plist`),
    node: agentNode(),
    binJs,
    refreshArgs: ['guardian-tick'],
    workingDir: resolvePath(binJs, '../../../..'),
    logPath: join(home, 'guardian', 'guardian.log'),
    errLogPath: join(home, 'guardian', 'guardian.log'),
    // The tick shells `launchctl` + (on remediation) the CLI's own `service` verbs, which shell
    // `git`/`pnpm` — same PATH needs as the autorefresh tick.
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
    intervalSeconds: interval ? Number(interval) : 120,
    env: { MUSTERD_SERVICE_TOKEN_FILE: join(home, 'guardian', 'seat-token') },
    run,
  };
}

/** The guardian probe's seat (ADR 263) — token at `~/.musterd/guardian/seat-token`. */
function provisionGuardianToken(ok: (s: string) => void, meta: (s: string) => void): Promise<void> {
  return provisionServiceSeat(
    {
      name: GUARDIAN_SEAT,
      home: 'guardian',
      rerun: 'musterd service --guardian install',
      consequence: 'the probe will run unattributed',
    },
    ok,
    meta,
  );
}

async function guardianServiceCommand(
  sub: string,
  gCtx: AutoRefreshCtx,
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
): Promise<number> {
  const meta = (s: string) => process.stdout.write(theme.meta(s) + '\n');
  switch (sub) {
    case 'install': {
      const res = installAutoRefresh(gCtx);
      if (res.status !== 0) fail('guardian (bootstrap)', res);
      ok(`installed + started the guardian probe (${theme.accent(gCtx.label)})`);
      await provisionGuardianToken(ok, meta);
      meta(`  runs:    musterd service guardian-tick every ${gCtx.intervalSeconds}s`);
      meta(`  logs:    ${gCtx.logPath}`);
      // Instrument-silence control probe: before believing this probe's future silence, make it
      // observe an incident we cause — a fixture publisher failure through the real alert path,
      // dry-run (no daemon touched, no ask sent).
      const probed = await runGuardianTick(
        { run: gCtx.run } as ServiceCtx,
        { flags: { 'control-probe': true }, positionals: [] } as unknown as Parsed,
      );
      if (probed !== 0) fail('guardian control probe', { status: probed, stdout: '', stderr: '' });
      return 0;
    }
    case 'uninstall': {
      const res = uninstallAutoRefresh(gCtx);
      ok(
        res.removedPlist
          ? 'stopped + removed the guardian probe'
          : 'guardian probe was not installed — nothing to remove',
      );
      return 0;
    }
    case 'status': {
      const st = statusAutoRefresh(gCtx);
      ok(
        `guardian probe: ${
          st.loaded ? theme.ok(intervalAgentLabel(st) ?? 'loaded') : theme.warn('not installed')
        }`,
      );
      const dead = agentFailureNote(st, agentProgramExists(gCtx.plistPath));
      if (dead) process.stdout.write(`  ${theme.err('✗')} ${dead}\n`);
      meta(`  ${guardianStatusLine(join(guardianHome(), 'stamp.json'), Date.now())}`);
      return 0;
    }
    default:
      throw new CliError(
        'usage: musterd service <install|uninstall|status> --guardian [--interval <s>]',
        2,
      );
  }
}

/**
 * One guardian tick (`service guardian-tick`) — assemble the real runners and hand them to the
 * injected-deps tick. `--control-probe` swaps the collector for a fixture publisher failure and
 * the actors for dry-run captures: the alert path fires observably, nothing real is touched.
 */
async function runGuardianTick(ctx: ServiceCtx, parsed: Parsed): Promise<number> {
  const home = dirname(configPath());
  const gHome = guardianHome();
  const controlProbe = parsed.flags['control-probe'] === true;
  /**
   * A scheduled tick persists because the plist redirects stdout to the guardian log; the
   * install-time control probe's stdout is the operator's terminal, so its ONE firing used to
   * survive only in scrollback (miley, 2026-08-13). ADR 263 §7 makes that probe the
   * instrument-silence defense and the Eval's dataset is "the guardian log + the message stream +
   * nick's own discovery reports" — evidence in none of the three cannot be cited. So the probe
   * appends to the ledger itself, in the same `guardian.<action> {json}` shape and the same file
   * scheduled ticks write, and stays a dry run: nothing here touches incident or damping state.
   */
  const log = (l: string) => {
    const line = `${stamp()} ${l}\n`;
    process.stdout.write(line);
    if (!controlProbe) return;
    try {
      mkdirSync(gHome, { recursive: true });
      appendFileSync(join(gHome, 'guardian.log'), line);
    } catch {
      // Evidence is best-effort: an unwritable log must never fail the install it documents.
    }
  };

  const probeHealth = async (timeoutMs: number): Promise<HealthPayload> => {
    const server = loadConfig().server;
    const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`health ${res.status}`);
    return (await res.json()) as HealthPayload;
  };
  /** The fast probe: three of these, 1 s apart, are ADR 274's confirmation. */
  const rawHealth = (): Promise<HealthPayload> => probeHealth(2000);
  /** The DIFFERENT observation — same request, on whatever bound the collector asks for. */
  const confirmHealth = probeHealth;

  /** mtime-gated read: a file untouched since `epochMs` contributes nothing (recency hard rule);
   *  a touched file contributes its tail (cap 400 lines — bounded work on an 8 GB machine). */
  const readSince = async (path: string, epochMs: number): Promise<string[]> => {
    try {
      const { statSync } = await import('node:fs');
      if (statSync(path).mtimeMs < epochMs) return [];
      return readFileSync(path, 'utf8').split('\n').slice(-400);
    } catch {
      return [];
    }
  };
  const statMtime = async (path: string): Promise<number | null> => {
    try {
      const { statSync } = await import('node:fs');
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  };

  const collect = controlProbe
    ? async () => ({
        now: Date.now(),
        health: {
          ok: true,
          bootedAt: Date.now() - 60_000,
          schemaOk: true,
          dbPathExpected: true,
        },
        launchd: { lastExit: 0, runs: 1 },
        publisherLog: { freshFailure: true },
        errLinesSinceBoot: 0,
        httpErrorRateSinceBoot: 0,
        reaperStormSinceBoot: false,
        lastRefreshAt: null,
      })
    : async () =>
        collectSignals({
          now: () => Date.now(),
          fetchHealth: rawHealth,
          confirmHealth,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          launchctlPrint: async () => {
            const uid = typeof process.getuid === 'function' ? process.getuid() : '';
            return ctx.run('launchctl', printArgs(uid, SERVICE_LABEL)).stdout;
          },
          readSince,
          statMtime,
          /**
           * `sample <pid> <seconds>` — read-only, bounded, no signal sent (ADR 389 §1). Given a
           * hard timeout of its own beyond the sampler's own bound: the tool is the guardian's
           * evidence, and evidence that can hang is a second way for the probe to go quiet.
           *
           * macOS only, and its absence is a first-class answer: on any other host `sample` is not
           * on PATH, the run fails, and the collector records "not taken" with the reason. The
           * class is simply unreachable there and the posture stays exactly today's.
           *
           * Spawned here rather than through `ctx.run` for the timeout alone — `Runner` takes no
           * options, and widening the shared type for this one call would touch every fake that
           * implements it. Every other shell-out in this tick is a launchctl read that returns.
           */
          sampleStack: async (pid, seconds) => {
            const r = spawnSync('sample', [String(pid), String(seconds)], {
              encoding: 'utf8',
              timeout: (seconds + 5) * 1000,
            });
            if (r.error) throw r.error;
            if (r.status !== 0)
              throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
            return r.stdout;
          },
          expected: { dbPath: join(home, 'musterd.db'), schema: null },
          daemonErrLogPath: join(home, 'daemon.err.log'),
          publisherBuildLogPath: join(home, 'live', 'build.log'),
          publisherOkStampPath: join(gHome, 'publisher.ok'),
          lastRefreshAt: async () => statMtime(join(home, 'autorefresh', '.attempted-sha')),
          readHandover: async () => readHandover(refreshHandoverPath(), Date.now()),
        });

  const auth = serviceSeatAuth();
  return guardianTick({
    now: () => Date.now(),
    stampPath: join(gHome, 'stamp.json'),
    collect,
    getTiers: async () => {
      // Scoped member read (ADR 263 follow-up) — the full policy is admin-only, which is exactly
      // why the first armed build fell back to defaults on every tick.
      if (!auth) return { tiers: DEFAULT_TIERS, source: 'shipped_default_unprovisioned' };
      const { guardian_tiers } = await auth.http.getGuardianTiers(auth.team);
      return { tiers: resolveGuardianTiers(guardian_tiers), source: 'team_policy' };
    },
    healthBuild: async () => (await rawHealth()).build ?? null,
    act: async (incidents, actStamp, tiers) => {
      const report = await actOn(incidents, {
        now: () => Date.now(),
        stamp: actStamp,
        tiers: controlProbe ? { ...DEFAULT_TIERS, publisher_failed: 'alert' } : tiers,
        // The probe must fire on every install and leave damping state alone (see ActDeps).
        dampRaises: !controlProbe,
        runService: async (args) => {
          if (controlProbe) {
            log(`control probe: would run service ${args.join(' ')}`);
            return { ok: true };
          }
          const r = ctx.run(process.execPath, [
            resolvePath(process.argv[1] ?? ''),
            'service',
            ...args,
          ]);
          return { ok: r.status === 0 };
        },
        osNotify: (n) => {
          if (controlProbe) log(`control probe: alert path fired ✓ ("${n.title}")`);
          else {
            osNotify(n);
            log(`notified the operator: "${n.title}" — ${n.body}`);
          }
        },
        sendAsk: async (body) => {
          if (controlProbe) return;
          if (!auth) return; // unprovisioned — OS notify already fired; degrade silently (ADR 232)
          await auth.http.send(
            auth.team,
            makeEnvelope({
              id: ulid(),
              team: auth.team,
              from: GUARDIAN_SEAT,
              to: { kind: 'team' },
              act: 'ask',
              body,
              meta: { species: 'consult', tier: 'standard' },
            }),
          );
        },
        audit: async (action, detail) => {
          // No client-writable audit endpoint exists; the guardian's ledger is its own log plus
          // the attributed acts above. One structured line per action, greppable.
          log(`${action} ${JSON.stringify(detail)}`);
        },
        log,
      });
      return report;
    },
    heartbeat: async () => {
      if (controlProbe || !auth) return;
      await auth.http.send(
        auth.team,
        makeEnvelope({
          id: ulid(),
          team: auth.team,
          from: GUARDIAN_SEAT,
          to: { kind: 'team' },
          act: 'status_update',
          body: 'guardian: on watch (daily heartbeat) — all classes quiet',
        }),
      );
    },
    log,
  });
}

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
      await provisionAutoRefreshToken(ok, meta);
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
      // `intervalAgentLabel`, not the raw launchd `state`: this agent is a periodic one-shot, so its
      // healthy steady state is literally `not running`, and printing that after a ✓ read as an
      // outage to the one person who most needed to trust this line (2026-08-03).
      ok(
        `daemon auto-refresher: ${
          st.loaded ? theme.ok(intervalAgentLabel(st) ?? 'loaded') : theme.warn('not installed')
        }`,
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
/** The `--stream` lifecycle (ADR 293): install/uninstall/status for the supervisor LaunchAgent,
 * plus minting the `streamwatch` service seat whose token carries the stand-down ask. */
async function streamwatchServiceCommand(
  sub: string,
  ctx: StreamwatchCtx,
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
): Promise<number> {
  const meta = (s: string) => process.stdout.write(theme.meta(s) + '\n');
  switch (sub) {
    case 'install': {
      const res = installStreamwatch(ctx);
      if (res.status !== 0) fail('stream supervisor (bootstrap)', res);
      ok(`installed + started the stream supervisor (${theme.accent(ctx.label)})`);
      await provisionStreamwatchToken(ok, meta);
      meta(`  runs:    musterd stream ensure every ${ctx.intervalSeconds}s`);
      meta(`  policy:  crash → restart, 3/30min → stand down + ask; \`stream stop\` always wins`);
      meta(`  logs:    ${ctx.logPath} (findings only — a healthy tick is silent)`);
      return 0;
    }
    case 'uninstall': {
      const res = uninstallStreamwatch(ctx);
      ok(
        res.removedPlist
          ? 'stopped + removed the stream supervisor (the desired-state file is kept)'
          : 'stream supervisor was not installed — nothing to remove',
      );
      return 0;
    }
    case 'status': {
      const st = statusStreamwatch(ctx);
      ok(
        `stream supervisor: ${
          st.loaded ? theme.ok(intervalAgentLabel(st) ?? 'loaded') : theme.warn('not installed')
        }`,
      );
      const dead = agentFailureNote(st, agentProgramExists(ctx.plistPath));
      if (dead) process.stdout.write(`  ${theme.err('✗')} ${dead}\n`);
      meta(`  runs:  musterd stream ensure every ${ctx.intervalSeconds}s`);
      meta(`  logs:  ${ctx.logPath}`);
      return 0;
    }
    default:
      throw new CliError(
        'usage: musterd service <install|uninstall|status> --stream [--interval <s>]',
        2,
      );
  }
}

/** The stream watchdog's seat — token at `~/.musterd/stream/seat-token`. */
function provisionStreamwatchToken(
  ok: (s: string) => void,
  meta: (s: string) => void,
): Promise<void> {
  return provisionServiceSeat(
    {
      name: 'streamwatch',
      home: 'stream',
      rerun: 'musterd service install --stream',
      consequence: 'a stand-down will be logged but not asked',
    },
    ok,
    meta,
  );
}

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
      await provisionServiceSeat(
        {
          name: 'sweep',
          home: 'sweep',
          rerun: 'musterd service install --sweep',
          consequence: 'the sweep runs as an unattributed actor and the census will say so',
        },
        ok,
        meta,
      );
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
      await provisionServiceSeat(
        {
          name: 'live',
          home: 'live',
          rerun: 'musterd service install --live',
          consequence: 'the publisher runs as an unattributed actor and the census will say so',
        },
        ok,
        meta,
      );
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
      await provisionServiceSeat(
        {
          name: 'host',
          home: 'host',
          rerun: 'musterd service install --wake',
          consequence: 'the actuator runs as an unattributed actor and the census will say so',
        },
        ok,
        meta,
      );
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
  // Not just the URL — where it came from. This reader is machine-global by construction, so when
  // the default is wrong it reports a healthy daemon as unreachable with total confidence.
  const provenance = serverProvenance(ctx.workingDir);
  const server = provenance.server;
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
        ? theme.ok(`up`) +
          theme.meta(` · ${server} (${provenance.source}) · ${health.db} (schema ${health.schema})`)
        : theme.err('unreachable') + theme.meta(` · ${server} (${provenance.source})`)
    }\n`,
  );
  // The one line that ends the 2026-08-12 diagnosis in seconds: this folder uses a different daemon
  // than the one just measured, so "unreachable" above is a statement about somebody else's port.
  if (provenance.disagreeingBinding) {
    process.stdout.write(
      `  ${theme.warn('!')} this folder is bound to ${theme.accent(provenance.disagreeingBinding.server)} ` +
        `(${provenance.disagreeingBinding.team}) — the line above measured the ${provenance.source}, not your seat\n`,
    );
  }
  // Guardian (spec §6): the probe's own liveness, from its stamp — a dead guardian must be
  // distinguishable from a quiet one, in the same place the daemon's health is read.
  process.stdout.write(
    theme.meta(`  ${guardianStatusLine(join(guardianHome(), 'stamp.json'), Date.now())}`) + '\n',
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
    const autoRefresh = statusAutoRefresh(
      resolveAutoRefreshCtx(ctx.run, { flags: {}, positionals: [], metaPairs: [] }),
    );
    const ownership = autoRefreshOwnership(ctx.workingDir, ctx.run, autoRefresh);
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
