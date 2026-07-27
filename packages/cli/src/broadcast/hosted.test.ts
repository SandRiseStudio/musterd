import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  parsePushedDigest,
  parseSecrets,
  parseTailscaleSelf,
  probeUpgradeHost,
  runChecks,
  serveForwardsPort,
  startedMachines,
  type Check,
  type Exec,
  type ExecResult,
} from './hosted.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = ''): ExecResult => ({ code: 1, stdout: '', stderr });
const absent: ExecResult = { code: 127, stdout: '', stderr: 'not found' };

const TS_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: 'nicks-laptop.tail400343.ts.net.',
    TailscaleIPs: ['100.100.246.14', 'fd7a:115c:a1e0::1'],
  },
});

/** A fully-green system, so each test can knock out exactly one thing. */
function greenExec(over: Partial<Record<string, ExecResult>> = {}): Exec {
  return (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    for (const [prefix, result] of Object.entries(over)) {
      if (key.startsWith(prefix)) return result!;
    }
    if (key === 'tailscale version') return ok('1.80.0\n');
    if (key === 'tailscale status --json') return ok(TS_STATUS);
    if (key === 'tailscale serve status --json')
      return ok(JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }));
    if (key === 'fly version') return ok('flyctl v0.3.0\n');
    if (key === 'fly auth whoami') return ok('nick@example.com\n');
    if (key.startsWith('fly status')) return ok('{}');
    if (key.startsWith('fly secrets list'))
      return ok(
        JSON.stringify([
          { name: 'TS_AUTHKEY', digest: 'dc45' },
          { name: 'MUSTERD_STREAM_KEY', digest: '26a8' },
        ]),
      );
    return fail(`unexpected: ${key}`);
  };
}

const green = {
  exec: greenExec(),
  probeUpgrade: async () => 'allowed' as const,
  app: 'musterd-broadcast',
  port: 4849,
  repoRoot: '/repo',
  digest: 'sha256:' + 'a'.repeat(64),
};

const by = (checks: Check[], key: string): Check => {
  const c = checks.find((x) => x.key === key);
  if (!c) throw new Error(`no check ${key}`);
  return c;
};

describe('parsers', () => {
  it('strips the trailing dot off MagicDNS and picks the v4 address', () => {
    expect(parseTailscaleSelf(TS_STATUS)).toEqual({
      dnsName: 'nicks-laptop.tail400343.ts.net',
      ip4: '100.100.246.14',
      running: true,
    });
  });

  it('treats a stopped backend as not running rather than throwing', () => {
    const stopped = JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'x.ts.net.' } });
    expect(parseTailscaleSelf(stopped)?.running).toBe(false);
    expect(parseTailscaleSelf('not json')).toBeNull();
  });

  it('reads the serve forward by port number', () => {
    const doc = JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } });
    expect(serveForwardsPort(doc, 4849)).toBe(true);
    expect(serveForwardsPort(doc, 4850)).toBe(false);
    expect(serveForwardsPort('{}', 4849)).toBe(false);
  });

  // flyctl actually returns lowercase keys (verified against fly v0.4.74 on 2026-07-27). Reading
  // only the capitalised form is what made a fully-configured app report "none set" on first run,
  // so both casings are pinned here.
  it('reads secrets in either flyctl casing, and never a value', () => {
    const lower = JSON.stringify([
      { name: 'TS_AUTHKEY', digest: 'dc4562a27d8bfba7', status: 'Staged' },
    ]);
    expect(parseSecrets(lower)).toEqual([{ name: 'TS_AUTHKEY', digest: 'dc4562a27d8bfba7' }]);
    expect(parseSecrets(JSON.stringify([{ Name: 'TS_AUTHKEY', Digest: 'abc' }]))).toEqual([
      { name: 'TS_AUTHKEY', digest: 'abc' },
    ]);
  });

  it('counts only started machines, in either casing', () => {
    const doc = JSON.stringify([
      { id: 'aaa', state: 'stopped' },
      { id: 'bbb', state: 'started' },
    ]);
    expect(startedMachines(doc)).toEqual(['bbb']);
    expect(startedMachines(JSON.stringify([{ ID: 'ccc', State: 'started' }]))).toEqual(['ccc']);
  });

  // The trap this exists for: a rebuilt tag resolved to the PREVIOUS digest and two machines
  // silently streamed stale code. The LAST digest in the output is the one just pushed.
  it('takes the last digest in the build output', () => {
    const out = `--> pushing capture@sha256:${'1'.repeat(64)}\ndone capture@sha256:${'2'.repeat(64)}\n`;
    expect(parsePushedDigest(out)).toBe('sha256:' + '2'.repeat(64));
    expect(parsePushedDigest('no digest here')).toBeNull();
  });
});

