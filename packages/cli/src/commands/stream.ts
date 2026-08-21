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
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
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
import {
  FLAP_MAX,
  FLAP_WINDOW_MS,
  decideEnsure,
  readStreamState,
  writeStreamState,
} from '../broadcast/streamState.js';
import { HttpClient } from '../client.js';
import { configPath, loadConfig, serverProvenance, type ServerProvenance } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

const USAGE =
  'usage: musterd stream <doctor|build|start|stop|status|ensure> [--app <name>] [--team <slug>] [--once] [--reason <text>] [--json]';

export interface StreamDeps {
  exec?: Exec;
  probeUpgrade?: (hostHeader: string) => Promise<'allowed' | 'rejected' | 'unreachable'>;
  cwd?: string;
  /** Where the daemon listens, for the upgrade probe. Defaults to the configured server. */
  server?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** The desired-state file (ADR 293). Defaults to `~/.musterd/stream/state.json`. */
  statePath?: string;
  now?: () => number;
  /** Who is running this verb — the CLI's resolved seat, recorded as stop/start provenance. */
  who?: () => string;
  /** Run `fly machine run` with these args; returns the exit code. Injected so tests never
   * reach the real Fly API (the default inherits stdio for the interactive `start`). */
  launch?: (flyArgs: string[]) => number;
  /** Raise the stand-down ask to the team (streamwatch service seat; ADR 293). */
  sendAsk?: (body: string) => Promise<void>;
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
  const statePath = deps.statePath ?? join(dirname(configPath()), 'stream', 'state.json');
  const now = deps.now ?? (() => Date.now());
  const who = deps.who ?? currentSeatName;
  const launch = deps.launch ?? realLaunch;
  const sendAsk = deps.sendAsk ?? defaultSendAsk;
  const sup = { statePath, now, who, launch, sendAsk };

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
        // Only when the CALLER did not name the server: an injected/flagged one has no provenance
        // question, and the doctor's own checks are about the resolved origin either way.
        ...(deps.server ? {} : { provenance: serverProvenance(cwd) }),
      });
    case 'build':
      return buildVerb({ exec, app, repoRoot, out });
    case 'start':
      return startVerb({ exec, app, repoRoot, parsed, out, err, ...sup });
    case 'stop':
      return stopVerb({ exec, app, parsed, out, ...sup });
    case 'status':
      return statusVerb({ exec, app, out, ...sup });
    case 'ensure':
      return ensureVerb({ exec, app, repoRoot, parsed, out, err, ...sup });
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
  provenance?: ServerProvenance;
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
  // Say which daemon these checks are ABOUT before printing them. Every check below resolves from
  // the machine-wide default, so when that default is wrong (2026-08-12: a probe's `team create`
  // repointed it) the doctor fails correctly about somebody else's port — and prescribes real
  // repairs for infrastructure that is fine. The binding line is the tell.
  if (a.provenance) {
    a.out(theme.meta(`  daemon: ${a.provenance.server} (${a.provenance.source})\n`));
    if (a.provenance.disagreeingBinding) {
      a.out(
        `  ${theme.warn('!')} this folder is bound to ${theme.accent(a.provenance.disagreeingBinding.server)} ` +
          `(${a.provenance.disagreeingBinding.team}) — the checks below are about the ${a.provenance.source}\n`,
      );
    }
    a.out('\n');
  }
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

/** The injected supervisor plumbing every desired-state verb shares (ADR 293). */
interface Sup {
  statePath: string;
  now: () => number;
  who: () => string;
  launch: (flyArgs: string[]) => number;
  sendAsk: (body: string) => Promise<void>;
}

/** The `fly machine run` invocation, shared by `start` and the supervisor's relaunch. */
function launchArgs(a: {
  app: string;
  digest: string;
  addr: string;
  team: string;
  extra?: string | undefined;
}): string[] {
  return [
    'machine',
    'run',
    `registry.fly.io/${a.app}:capture@${a.digest}`,
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
    `MUSTERD_AIR_ADDR=${a.addr}`,
    '--env',
    `MUSTERD_TEAM=${a.team}`,
    ...(a.extra ? ['--env', `BROADCAST_ARGS=${a.extra}`] : []),
  ];
}

