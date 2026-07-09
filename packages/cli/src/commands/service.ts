import { spawn, spawnSync } from 'node:child_process';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { flagStr, type Parsed } from '../args.js';
import { configPath, loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { SERVICE_LABEL, serviceSupported } from '../service/launchd.js';
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
  };
}

const USAGE =
  'usage: musterd service <install|uninstall|start|stop|restart|refresh|status|logs> [--port <n>] [--host <h>] [--follow] [--force]';

/** Fetch the daemon's `/health` (ADR 016 + 047): the live `connections` count drives the guard below. */
async function fetchHealth(): Promise<{ connections?: number }> {
  const server = loadConfig().server;
  const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return (await res.json()) as { connections?: number };
}

/**
 * Guard the destructive `service` verbs (ADR 047): refuse to bounce a *shared* daemon while other
 * members hold live sessions, so a restart is a conscious choice, not a silent teammate-drop.
 * Fail-open — if `/health` is unreachable the daemon's already down and can't be disrupting anyone,
 * so let the verb through. `--force` is the universal override.
 */
async function guardLiveSessions(
  health: () => Promise<{ connections?: number }>,
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
    health?: () => Promise<{ connections?: number }>;
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

  switch (sub) {
    case 'install': {
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
      return renderStatus(ctx);
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
async function refreshDaemon(
  ctx: ServiceCtx,
  health: () => Promise<{ connections?: number }>,
  force: boolean,
  ok: (s: string) => void,
  fail: (step: string, r: RunResult) => never,
): Promise<number> {
  const dir = ctx.workingDir;
  const git = (...args: string[]): RunResult => ctx.run('git', ['-C', dir, ...args]);

  if (git('rev-parse', '--is-inside-work-tree').status !== 0) {
    throw new CliError(
      `${dir} is not a git checkout — \`service refresh\` rebuilds the daemon from its own source, ` +
        `which only works when the daemon runs from a repo (it runs from ${ctx.binJs}).`,
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

async function renderStatus(ctx: ServiceCtx): Promise<number> {
  const st = status(ctx);
  const server = loadConfig().server;
  let health: { v?: string; db?: string; schema?: number } | undefined;
  try {
    const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) health = (await res.json()) as typeof health;
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
