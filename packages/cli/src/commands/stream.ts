/**
 * `musterd stream` — go live from a rented machine, in one verb.
 *
 * The hosted broadcast worked on 2026-07-27, and going live still cost five manual setup steps, an
 * environment variable, a shell script and a hand-edited LaunchAgent plist. nick's ask, verbatim:
 * *"We will need an extremely simple flow to do all of this stuff btw."* This is that flow — it
 * absorbs `scripts/broadcast/live.sh` and puts a `doctor` in front of it.
 *
 * `doctor` is the centrepiece, not a courtesy. Four launches failed that day, and every one
 * presented as the same unhelpful line — *"the broadcast page never reported ready"* — while the
 * actual cause was a missing `tailscale serve` forward, a daemon that wasn't allow-listing the
 * tailnet `Host`, an app config the builder demanded, or a tag that resolved to a stale digest.
 * Preconditions that fail invisibly need a command that makes them visible, with the repair printed.
 *
 * Sibling to `musterd broadcast`, not a mode of it: `broadcast` captures and encodes on **this**
 * machine; `stream` runs that same capture on a **rented** one and manages its lifetime. Different
 * failure modes, different preconditions, so a different verb.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Parsed } from '../args.js';
import {
  DEFAULT_APP,
  digestPath,
  findRepoRoot,
  parsePushedDigest,
  probeUpgradeHost,
  parseTailscaleSelf,
  readDigest,
  realExec,
  REGION,
  runChecks,
  startedMachines,
  VM_SIZE,
  type Check,
  type Exec,
} from '../broadcast/hosted.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

const USAGE =
  'usage: musterd stream <doctor|build|start|stop|status> [--app <name>] [--team <slug>] [--json]';

export interface StreamDeps {
  exec?: Exec;
  probeUpgrade?: (hostHeader: string) => Promise<'allowed' | 'rejected' | 'unreachable'>;
  cwd?: string;
  /** Where the daemon listens, for the upgrade probe. Defaults to the configured server. */
  server?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/** The daemon's loopback origin — the upgrade probe aims here and spoofs only the `Host` header. */
function daemonOrigin(server: string): { hostname: string; port: number } {
  try {
    const u = new URL(server);
    return { hostname: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) };
  } catch {
    return { hostname: '127.0.0.1', port: 4849 };
  }
}

export async function streamCommand(parsed: Parsed, deps: StreamDeps = {}): Promise<number> {
  const sub = parsed.positionals[0];
  if (!sub) throw new CliError(USAGE, 2);

  const exec = deps.exec ?? realExec;
  const cwd = deps.cwd ?? process.cwd();
  const server = deps.server ?? loadConfig().server;
  const origin = daemonOrigin(server);
  const probeUpgrade =
    deps.probeUpgrade ?? ((hostHeader: string) => probeUpgradeHost(origin, hostHeader));
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  const app = typeof parsed.flags['app'] === 'string' ? parsed.flags['app'] : DEFAULT_APP;
  const repoRoot = findRepoRoot(cwd);

  switch (sub) {
    case 'doctor':
      return doctorVerb({
        exec,
        probeUpgrade,
        app,
        port: origin.port,
        repoRoot,
        out,
        json: parsed.flags['json'] === true,
      });
    case 'build':
      return buildVerb({ exec, app, repoRoot, out });
    case 'start':
      return startVerb({ exec, app, repoRoot, parsed, out, err });
    case 'stop':
      return stopVerb({ exec, app, out });
    case 'status':
      return statusVerb({ exec, app, out });
    default:
      throw new CliError(`unknown subcommand \`${sub}\`\n${USAGE}`, 2);
  }
}

// ── doctor ───────────────────────────────────────────────────────────────────────────────────────