/** Resolve the launch preconditions (image digest + tailnet address) or throw the doctor hint. */
function launchPreconditions(a: { exec: Exec; repoRoot: string | null }): {
  digest: string;
  addr: string;
} {
  const root = requireRepo(a.repoRoot);
  const digest = readDigest(root);
  if (!digest) throw new CliError('no image recorded — run `musterd stream build` first', 2);
  // The address is discovered, never demanded. Requiring MUSTERD_AIR_ADDR meant every launch began
  // by looking up a name the machine already knows.
  const addr = tailnetAddr(a.exec);
  if (!addr) {
    throw new CliError(
      'could not read this machine’s tailnet address from `tailscale status` — run `musterd stream doctor`',
      2,
    );
  }
  return { digest, addr };
}

async function startVerb(
  a: {
    exec: Exec;
    app: string;
    repoRoot: string | null;
    parsed: Parsed;
    out: (s: string) => void;
    err: (s: string) => void;
  } & Sup,
): Promise<number> {
  const live = startedMachines(machineListJson(a.exec, a.app));
  if (live.length > 0) {
    throw new CliError(`already live (machine ${live[0]}) — \`musterd stream stop\` first`, 1);
  }
  const { digest, addr } = launchPreconditions(a);
  const team =
    (typeof a.parsed.flags['team'] === 'string' ? a.parsed.flags['team'] : undefined) ??
    process.env['MUSTERD_TEAM'] ??
    'revive';
  const extra =
    typeof a.parsed.flags['args'] === 'string'
      ? a.parsed.flags['args']
      : process.env['BROADCAST_ARGS'];

  // Intent is recorded BEFORE the launch (ADR 293): a start that fails at `fly` still says "this
  // stream should be live", and the supervisor's next tick retries it inside the flap budget. The
  // exception is `--once` — a deliberately unsupervised run records `stopped` so nothing ever
  // resurrects it (time-boxed `--duration` streams ride this).
  const once = a.parsed.flags['once'] === true;
  writeStreamState(
    a.statePath,
    once
      ? { desired: 'stopped', by: a.who(), at: a.now(), reason: '--once run', team, restarts: [] }
      : { desired: 'live', by: a.who(), at: a.now(), team, image: digest, restarts: [] },
  );

  a.out(
    `${theme.accent('stream')} ${theme.meta(`${team} · via ${addr} · ${VM_SIZE} ${REGION}`)}\n`,
  );
  const code = a.launch(launchArgs({ app: a.app, digest, addr, team, extra }));
  if (code !== 0) throw new CliError('fly machine run failed — see the output above', 1);
  a.out(
    `${theme.ok('◉ live')} ${theme.meta(`watch: fly logs -a ${a.app} · end: musterd stream stop`)}\n`,
  );
  return 0;
}

/** The real launcher: interactive stdio so `start`'s output streams to the operator. */
function realLaunch(flyArgs: string[]): number {
  const r = spawnSync('fly', flyArgs, { encoding: 'utf8', stdio: 'inherit' });
  return r.status ?? 1;
}

