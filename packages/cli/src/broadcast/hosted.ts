/**
 * Hosted broadcast — the preconditions, and how to see them.
 *
 * Going live from a rented machine spans three systems that know nothing about each other: a
 * Tailscale overlay, this machine's daemon, and a Fly app. Every one of them fails *silently from
 * the operator's side* — the symptom is always the same "the broadcast page never reported ready",
 * which points nowhere near the cause. Four launches were burned that way on 2026-07-27.
 *
 * So the checks here are deliberately **empirical, not declarative**: each one performs the exact
 * operation the stream will perform and reports what came back. Notably the allow-list check does a
 * real WebSocket upgrade against the running daemon with the tailnet `Host` header rather than
 * reading `MUSTERD_ALLOWED_HOSTS` out of the LaunchAgent plist — the plist is what someone *wrote*,
 * the upgrade is what the daemon currently *does*, and on 2026-07-27 those disagreed for two minutes
 * because a `launchctl bootstrap` silently didn't take.
 *
 * Everything is injected (`Exec`, `probeUpgrade`) so the whole ladder is unit-testable without a
 * tailnet, a daemon, or a Fly account.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';

/** The Fly app that hosts the stream. Overridable for a second environment. */
export const DEFAULT_APP = 'musterd-broadcast';
/** The secrets the container needs. Values never pass through musterd — only presence is checked. */
export const REQUIRED_SECRETS = ['TS_AUTHKEY', 'MUSTERD_STREAM_KEY'] as const;
/** The proven configuration (see the hosting spec + the 2026-07-27 run that passed). */
export const VM_SIZE = 'performance-4x';
export const REGION = 'sjc';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => ExecResult;

/** A missing binary is `code 127` rather than a thrown error, so a check can report it as a check. */
export const realExec: Exec = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// ── Parsers (pure — the JSON shapes of two third-party CLIs, pinned by tests) ────────────────────

export interface TailnetSelf {
  /** MagicDNS name with the trailing dot stripped — what goes in `Host` and `MUSTERD_AIR_ADDR`. */
  dnsName: string;
  ip4: string | null;
  running: boolean;
}

/**
 * The capture hostname every hosted run registers under. One name, deliberately: the machine is
 * ephemeral, and so is the tailnet node it brings up with it.
 */
export const CAPTURE_HOSTNAME = 'musterd-broadcast';

/**
 * How many OFFLINE capture nodes can be on the tailnet before it means something is wrong.
 *
 * Two, and the number is a statement about mechanism, not a tolerance. The entrypoint runs
 * `tailscaled --state=/tmp/...` on purpose — `/tmp` does not survive a Fly machine, so every run
 * registers a genuinely new node, and Tailscale will not reissue a hostname that is still taken:
 * it appends `-1`, `-2`. That is CORRECT, and paired with an ephemeral auth key it self-cleans,
 * because the coordination server drops an ephemeral node a while after it goes offline. So a
 * couple of dead `musterd-broadcast-N` rows during a restart is what health looks like.
 *
 * The failure this catches is the one that looks identical from the outside: if the auth key is
 * NOT ephemeral, nothing is ever reaped, every run leaks a row forever, and the only symptom is
 * the same suffixed names. Nobody would notice, because the healthy state and the leaking state
 * are the same picture — which is exactly why it needs a number to cross rather than an eye to
 * catch it. Above two, ephemeral reap cannot be the explanation.
 */
export const STALE_CAPTURE_LIMIT = 2;

export interface CaptureNodes {
  /** Every `musterd-broadcast*` peer on the tailnet, newest suffix last. */
  names: string[];
  /** Those of them currently offline — the ones a reap should be removing. */
  offline: string[];
}

/**
 * The capture nodes registered on this tailnet, from the same `tailscale status --json` the
 * tailnet check already ran. Peers only: this laptop is never the capture machine.
 */
