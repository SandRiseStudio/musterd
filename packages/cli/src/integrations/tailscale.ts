import { request } from 'node:http';
import {
  TailscaleServeStatusSchema,
  TailscaleStatusSchema,
  type IntegrationCheck,
} from '@musterd/protocol';
import type { Exec } from '../process.js';

export interface TailnetSelf {
  dnsName: string;
  ip4: string | null;
  running: boolean;
}

export type UpgradeVerdict = 'allowed' | 'rejected' | 'unreachable';

export interface TailscaleDoctorDeps {
  exec: Exec;
  server: string;
  fetch: typeof globalThis.fetch;
  probeUpgrade: typeof probeUpgradeHost;
}

const CHECKS = [
  ['tailscale-installed', 'tailscale installed'],
  ['tailnet-up', 'tailnet up'],
  ['daemon-secured-bind', 'daemon secured bind'],
  ['tailscale-serve', 'tailscale serve'],
  ['daemon-host-gate', 'daemon Host gate'],
  ['daemon-http', 'daemon HTTP'],
  ['daemon-websocket', 'daemon WebSocket'],
] as const;

type CheckKey = (typeof CHECKS)[number][0];
const labels = Object.fromEntries(CHECKS) as Record<CheckKey, string>;

function ok(key: CheckKey, detail: string): IntegrationCheck {
  return { key, label: labels[key], state: 'ok', detail };
}

function fail(key: CheckKey, detail: string, fix: string): IntegrationCheck {
  return { key, label: labels[key], state: 'fail', detail, fix };
}

function skipped(from: number, reason: string): IntegrationCheck[] {
  return CHECKS.slice(from).map(([key, label]) => ({ key, label, state: 'skip', detail: reason }));
}

export function parseTailscaleSelf(json: string): TailnetSelf | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = TailscaleStatusSchema.safeParse(parsed);
  if (!result.success) return null;
  const { Self } = result.data;
  if (!Self.DNSName) return null;
  const ip4 = Self.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
  return {
    dnsName: Self.DNSName.replace(/\.$/, ''),
    ip4,
    running: Self.Online === true || result.data.BackendState === 'Running',
  };
}

export function serveForwardsPort(json: string, port: number): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  const result = TailscaleServeStatusSchema.safeParse(parsed);
  if (!result.success) return false;
  const forward = result.data.TCP?.[String(port)]?.TCPForward;
  return (
    forward === `127.0.0.1:${port}` ||
    forward === `localhost:${port}` ||
    forward === `[::1]:${port}`
  );
}

export function probeUpgradeHost(
  origin: { hostname: string; port: number },
  host: string,
  timeoutMs = 3000,
): Promise<UpgradeVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (verdict: UpgradeVerdict) => {
      if (!settled) {
        settled = true;
        resolve(verdict);
      }
    };
    const req = request({
      host: origin.hostname,
      port: origin.port,
      path: '/ws',
      headers: {
        Host: host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
      timeout: timeoutMs,
    });
    req.on('upgrade', (_response, socket) => {
      socket.destroy();
      done('allowed');
    });
    req.on('response', (response) => {
      response.resume();
      done(response.statusCode === 403 ? 'rejected' : 'allowed');
    });
    req.on('timeout', () => {
      req.destroy();
      done('unreachable');
    });
    req.on('error', () => done('unreachable'));
    req.end();
  });
}

function loopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Empirically verifies the safe v1 topology without mutating the daemon or Tailscale. */
export async function inspectTailscaleTransport(
  deps: TailscaleDoctorDeps,
): Promise<IntegrationCheck[]> {
  const checks: IntegrationCheck[] = [];
  const version = deps.exec('tailscale', ['version']);
  if (version.code !== 0) {
    return [
      fail(
        'tailscale-installed',
        'tailscale CLI is unavailable',
        'Install Tailscale on the daemon host and sign in before selecting --tailscale.',
      ),
      ...skipped(1, 'tailscale is unavailable'),
    ];
  }
  checks.push(ok('tailscale-installed', version.stdout.trim().split(/\s+/)[0] || 'installed'));

  const status = deps.exec('tailscale', ['status', '--json']);
  const self = status.code === 0 ? parseTailscaleSelf(status.stdout) : null;
  if (!self?.running || !self.ip4) {
    checks.push(
      fail(
        'tailnet-up',
        self?.running
          ? 'tailnet is up but no Tailscale IPv4 address is available'
          : 'tailnet status is unavailable or down',
        self?.running
          ? 'Enable an IPv4 Tailscale address; Increment 1 cannot verify an IPv6-only path.'
          : 'Run tailscale status on the daemon host and restore its tailnet connection.',
      ),
      ...skipped(2, 'tailnet identity is not verified'),
    );
    return checks;
  }
  checks.push(ok('tailnet-up', `${self.dnsName} · ${self.ip4}`));

  let daemon: URL;
  try {
    daemon = new URL(deps.server);
  } catch {
    checks.push(
      fail(
        'daemon-secured-bind',
        'configured daemon URL is invalid',
        'Run this doctor on the daemon host with its loopback server URL.',
      ),
      ...skipped(3, 'daemon origin is not supported'),
    );
    return checks;
  }
  if (daemon.protocol !== 'http:' || !loopbackHostname(daemon.hostname)) {
    checks.push(
      fail(
        'daemon-secured-bind',
        'Increment 1 verifies only a loopback daemon behind Tailscale Serve',
        'Run this doctor on the daemon host with its loopback server URL.',
      ),
      ...skipped(3, 'daemon origin is not the supported local topology'),
    );
    return checks;
  }
  const port = Number(daemon.port || '80');
  checks.push(ok('daemon-secured-bind', 'loopback behind tailscale serve'));

  const serve = deps.exec('tailscale', ['serve', 'status', '--json']);
  if (serve.code !== 0 || !serveForwardsPort(serve.stdout, port)) {
    checks.push(
      fail(
        'tailscale-serve',
        `no TCP/${port} forward to the loopback daemon was found`,
        `Configure Tailscale Serve to forward TCP/${port} to 127.0.0.1:${port}.`,
      ),
      ...skipped(4, 'Tailscale Serve is not verified'),
    );
    return checks;
  }
  checks.push(ok('tailscale-serve', `tcp/${port} → 127.0.0.1:${port}`));

  const localOrigin = { hostname: daemon.hostname, port };
  const [dnsGate, ipGate] = await Promise.all([
    deps.probeUpgrade(localOrigin, self.dnsName),
    deps.probeUpgrade(localOrigin, self.ip4),
  ]);
  if (dnsGate !== 'allowed' || ipGate !== 'allowed') {
    const refused = [
      dnsGate !== 'allowed' ? self.dnsName : '',
      ipGate !== 'allowed' ? self.ip4 : '',
    ]
      .filter(Boolean)
      .join(' and ');
    checks.push(
      fail(
        'daemon-host-gate',
        `${refused} rejected or unreachable`,
        'Allow the exact MagicDNS name and Tailscale IPv4 address in the daemon Host gate.',
      ),
      ...skipped(5, 'daemon Host gate is not verified'),
    );
    return checks;
  }
  checks.push(ok('daemon-host-gate', `${self.dnsName} and ${self.ip4} accepted`));

  try {
    const response = await deps.fetch(`http://${self.dnsName}:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('non-success response');
  } catch {
    checks.push(
      fail(
        'daemon-http',
        '/health is unreachable over the tailnet',
        'Verify the Tailscale Serve route and tailnet policy from this host.',
      ),
      ...skipped(6, 'tailnet HTTP is not reachable'),
    );
    return checks;
  }
  checks.push(ok('daemon-http', '/health reachable over the tailnet'));

  const websocket = await deps.probeUpgrade({ hostname: self.dnsName, port }, self.dnsName);
  checks.push(
    websocket === 'allowed'
      ? ok('daemon-websocket', '/ws upgrade reachable over the tailnet')
      : fail(
          'daemon-websocket',
          '/ws upgrade is unreachable over the tailnet',
          'Verify the Tailscale Serve TCP route and daemon WebSocket upgrade path.',
        ),
  );
  return checks;
}