/** The CLI's resolved seat for the current team — the `by` on start/stop provenance. */
function currentSeatName(): string {
  try {
    const config = loadConfig();
    return (config.current && config.identities[config.current]?.name) || 'unknown';
  } catch {
    return 'unknown';
  }
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

function stopVerb(
  a: { exec: Exec; app: string; parsed: Parsed; out: (s: string) => void } & Sup,
): number {
  // The stop record is written FIRST, whatever the machine list says: even mid-race with the
  // supervisor, a deliberate stop can never be resurrected — and a stop typed at an already-dead
  // stream (a crash the human noticed first) still records "this silence is intentional".
  const reason =
    typeof a.parsed.flags['reason'] === 'string' ? a.parsed.flags['reason'] : undefined;
  const prev = readStreamState(a.statePath);
  writeStreamState(a.statePath, {
    desired: 'stopped',
    by: a.who(),
    at: a.now(),
    ...(reason ? { reason } : {}),
    ...(prev?.team ? { team: prev.team } : {}),
    restarts: [],
  });
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

function statusVerb(a: { exec: Exec; app: string; out: (s: string) => void } & Sup): number {
  const live = startedMachines(machineListJson(a.exec, a.app));
  const state = readStreamState(a.statePath);
  if (live.length === 0) {
    // Silence has three different meanings, and the bare "not live" hid all of them.
    if (state?.standDownAt !== undefined) {
      a.out(
        `${theme.err('⚠ stood down')} ${theme.meta(
          `after ${FLAP_MAX} restarts in ${FLAP_WINDOW_MS / 60_000}min — \`musterd stream start\` re-arms`,
        )}\n`,
      );
    } else if (state?.desired === 'live') {
      a.out(
        `${theme.warn('○ not live')} ${theme.meta(
          'but desired live — a crash; the supervisor restarts it within its tick',
        )}\n`,
      );
    } else if (state?.desired === 'stopped' && state.by) {
      const when = new Date(state.at).toLocaleTimeString();
      const why = state.reason ? ` · "${state.reason}"` : '';
      a.out(`${theme.meta(`○ stopped by ${state.by} · ${when}${why}`)}\n`);
    } else {
      a.out(theme.meta('○ not live') + '\n');
    }
    return 0;
  }
  a.out(`${theme.ok('◉ live')} ${theme.meta(`machine ${live.join(', ')} · ${a.app}`)}\n`);
  return 0;
}

// ── ensure: the supervisor's reconcile tick (ADR 293) ───────────────────────────────────────────

/**
 * Actual vs desired, once: a machine gone while the state file says live is a crash — relaunch it
 * inside the flap budget, stand down (and ask a human) at the cap. Deliberate stops and `--once`
 * runs are `desired: stopped` and never touched. Silent on the healthy paths so the supervisor log
 * holds findings only, like the sweep's.
 */
async function ensureVerb(
  a: {
    exec: Exec;
    app: string;
    repoRoot: string | null;
    parsed: Parsed;
    out: (s: string) => void;
    err: (s: string) => void;
  } & Sup,
): Promise<number> {
  const state = readStreamState(a.statePath);
  const liveCount = startedMachines(machineListJson(a.exec, a.app)).length;
  const d = decideEnsure({
    state,
    liveCount,
    now: a.now(),
    recordedDigest: readDigest(a.repoRoot),
  });
  switch (d.action) {
    case 'noop':
      return 0;
    case 'stand_down': {
      writeStreamState(a.statePath, d.state);
      a.err(`${theme.err('⚠')} ${d.note}\n`);
      try {
        await a.sendAsk(
          `streamwatch: the broadcast crashed ${FLAP_MAX}× in ${FLAP_WINDOW_MS / 60_000}min and the ` +
            `supervisor stood down — \`musterd stream doctor\` then \`musterd stream start\` to re-arm ` +
            `(restarts: ${d.state.restarts.map((t) => new Date(t).toLocaleTimeString()).join(', ')})`,
        );
      } catch (e) {
        a.err(
          theme.meta(`stand-down ask could not be sent (${(e as Error).message}) — logged only\n`),
        );
      }
      return 0;
    }
    case 'restart': {
      // The ledger is stamped BEFORE the launch: a launch that fails still spent an attempt, so a
      // hard-broken stream converges on stand-down instead of retrying forever.
      writeStreamState(a.statePath, d.state);
      a.out(`${theme.warn('↻')} ${d.note}\n`);
      const { digest, addr } = launchPreconditions(a);
      const team = d.state.team ?? process.env['MUSTERD_TEAM'] ?? 'revive';
      const code = a.launch(launchArgs({ app: a.app, digest, addr, team }));
      if (code !== 0)
        a.err(`${theme.err('✗')} relaunch failed (fly exit ${code}) — next tick retries\n`);
      else a.out(`${theme.ok('◉ live again')} ${theme.meta(`machine relaunched · ${a.app}`)}\n`);
      return 0;
    }
  }
}

/** The stand-down ask, sent as the `streamwatch` service seat (minted at `service install --stream`,
 * the guardian pattern). Unprovisioned → throw; the caller logs and degrades (ADR 232's shape). */
async function defaultSendAsk(body: string): Promise<void> {
  const tokenFile = join(dirname(configPath()), 'stream', 'seat-token');
  const token = readFileSync(tokenFile, 'utf8').trim();
  const config = loadConfig();
  const team = config.current;
  if (!token || !team)
    throw new Error('no streamwatch seat token/team — run `musterd service install --stream`');
  const http = new HttpClient({ server: config.server, key: token, surface: 'cli' });
  await http.send(
    team,
    makeEnvelope({
      id: ulid(),
      team,
      from: 'streamwatch',
      to: { kind: 'team' },
      act: 'ask',
      body,
      meta: { species: 'consult', tier: 'standard' },
    }),
  );
}

function requireRepo(repoRoot: string | null): string {
  if (repoRoot) return repoRoot;
  throw new CliError(
    'this verb builds from the musterd source tree — run it from inside a musterd checkout',
    2,
  );
}