export function parseCaptureNodes(json: string): CaptureNodes | null {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const peers = (doc as { Peer?: unknown }).Peer;
  if (typeof peers !== 'object' || peers === null) return null;
  const names: string[] = [];
  const offline: string[] = [];
  for (const value of Object.values(peers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const peer = value as { HostName?: unknown; Online?: unknown };
    const host = typeof peer.HostName === 'string' ? peer.HostName : '';
    // `musterd-broadcast` itself and its `-N` retries; never a `musterd-broadcaster` someone else
    // named a box, which is why this is an exact-or-suffix test and not a prefix test.
    if (host !== CAPTURE_HOSTNAME && !new RegExp(`^${CAPTURE_HOSTNAME}-\\d+$`).test(host)) continue;
    names.push(host);
    if (peer.Online !== true) offline.push(host);
  }
  names.sort();
  offline.sort();
  return { names, offline };
}

/** `tailscale status --json`. */
export function parseTailscaleSelf(json: string): TailnetSelf | null {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const d = doc as { BackendState?: unknown; Self?: unknown };
  const self = (d.Self ?? {}) as { DNSName?: unknown; TailscaleIPs?: unknown };
  const raw = typeof self.DNSName === 'string' ? self.DNSName : '';
  if (!raw) return null;
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  const ip4 = ips.find((i): i is string => typeof i === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(i));
  return {
    dnsName: raw.replace(/\.$/, ''),
    ip4: ip4 ?? null,
    running: d.BackendState === 'Running',
  };
}

/**
 * `tailscale serve status --json`. The daemon stays loopback-bound; `serve` is the only thing that
 * puts it on the tailnet, and its absence is invisible until a machine 3,000 miles away can't
 * connect. Keys under `TCP` are port numbers.
 */
export function serveForwardsPort(json: string, port: number): boolean {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return false;
  }
  const tcp = (doc as { TCP?: Record<string, unknown> } | null)?.TCP;
  if (!tcp || typeof tcp !== 'object') return false;
  const entry = tcp[String(port)];
  return Boolean(entry);
}

export interface SecretRow {
  name: string;
  /** A short hash of the value. Safe to print — it proves the secret is set without revealing it. */
  digest: string | null;
}

/**
 * `fly secrets list --json` → what is set. **Never values**: flyctl does not return them and musterd
 * would not print them if it did; the digest is the evidence.
 *
 * Both key casings are accepted because flyctl changed them (`Name`/`Digest` → `name`/`digest`), and
 * this parser reading only the old one is what made a green system report "none set" on first run.
 */
export function parseSecrets(json: string): SecretRow[] {
  try {
    const doc: unknown = JSON.parse(json);
    if (!Array.isArray(doc)) return [];
    return doc
      .map((s) => {
        const r = s as { name?: unknown; Name?: unknown; digest?: unknown; Digest?: unknown };
        const name =
          typeof r.name === 'string' ? r.name : typeof r.Name === 'string' ? r.Name : null;
        const digest =
          typeof r.digest === 'string' ? r.digest : typeof r.Digest === 'string' ? r.Digest : null;
        return name ? { name, digest } : null;
      })
      .filter((r): r is SecretRow => r !== null);
  } catch {
    return [];
  }
}

/**
 * `fly machine list --json` → ids of machines actually running (a stream is at most one).
 *
 * Both key casings, for the same reason as `parseSecrets`: flyctl's JSON casing is not a contract,
 * and here a false empty would let `start` boot a second machine beside a live stream — two
 * encoders on one Twitch key, and double billing.
 */
export function startedMachines(json: string): string[] {
  return machineIds(json, (state) => state === 'started');
}

/** The shared parse behind both machine queries — one place for flyctl's casing, one for its
 * shape. A parse failure is an empty list, and every caller treats that as "cannot tell", which is
 * why neither query is allowed to be the only thing standing between a start and a second machine. */