async function doctorVerb(a: {
  exec: Exec;
  probeUpgrade: (h: string) => Promise<'allowed' | 'rejected' | 'unreachable'>;
  app: string;
  port: number;
  repoRoot: string | null;
  out: (s: string) => void;
  json: boolean;
}): Promise<number> {
  const checks = await runChecks({
    exec: a.exec,
    probeUpgrade: a.probeUpgrade,
    app: a.app,
    port: a.port,
    repoRoot: a.repoRoot,
    digest: readDigest(a.repoRoot),
  });
  const failed = checks.filter((c) => c.state === 'fail');

  if (a.json) {
    a.out(JSON.stringify({ ok: failed.length === 0, checks }) + '\n');
    return failed.length === 0 ? 0 : 1;
  }

  a.out(`${theme.accent('stream doctor')} ${theme.meta(`— ${a.app}`)}\n\n`);
  for (const c of checks) a.out(renderCheck(c));

  if (failed.length === 0) {
    a.out(`\n${theme.ok('✓')} ready — \`musterd stream start\` will go live\n`);
    return 0;
  }
  // The fixes are reprinted together at the bottom because that block is the thing an operator
  // actually copies; interleaved with nine check lines it is easy to miss the second one.
  const noun = failed.length === 1 ? 'thing' : 'things';
  a.out(`\n${theme.err(`✗ ${failed.length} ${noun} to fix, in order:`)}\n\n`);
  for (const c of failed) {
    a.out(`  ${theme.bold(c.label)}\n`);
    for (const line of (c.fix ?? '').split('\n')) a.out(`    ${theme.accent(line)}\n`);
  }
  return 1;
}

function renderCheck(c: Check): string {
  const mark =
    c.state === 'ok' ? theme.ok('✓') : c.state === 'fail' ? theme.err('✗') : theme.meta('·');
  const detail = c.detail ? theme.meta(` — ${c.detail}`) : '';
  return `${mark} ${c.label}${detail}\n`;
}

// ── build ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build + push the capture image on Fly's remote builders (nothing touches Docker locally), then
 * record the pushed digest.
 *
 * The digest is the point. A rebuilt `:capture` tag resolved to the *previous* digest and two
 * machines silently streamed month-old code; `start` runs the recorded digest, which cannot be stale.
 * `-c hosted.fly.toml` is not optional either — `--build-only` still validates an app config, and a
 * fresh app has no machines to infer one from.
 */
async function buildVerb(a: {
  exec: Exec;
  app: string;
  repoRoot: string | null;
  out: (s: string) => void;
}): Promise<number> {
  const root = requireRepo(a.repoRoot);
  a.out(theme.meta('building on fly remote builders…') + '\n');
  // BOTH streams are scanned for the digest, and that is not defensive coding — flyctl prints the
  // `capture@sha256:…` line on stderr, so watching stdout alone found nothing and the guard below
  // refused every build. (live.sh got this right with `2>&1 | tee /dev/stderr`; porting it, I kept
  // the tee and lost the redirect.) Streamed through as it arrives rather than captured and dumped,
  // because a remote build runs for minutes and silence reads as a hang.
  const combined = await new Promise<{ code: number; text: string }>((resolve) => {
    const child = spawn(
      'fly',
      [
        'deploy',
        '.',
        '-a',
        a.app,
        '-c',
        'scripts/broadcast/hosted.fly.toml',
        '--build-only',
        '--push',
        '--remote-only',
        '--image-label',
        'capture',
      ],
      { cwd: root, stdio: ['inherit', 'pipe', 'pipe'] },
    );
    let text = '';
    child.stdout?.on('data', (d: Buffer) => {
      text += d.toString();
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      text += d.toString();
      process.stderr.write(d);
    });
    child.on('error', () => resolve({ code: 127, text }));
    child.on('close', (code) => resolve({ code: code ?? 1, text }));
  });
  if (combined.code !== 0) throw new CliError('fly build failed — see the output above', 1);
  const digest = parsePushedDigest(combined.text);
  if (!digest) {
    throw new CliError(
      'the build succeeded but no digest appeared in its output — refusing to record a tag ' +
        '(a tag can resolve to a stale image; a digest cannot)',
      1,
    );
  }
  writeFileSync(digestPath(root), digest + '\n');
  a.out(
    `${theme.ok('✓')} built ${theme.meta(digest.slice(0, 19))} — recorded for \`stream start\`\n`,
  );
  return 0;
}

// ── start ────────────────────────────────────────────────────────────────────────────────────────