describe('probeUpgradeHost', () => {
  const listen = (handler: (req: unknown, socket: import('node:net').Socket) => void) =>
    new Promise<{ server: Server; port: number }>((resolve) => {
      const server = createServer();
      server.on('upgrade', handler);
      server.listen(0, '127.0.0.1', () =>
        resolve({ server, port: (server.address() as { port: number }).port }),
      );
    });

  it('reads a 403 from the ADR 040 gate as rejected', async () => {
    const { server, port } = await listen((_req, socket) => {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    await expect(probeUpgradeHost({ hostname: '127.0.0.1', port }, 'box.ts.net')).resolves.toBe(
      'rejected',
    );
    server.close();
  });

  it('reads anything the gate lets through as allowed', async () => {
    // A 400 from the WS layer still means the host gate passed — which is the thing under test.
    const { server, port } = await listen((_req, socket) => {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    await expect(probeUpgradeHost({ hostname: '127.0.0.1', port }, 'box.ts.net')).resolves.toBe(
      'allowed',
    );
    server.close();
  });

  it('says unreachable when nothing is listening', async () => {
    await expect(
      probeUpgradeHost({ hostname: '127.0.0.1', port: 1 }, 'box.ts.net', 500),
    ).resolves.toBe('unreachable');
  });
});

describe('runChecks', () => {
  it('passes everything on a green system', async () => {
    const checks = await runChecks(green);
    expect(checks.filter((c) => c.state !== 'ok')).toEqual([]);
  });

  it('gives every failure an exact fix — that is the whole point of doctor', async () => {
    const checks = await runChecks({ ...green, exec: () => absent, digest: null });
    for (const c of checks.filter((x) => x.state === 'fail')) {
      expect(c.fix, `${c.key} has no fix`).toBeTruthy();
    }
  });

  it('skips dependants instead of cascading red when tailscale is absent', async () => {
    const checks = await runChecks({ ...green, exec: greenExec({ tailscale: absent }) });
    expect(by(checks, 'tailscale').state).toBe('fail');
    for (const k of ['tailnet', 'serve', 'allowed-host']) {
      expect(by(checks, k).state, k).toBe('skip');
    }
    // Fly is an independent system — it must still be checked.
    expect(by(checks, 'fly').state).toBe('ok');
  });

  it('skips the app and secrets when flyctl is not authenticated', async () => {
    const checks = await runChecks({ ...green, exec: greenExec({ 'fly auth whoami': fail() }) });
    expect(by(checks, 'fly-auth').state).toBe('fail');
    expect(by(checks, 'app').state).toBe('skip');
    expect(by(checks, 'secrets').state).toBe('skip');
  });

  it('catches the ADR 040 gate and prescribes the allow-list command', async () => {
    const checks = await runChecks({ ...green, probeUpgrade: async () => 'rejected' as const });
    const c = by(checks, 'allowed-host');
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('ws_upgrade_rejected');
    // Both forms, because the container resolves the daemon by IP (Fly owns /etc/resolv.conf, so
    // MagicDNS never installs) — an allow-list carrying only the name still fails.
    expect(c.fix).toContain('musterd service install --allowed-hosts');
    expect(c.fix).toContain('nicks-laptop.tail400343.ts.net');
    expect(c.fix).toContain('100.100.246.14');
  });

  it('distinguishes a refusing daemon from an absent one', async () => {
    const checks = await runChecks({ ...green, probeUpgrade: async () => 'unreachable' as const });
    const c = by(checks, 'allowed-host');
    expect(c.state).toBe('fail');
    expect(c.fix).toContain('musterd service status');
    expect(c.fix).not.toContain('--allowed-hosts');
  });

  it('names the missing secret and never asks for a value it could print', async () => {
    const checks = await runChecks({
      ...green,
      exec: greenExec({
        'fly secrets list': ok(JSON.stringify([{ name: 'TS_AUTHKEY', digest: 'dc45' }])),
      }),
    });
    const c = by(checks, 'secrets');
    expect(c.state).toBe('fail');
    expect(c.fix).toContain('MUSTERD_STREAM_KEY=<twitch stream key>');
    expect(c.fix).not.toContain('TS_AUTHKEY=');
  });

  it('flags an unbuilt image and skips it outside a checkout', async () => {
    expect(by(await runChecks({ ...green, digest: null }), 'image')).toMatchObject({
      state: 'fail',
      fix: 'musterd stream build',
    });
    expect(by(await runChecks({ ...green, repoRoot: null }), 'image').state).toBe('skip');
  });
});
