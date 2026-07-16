import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { flagStr, type Parsed } from '../args.js';
import { configPath, loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { loadHostRegistry } from '../host/registry.js';
import { theme } from '../render/theme.js';
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
  HOST_LABEL,
  LIVE_LABEL,
  LIVE_SYNC_LABEL,
  parsePlistProgramArguments,
  SERVICE_LABEL,
  serviceSupported,
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

/** Shell out to `launchctl` synchronously, capturing output and never throwing on a non-zero exit. */
const spawnRunner: Runner = (cmd, args): RunResult => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

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
  const node = process.execPath;
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
  'usage: musterd service <install|uninstall|start|stop|restart|refresh|status|logs> [--live | --wake] [--port <n>] [--host <h>] [--interval <s>] [--timeout <s>] [--follow] [--force]';

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
    node: process.execPath,
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

function resolveLiveCtx(run: Runner): LiveCtx {
  const binJs = resolvePath(process.argv[1] ?? '');
  const repoRoot = resolvePath(binJs, '../../../..');
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
 * Name the running daemon's build skew against `origin/main` (ADR 130) — the detector half of
 * `service refresh`. Best-effort by design: the daemon may not run from a checkout, the fetch may be
 * offline, the commit may be unknown locally — every failure degrades to just naming the build ref.
 * `status` must never fail because of this check (watcher, never gatekeeper).
 */
export function buildSkewNote(build: string, dir: string, run: Runner): string {
  // A stamped build can carry a `-dirty` suffix (ADR 135) — keep it in the display (an honest "built
  // from uncommitted edits" flag) but strip it before any git plumbing: `rev-list abc-dirty..` fails,
  // which would silently degrade the skew verdict for exactly the builds most likely to be skewed.
  const sha = build.replace(/-dirty$/, '');
  const short = build.slice(0, 7) + (build.endsWith('-dirty') ? '-dirty' : '');
  const git = (...args: string[]): RunResult => run('git', ['-C', dir, ...args]);
  if (git('rev-parse', '--is-inside-work-tree').status !== 0) return short;
  git('fetch', 'origin', 'main', '--quiet'); // best-effort — offline still compares the last-known tip
  const counted = git('rev-list', '--count', `${sha}..origin/main`);
  if (counted.status !== 0) return short; // unknown commit / no origin/main — no verdict
  const behind = Number(counted.stdout.trim());
  if (!Number.isFinite(behind)) return short;
  if (behind === 0) return `${short} ${theme.meta('· up to date with origin/main')}`;
  return (
    `${short} · ` +
    theme.warn(
      `⚠ ${behind} commit${behind === 1 ? '' : 's'} behind origin/main — run \`musterd service refresh\``,
    )
  );
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
    health?: () => Promise<DaemonHealth>;
    /** Probe whether the daemon serves /live (injected so tests skip the network). */
    probeViewer?: (url: string) => Promise<boolean>;
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
  const ctx = deps.ctx ?? resolveCtx(serveArgs);
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
    const liveCtx = deps.liveCtx ?? resolveLiveCtx(ctx.run);
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
            `needs Node >=22. Put a matching node first on PATH and re-run, e.g.\n` +
            `  export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && musterd service install\n\n` +
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
      process.stdout.write(theme.meta(`  logs:  ${ctx.stdoutPath}`) + '\n');
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
      return 0;
    }
    case 'refresh':
      return refreshDaemon(ctx, health, force, ok, fail);
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

async function refreshDaemon(
  ctx: ServiceCtx,
  health: () => Promise<DaemonHealth>,
  force: boolean,
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
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
  return 0;
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
            `  export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && musterd service install --wake\n\n` +
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

  const loaded = st.loaded
    ? theme.ok(`loaded${st.pid ? ` · pid ${st.pid}` : ''}${st.state ? ` · ${st.state}` : ''}`)
    : theme.warn('not loaded');
  process.stdout.write(`${theme.accent(ctx.label)}  ${loaded}\n`);
  process.stdout.write(theme.meta(`  plist:  ${ctx.plistPath}`) + '\n');
  process.stdout.write(
    `  ${theme.meta('health:')} ${
      health
        ? theme.ok(`up`) + theme.meta(` · ${server} · ${health.db} (schema ${health.schema})`)
        : theme.err('unreachable') + theme.meta(` · ${server}`)
    }\n`,
  );
  // Build provenance + skew (ADR 130): the running daemon names its commit; we name the gap.
  if (health?.build) {
    process.stdout.write(
      `  ${theme.meta('build:')}  ${buildSkewNote(health.build, ctx.workingDir, ctx.run)}\n`,
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