async function startVerb(a: {
  exec: Exec;
  app: string;
  repoRoot: string | null;
  parsed: Parsed;
  out: (s: string) => void;
  err: (s: string) => void;
}): Promise<number> {
  const root = requireRepo(a.repoRoot);
  const digest = readDigest(root);
  if (!digest) throw new CliError('no image recorded — run `musterd stream build` first', 2);

  const live = startedMachines(machineListJson(a.exec, a.app));
  if (live.length > 0) {
    throw new CliError(`already live (machine ${live[0]}) — \`musterd stream stop\` first`, 1);
  }

  // The address is discovered, never demanded. Requiring MUSTERD_AIR_ADDR meant every launch began
  // by looking up a name the machine already knows.
  const addr = tailnetAddr(a.exec);
  if (!addr) {
    throw new CliError(
      'could not read this machine’s tailnet address from `tailscale status` — run `musterd stream doctor`',
      2,
    );
  }
  const team =
    (typeof a.parsed.flags['team'] === 'string' ? a.parsed.flags['team'] : undefined) ??
    process.env['MUSTERD_TEAM'] ??
    'revive';
  const extra =
    typeof a.parsed.flags['args'] === 'string'
      ? a.parsed.flags['args']
      : process.env['BROADCAST_ARGS'];

  a.out(
    `${theme.accent('stream')} ${theme.meta(`${team} · via ${addr} · ${VM_SIZE} ${REGION}`)}\n`,
  );
  const r = spawnSync(
    'fly',
    [
      'machine',
      'run',
      `registry.fly.io/${a.app}:capture@${digest}`,
      '-a',
      a.app,
      '--vm-size',
      VM_SIZE,
      '--region',
      REGION,
      // Machine lifetime = stream lifetime: `--rm` destroys it when the process exits, so `stop`,
      // the ADR 159 stall watchdog and `--duration` all end the billing too. `fly deploy` is
      // deliberately not used here — it silently creates a standby machine as well.
      '--rm',
      '--restart',
      'no',
      '--env',
      `MUSTERD_AIR_ADDR=${addr}`,
      '--env',
      `MUSTERD_TEAM=${team}`,
      ...(extra ? ['--env', `BROADCAST_ARGS=${extra}`] : []),
    ],
    { encoding: 'utf8', stdio: 'inherit' },
  );
  if (r.status !== 0) throw new CliError('fly machine run failed — see the output above', 1);
  a.out(
    `${theme.ok('◉ live')} ${theme.meta(`watch: fly logs -a ${a.app} · end: musterd stream stop`)}\n`,
  );
  return 0;
}

/** This machine's MagicDNS name, which is what the container puts in `Host`. */
function tailnetAddr(exec: Exec): string | null {
  const st = exec('tailscale', ['status', '--json']);
  if (st.code !== 0) return null;
  const self = parseTailscaleSelf(st.stdout);
  return self?.running ? self.dnsName : null;
}

// ── stop / status ────────────────────────────────────────────────────────────────────────────────

function machineListJson(exec: Exec, app: string): string {
  const r = exec('fly', ['machine', 'list', '-a', app, '--json']);
  return r.code === 0 ? r.stdout : '[]';
}

function stopVerb(a: { exec: Exec; app: string; out: (s: string) => void }): number {
  const live = startedMachines(machineListJson(a.exec, a.app));
  const machine = live[0];
  if (!machine) {
    a.out(theme.meta('○ nothing live') + '\n');
    return 0;
  }
  // SIGINT is the broadcast CLI's graceful stop (ADR 159): ffmpeg finalizes the container, Chrome
  // exits, the process ends, and `--rm` destroys the machine — which is what ends the billing.
  const r = a.exec('fly', [
    'machine',
    'stop',
    machine,
    '-a',
    a.app,
    '--signal',
    'SIGINT',
    '--timeout',
    '30',
  ]);
  if (r.code !== 0) throw new CliError(`could not stop machine ${machine}: ${r.stderr.trim()}`, 1);
  a.out(`${theme.ok('✓')} stopped ${machine} ${theme.meta('(machine self-destructs)')}\n`);
  return 0;
}

function statusVerb(a: { exec: Exec; app: string; out: (s: string) => void }): number {
  const live = startedMachines(machineListJson(a.exec, a.app));
  if (live.length === 0) {
    a.out(theme.meta('○ not live') + '\n');
    return 0;
  }
  a.out(`${theme.ok('◉ live')} ${theme.meta(`machine ${live.join(', ')} · ${a.app}`)}\n`);
  return 0;
}

function requireRepo(repoRoot: string | null): string {
  if (repoRoot) return repoRoot;
  throw new CliError(
    'this verb builds from the musterd source tree — run it from inside a musterd checkout',
    2,
  );
}