function machineIds(json: string, keep: (state: string) => boolean): string[] {
  try {
    const doc: unknown = JSON.parse(json);
    if (!Array.isArray(doc)) return [];
    return doc
      .map((m) => m as { id?: unknown; ID?: unknown; state?: unknown; State?: unknown })
      .filter((m) => {
        const state = m.state ?? m.State;
        return typeof state === 'string' && keep(state);
      })
      .map((m) => (typeof m.id === 'string' ? m.id : typeof m.ID === 'string' ? m.ID : null))
      .filter((id): id is string => id !== null);
  } catch {
    return [];
  }
}

/**
 * Fly states that mean a machine is HOLDING this app's one slot — booting included.
 *
 * `started` answers "is it running", which is the right question for status and the wrong one for
 * "may I launch". A machine reports `created`, then `starting`, for the whole boot: 29.0s on the
 * 2026-09-03 run, 26.5s of it pulling the 593 MB image. Ask the running question during that window
 * and the answer is a false empty — which is exactly the failure `startedMachines` warns about one
 * doc comment above, arriving through the door it left open.
 */
const OCCUPYING = new Set(['created', 'starting', 'started', 'replacing']);

/**
 * `fly machine list --json` → ids of machines occupying the app, whether or not they are up yet.
 *
 * Use this for every "is something already there" decision — the supervisor's crash predicate and
 * `start`'s own double-launch guard both are one. Two machines on one Twitch key means one of them
 * dies on `Input/output error` and the survivor is chosen by a race, while both bill as
 * performance-4x. Deliberately NOT the states that mean gone (`stopped`, `stopping`, `destroying`,
 * `destroyed`, `suspended`): a stream that really has ended must still be restartable.
 */
export function occupiedMachines(json: string): string[] {
  return machineIds(json, (state) => OCCUPYING.has(state));
}

/**
 * Pull the pushed digest out of `fly deploy --build-only` output.
 *
 * This is load-bearing, not cosmetic: a rebuilt `:capture` tag resolved to the *previous* digest and
 * two machines silently streamed month-old code while the fix sat in the registry. `start` runs the
 * recorded digest, which cannot be stale by construction.
 */
export function parsePushedDigest(out: string): string | null {
  const m = out.match(/capture@(sha256:[a-f0-9]{64})/g);
  if (!m || m.length === 0) return null;
  return m[m.length - 1]!.split('@')[1] ?? null;
}

// ── The daemon's upgrade gate, probed for real ───────────────────────────────────────────────────

export type UpgradeVerdict = 'allowed' | 'rejected' | 'unreachable';

/**
 * Ask the *running* daemon whether it would accept a WS upgrade whose `Host` is the tailnet name.
 *
 * The request goes to loopback and only the header is tailnet-shaped, so this works before any
 * overlay routing exists and costs nothing. ADR 040's gate answers 403 for a host it doesn't allow;
 * any other outcome (101, or a 400 from the WS layer for an incomplete handshake) means the gate let
 * it through, which is the thing being tested.
 */
export function probeUpgradeHost(
  origin: { hostname: string; port: number },
  hostHeader: string,
  timeoutMs = 3000,
): Promise<UpgradeVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: UpgradeVerdict) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = request({
      host: origin.hostname,
      port: origin.port,
      path: '/ws',
      headers: {
        Host: hostHeader,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
      timeout: timeoutMs,
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      done('allowed');
    });
    req.on('response', (res) => {
      res.resume();
      done(res.statusCode === 403 ? 'rejected' : 'allowed');
    });
    req.on('timeout', () => {
      req.destroy();
      done('unreachable');
    });
    req.on('error', () => done('unreachable'));
    req.end();
  });
}

// ── Checks ───────────────────────────────────────────────────────────────────────────────────────

export interface Check {
  /** Stable id — what `--json` consumers and the fix-ladder key off. */
  key: string;
  label: string;
  state: 'ok' | 'fail' | 'skip';
  /** What was actually observed. */
  detail?: string;
  /** The exact thing to run or do. Present on every `fail`; that is the whole point of doctor. */
  fix?: string;
}

export interface DoctorCtx {
  exec: Exec;
  probeUpgrade: (hostHeader: string) => Promise<UpgradeVerdict>;
  app: string;
  /** The daemon's loopback port — where the upgrade probe is aimed. */
  port: number;
  /** The musterd checkout the image builds from, or null when running outside one. */
  repoRoot: string | null;
  /** The digest `build` recorded, if any. */
  digest: string | null;
}

const skip = (key: string, label: string, why: string): Check => ({
  key,
  label,
  state: 'skip',
  detail: why,
});

/**
 * Run every precondition in dependency order. A failure upstream turns its dependants into `skip`
 * rather than a cascade of red — an operator who hasn't installed Tailscale does not need to be told
 * four more times.
 */
export async function runChecks(ctx: DoctorCtx): Promise<Check[]> {
  const checks: Check[] = [];
  const { exec } = ctx;

  // 1 — tailscale present
  const tsVersion = exec('tailscale', ['version']);
  const haveTs = tsVersion.code === 0;
  checks.push({
    key: 'tailscale',
    label: 'tailscale installed',
    state: haveTs ? 'ok' : 'fail',
    ...(haveTs ? { detail: tsVersion.stdout.split('\n')[0]?.trim() ?? '' } : {}),
    ...(haveTs
      ? {}
      : { fix: 'install Tailscale from https://tailscale.com/download, then sign in' }),
  });

  // 2 — the overlay is up, and it tells us our own address
  let self: TailnetSelf | null = null;
  let capture: CaptureNodes | null = null;
  if (!haveTs) {
    checks.push(skip('tailnet', 'tailnet up', 'needs tailscale'));
  } else {
    const st = exec('tailscale', ['status', '--json']);
    self = st.code === 0 ? parseTailscaleSelf(st.stdout) : null;
    // Same payload, second reading — the capture-node census below costs no extra process.
    capture = st.code === 0 ? parseCaptureNodes(st.stdout) : null;
    const up = Boolean(self?.running && self.dnsName);
    checks.push({
      key: 'tailnet',
      label: 'tailnet up',
      state: up ? 'ok' : 'fail',
      ...(self?.dnsName ? { detail: `${self.dnsName}${self.ip4 ? ` · ${self.ip4}` : ''}` } : {}),
      ...(up ? {} : { fix: 'tailscale up' }),
    });
    if (!up) self = null;
  }

  // 2b — the capture nodes are being reaped
  //
  // Not a launch precondition: a pile of dead `musterd-broadcast-N` rows stops nothing from going
  // live. It is here because it is otherwise INVISIBLE — the only place it shows is the Tailscale
  // admin app, which is where nick found three of them on 2026-09-03 and had to ask why. A fact
  // about this system that can only be learned by opening someone else's dashboard is a fact this
  // command should be stating. See `STALE_CAPTURE_LIMIT` for why the number is the whole check:
  // healthy churn and a permanent leak produce the identical picture, and only the count separates
  // them.
  if (!capture) {
    checks.push(skip('capture-nodes', 'capture nodes reaped', 'needs the tailnet'));
  } else {
    const leaking = capture.offline.length > STALE_CAPTURE_LIMIT;
    checks.push({
      key: 'capture-nodes',
      label: 'capture nodes reaped',
      state: leaking ? 'fail' : 'ok',
      detail:
        capture.names.length === 0
          ? 'none registered'
          : `${capture.names.length} on the tailnet, ${capture.offline.length} offline` +
            (capture.offline.length > 0 ? ` (${capture.offline.join(', ')})` : ''),
      // Stated as the one cause the count actually rules in. Ephemeral nodes are dropped a while
      // after they go offline, so more than a couple of them sitting there is not slow cleanup —
      // it is no cleanup, which means the key they registered with is not an ephemeral one.
      ...(leaking
        ? {
            fix:
              `${capture.offline.length} dead capture nodes — more than reap can explain, so TS_AUTHKEY is not ephemeral.\n` +
              `Mint an ephemeral + reusable key at https://login.tailscale.com/admin/settings/keys, then:\n` +
              `fly secrets set TS_AUTHKEY=<new key> -a ${ctx.app}\n` +
              `and delete the stale ${CAPTURE_HOSTNAME}-* devices in the admin console`,
          }
        : {}),
    });
  }

  // 3 — the daemon is forwarded onto the tailnet
  if (!haveTs) {
    checks.push(skip('serve', `tailscale serve forwards ${ctx.port}`, 'needs tailscale'));
  } else {
    const sv = exec('tailscale', ['serve', 'status', '--json']);
    const forwarding = sv.code === 0 && serveForwardsPort(sv.stdout, ctx.port);
    checks.push({
      key: 'serve',
      label: `tailscale serve forwards ${ctx.port}`,
      state: forwarding ? 'ok' : 'fail',
      ...(forwarding ? { detail: `tcp/${ctx.port} → 127.0.0.1:${ctx.port}` } : {}),
      ...(forwarding
        ? {}
        : {
            fix: `tailscale serve --bg --tcp ${ctx.port} tcp://127.0.0.1:${ctx.port}`,
          }),
    });
  }

  // 4 — the daemon would accept the capture page's WS upgrade over the tailnet Host
  //
  // Both the name and the IP are checked because either can land in `Host` depending on how the
  // container resolved the daemon, and on 2026-07-27 the container resolved by IP (Fly owns
  // /etc/resolv.conf, so MagicDNS never installs). An allow-list with only the name still fails.
  if (!self) {
    checks.push(
      skip('allowed-host', 'daemon allows the tailnet Host', 'needs the tailnet address'),
    );
  } else {
    const hosts = [self.dnsName, ...(self.ip4 ? [self.ip4] : [])];
    const verdicts = await Promise.all(hosts.map((h) => ctx.probeUpgrade(h)));
    const unreachable = verdicts.includes('unreachable');
    const rejected = hosts.filter((_, i) => verdicts[i] === 'rejected');
    const state = unreachable || rejected.length > 0 ? 'fail' : 'ok';
    checks.push({
      key: 'allowed-host',
      label: 'daemon allows the tailnet Host',
      state,
      detail: unreachable
        ? `no answer on 127.0.0.1:${ctx.port}`
        : rejected.length > 0
          ? `403 for ${rejected.join(', ')} (ws_upgrade_rejected: host not allowed)`
          : `${hosts.join(', ')} accepted`,
      // Phrased as an observation, not a diagnosis. All this check saw is that no answer came back,
      // and "the daemon is down" and "this CLI cannot see it" are different conditions that look
      // identical from here — the distinction stanley's ADR 040 service work turned on (#422: only
      // was-up-then-not is an outage, so his bounce takes a baseline probe first). The probe aims at
      // loopback today, where down is nearly always the right reading; the moment doctor is pointed
      // at a daemon across the overlay it would not be, and a check that states a cause it did not
      // observe is the exact failure this command exists to end. Whoever adds that capability wants
      // his baseline, not this sentence.
      ...(unreachable
        ? {
            fix: `no answer from the daemon — it may be down, or unreachable from here. Check with \`musterd service status\`, then \`musterd service start\``,
          }
        : rejected.length > 0
          ? {
              fix:
                `musterd service install --allowed-hosts ${hosts.join(',')}\n` +
                `      (restarts the daemon and verifies /health; the old way was hand-editing the LaunchAgent plist)`,
            }
          : {}),
    });
  }

  // 5 — flyctl present
  const flyVersion = exec('fly', ['version']);
  const haveFly = flyVersion.code === 0;
  checks.push({
    key: 'fly',
    label: 'flyctl installed',
    state: haveFly ? 'ok' : 'fail',
    // `fly version` prints version, platform, commit SHA and build date on one line; only the first
    // two are worth a check line.
    ...(haveFly ? { detail: flyVersion.stdout.split(/\s+Commit:/)[0]?.trim() ?? '' } : {}),
    ...(haveFly ? {} : { fix: 'brew install flyctl   (or https://fly.io/docs/flyctl/install/)' }),
  });

  // 6 — authenticated
  let authed = false;
  if (!haveFly) {
    checks.push(skip('fly-auth', 'flyctl authenticated', 'needs flyctl'));
  } else {
    const who = exec('fly', ['auth', 'whoami']);
    authed = who.code === 0;
    checks.push({
      key: 'fly-auth',
      label: 'flyctl authenticated',
      state: authed ? 'ok' : 'fail',
      ...(authed ? { detail: who.stdout.trim() } : {}),
      ...(authed ? {} : { fix: 'fly auth login' }),
    });
  }

  // 7 — the app exists
  let appExists = false;
  if (!authed) {
    checks.push(skip('app', `app ${ctx.app} exists`, 'needs an authenticated flyctl'));
  } else {
    const st = exec('fly', ['status', '-a', ctx.app, '--json']);
    appExists = st.code === 0;
    checks.push({
      key: 'app',
      label: `app ${ctx.app} exists`,
      state: appExists ? 'ok' : 'fail',
      ...(appExists ? {} : { fix: `fly apps create ${ctx.app} --org personal` }),
    });
  }

  // 8 — both secrets staged
  //
  // Presence only. musterd never reads, prints, or accepts these values: the operator sets them
  // directly so a stream key never passes through an agent, a script argument, or the repo.
  if (!appExists) {
    checks.push(skip('secrets', 'stream + tailnet secrets set', 'needs the app'));
  } else {
    const sec = exec('fly', ['secrets', 'list', '-a', ctx.app, '--json']);
    const rows = sec.code === 0 ? parseSecrets(sec.stdout) : [];
    const missing = REQUIRED_SECRETS.filter((s) => !rows.some((r) => r.name === s));
    checks.push({
      key: 'secrets',
      label: 'stream + tailnet secrets set',
      state: missing.length === 0 ? 'ok' : 'fail',
      detail:
        rows.length > 0
          ? rows.map((r) => `${r.name} ${r.digest?.slice(0, 8) ?? '?'}`).join(' · ')
          : 'none set',
      ...(missing.length === 0
        ? {}
        : {
            fix:
              `fly secrets set -a ${ctx.app} --stage ` +
              missing.map((s) => `${s}=<${secretHint(s)}>`).join(' '),
          }),
    });
  }

  // 9 — an image has been built and its digest recorded
  if (!ctx.repoRoot) {
    checks.push(skip('image', 'capture image built', 'not inside a musterd checkout'));
  } else {
    const built = Boolean(ctx.digest);
    checks.push({
      key: 'image',
      label: 'capture image built',
      state: built ? 'ok' : 'fail',
      ...(built ? { detail: ctx.digest!.slice(0, 19) } : {}),
      ...(built ? {} : { fix: 'musterd stream build' }),
    });
  }

  return checks;
}

function secretHint(name: string): string {
  return name === 'TS_AUTHKEY' ? 'ephemeral+reusable tailnet auth key' : 'twitch stream key';
}

// ── Checkout + digest bookkeeping ────────────────────────────────────────────────────────────────

/** Walk up from `from` for the checkout that carries the hosted build files. */
export function findRepoRoot(from: string): string | null {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'scripts', 'broadcast', 'hosted.Dockerfile'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function digestPath(repoRoot: string): string {
  return join(repoRoot, 'scripts', 'broadcast', '.image-digest');
}

export function readDigest(repoRoot: string | null): string | null {
  if (!repoRoot) return null;
  try {
    const raw = readFileSync(digestPath(repoRoot), 'utf8').trim();
    return raw.startsWith('sha256:') ? raw : null;
  } catch {
    return null;
  }
}
