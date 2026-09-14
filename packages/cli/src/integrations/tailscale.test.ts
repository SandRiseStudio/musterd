import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  inspectTailscaleTransport,
  parseTailscaleSelf,
  probeUpgradeHost,
  serveForwardsPort,
  type TailscaleDoctorDeps,
  type UpgradeVerdict,
} from './tailscale.js';

const status = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: 'daemon.tailnet.ts.net.',
    TailscaleIPs: ['100.64.0.10', 'fd7a:115c:a1e0::1'],
    Online: true,
  },
});

describe('Tailscale inspection primitives (ADR 385)', () => {
  it('parses the running MagicDNS name and first IPv4 address through the vendor schema', () => {
    expect(parseTailscaleSelf(status)).toEqual({
      dnsName: 'daemon.tailnet.ts.net',
      ip4: '100.64.0.10',
      running: true,
    });
  });

  it('rejects malformed JSON and JSON that is valid but misses the typed vendor fields', () => {
    expect(parseTailscaleSelf('not json')).toBeNull();
    expect(
      parseTailscaleSelf(
        JSON.stringify({ Self: { DNSName: 'x', TailscaleIPs: '100.64.0.1', Online: true } }),
      ),
    ).toBeNull();
  });

  it('recognizes only a serve entry that forwards the requested TCP port', () => {
    expect(
      serveForwardsPort(
        JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }),
        4849,
      ),
    ).toBe(true);
    expect(
      serveForwardsPort(
        JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:9999' } } }),
        4849,
      ),
    ).toBe(false);
    expect(serveForwardsPort(JSON.stringify({ TCP: { '4849': {} } }), 4849)).toBe(false);
    expect(serveForwardsPort('{}', 4849)).toBe(false);
  });

  it('classifies a Host-gate 403 as rejected and an upgrade as allowed', async () => {
    const listen = (handler: (socket: import('node:net').Socket) => void) =>
      new Promise<{ server: Server; port: number }>((resolve) => {
        const server = createServer();
        server.on('upgrade', (_req, socket) => handler(socket));
        server.listen(0, '127.0.0.1', () =>
          resolve({ server, port: (server.address() as { port: number }).port }),
        );
      });

    const denied = await listen((socket) => {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    await expect(
      probeUpgradeHost({ hostname: '127.0.0.1', port: denied.port }, 'daemon.tailnet.ts.net'),
    ).resolves.toBe('rejected');
    await new Promise<void>((resolve) => denied.server.close(() => resolve()));

    const allowed = await listen((socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
      socket.destroy();
    });
    await expect(
      probeUpgradeHost({ hostname: '127.0.0.1', port: allowed.port }, 'daemon.tailnet.ts.net'),
    ).resolves.toBe('allowed');
    await new Promise<void>((resolve) => allowed.server.close(() => resolve()));
  });
});

function doctorDeps(overrides: Partial<TailscaleDoctorDeps> = {}) {
  const calls: Array<[string, string[]]> = [];
  const upgrades: Array<[{ hostname: string; port: number }, string]> = [];
  const deps: TailscaleDoctorDeps = {
    exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (args[0] === 'version') return { code: 0, stdout: '1.80.0\n', stderr: '' };
      if (args[0] === 'status') return { code: 0, stdout: status, stderr: '' };
      return {
        code: 0,
        stdout: JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }),
        stderr: '',
      };
    },
    server: 'http://127.0.0.1:4849',
    fetch: async () => new Response('{}', { status: 200 }),
    probeUpgrade: async (origin, host) => {
      upgrades.push([origin, host]);
      return 'allowed';
    },
    ...overrides,
  };
  return { deps, calls, upgrades };
}

function byKey(checks: Awaited<ReturnType<typeof inspectTailscaleTransport>>) {
  return Object.fromEntries(checks.map((check) => [check.key, check]));
}

describe('Tailscale Team transport inspector (ADR 385)', () => {
  it('verifies the seven checks over the actual DNS and IPv4 paths using only read commands', async () => {
    const { deps, calls, upgrades } = doctorDeps();
    const checks = await inspectTailscaleTransport(deps);

    expect(checks.map((check) => check.key)).toEqual([
      'tailscale-installed',
      'tailnet-up',
      'daemon-secured-bind',
      'tailscale-serve',
      'daemon-host-gate',
      'daemon-http',
      'daemon-websocket',
    ]);
    expect(checks.every((check) => check.state === 'ok')).toBe(true);
    expect(calls).toEqual([
      ['tailscale', ['version']],
      ['tailscale', ['status', '--json']],
      ['tailscale', ['serve', 'status', '--json']],
    ]);
    expect(upgrades).toEqual([
      [{ hostname: '127.0.0.1', port: 4849 }, 'daemon.tailnet.ts.net'],
      [{ hostname: '127.0.0.1', port: 4849 }, '100.64.0.10'],
      [{ hostname: 'daemon.tailnet.ts.net', port: 4849 }, 'daemon.tailnet.ts.net'],
    ]);
  });

  it('fails a missing CLI and skips every dependent check without more effects', async () => {
    const { deps, calls } = doctorDeps({
      exec: (cmd, args) => {
        calls.push([cmd, args]);
        return { code: 127, stdout: '', stderr: 'missing' };
      },
    });
    const checks = byKey(await inspectTailscaleTransport(deps));
    expect(checks['tailscale-installed']?.state).toBe('fail');
    expect(
      Object.values(checks)
        .slice(1)
        .every((check) => check.state === 'skip'),
    ).toBe(true);
    expect(calls).toEqual([['tailscale', ['version']]]);
  });

  it.each([
    [
      'tailnet down',
      JSON.stringify({
        BackendState: 'Stopped',
        Self: { DNSName: 'daemon.ts.net.', TailscaleIPs: ['100.64.0.10'], Online: false },
      }),
    ],
    ['malformed status', '{"Self":{"DNSName":7}}'],
  ])('fails %s and skips its dependants', async (_name, statusBody) => {
    const base = doctorDeps();
    const exec = base.deps.exec;
    base.deps.exec = (cmd, args, opts) =>
      args[0] === 'status' ? { code: 0, stdout: statusBody, stderr: '' } : exec(cmd, args, opts);
    const checks = byKey(await inspectTailscaleTransport(base.deps));
    expect(checks['tailnet-up']?.state).toBe('fail');
    expect(checks['daemon-secured-bind']?.state).toBe('skip');
  });

  it.each(['http://0.0.0.0:4849', 'http://192.0.2.10:4849', 'https://daemon.example.test:4849'])(
    'rejects unsupported daemon origin %s and tells the operator to run on the daemon host',
    async (server) => {
      const { deps } = doctorDeps({ server });
      const checks = byKey(await inspectTailscaleTransport(deps));
      expect(checks['daemon-secured-bind']?.state).toBe('fail');
      expect(checks['daemon-secured-bind']?.fix).toMatch(/daemon host/i);
      expect(checks['tailscale-serve']?.state).toBe('skip');
    },
  );

  it('fails when Serve does not forward the configured non-default daemon port', async () => {
    const base = doctorDeps({ server: 'http://localhost:5858' });
    const exec = base.deps.exec;
    base.deps.exec = (cmd, args, opts) =>
      args[0] === 'serve'
        ? {
            code: 0,
            stdout: JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }),
            stderr: '',
          }
        : exec(cmd, args, opts);
    const checks = byKey(await inspectTailscaleTransport(base.deps));
    expect(checks['tailscale-serve']?.state).toBe('fail');
    expect(checks['daemon-host-gate']?.state).toBe('skip');
  });

  it.each([
    ['MagicDNS', 'daemon.tailnet.ts.net'],
    ['IPv4', '100.64.0.10'],
  ])('fails when the daemon Host gate rejects %s independently', async (_name, rejectedHost) => {
    const { deps } = doctorDeps({
      probeUpgrade: async (_origin, host): Promise<UpgradeVerdict> =>
        host === rejectedHost ? 'rejected' : 'allowed',
    });
    const checks = byKey(await inspectTailscaleTransport(deps));
    expect(checks['daemon-host-gate']?.state).toBe('fail');
    expect(checks['daemon-http']?.state).toBe('skip');
  });

  it('fails an unreachable tailnet HTTP path and skips the WebSocket path', async () => {
    const { deps } = doctorDeps({
      fetch: async () => {
        throw new Error('unreachable');
      },
    });
    const checks = byKey(await inspectTailscaleTransport(deps));
    expect(checks['daemon-http']?.state).toBe('fail');
    expect(checks['daemon-http']?.fix).toMatch(/MagicDNS/);
    expect(checks['daemon-websocket']?.state).toBe('skip');
  });

  it('falls back to the exact Tailscale IPv4 path when MagicDNS is unavailable', async () => {
    const urls: string[] = [];
    const { deps, upgrades } = doctorDeps({
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('daemon.tailnet.ts.net')) throw new Error('getaddrinfo ENOTFOUND');
        return new Response('{}', { status: 200 });
      },
      probeUpgrade: async (origin, host) => {
        upgrades.push([origin, host]);
        return origin.hostname === 'daemon.tailnet.ts.net' ? 'unreachable' : 'allowed';
      },
    });

    const checks = byKey(await inspectTailscaleTransport(deps));

    expect(checks['daemon-http']).toMatchObject({
      state: 'ok',
      detail: '/health reachable over Tailscale IPv4; MagicDNS unavailable',
    });
    expect(checks['daemon-websocket']).toMatchObject({
      state: 'ok',
      detail: '/ws upgrade reachable over Tailscale IPv4; MagicDNS unavailable',
    });
    expect(urls).toEqual([
      'http://daemon.tailnet.ts.net:4849/health',
      'http://100.64.0.10:4849/health',
    ]);
    expect(upgrades.slice(-2)).toEqual([
      [{ hostname: 'daemon.tailnet.ts.net', port: 4849 }, 'daemon.tailnet.ts.net'],
      [{ hostname: '100.64.0.10', port: 4849 }, '100.64.0.10'],
    ]);
  });

  it('fails a non-success HTTP response and a separately unreachable tailnet WebSocket', async () => {
    const badHttp = doctorDeps({ fetch: async () => new Response('', { status: 503 }) });
    expect(
      (await inspectTailscaleTransport(badHttp.deps)).find((check) => check.key === 'daemon-http')
        ?.state,
    ).toBe('fail');

    const badWs = doctorDeps({
      probeUpgrade: async (origin) => (origin.hostname === '127.0.0.1' ? 'allowed' : 'unreachable'),
    });
    expect(
      (await inspectTailscaleTransport(badWs.deps)).find(
        (check) => check.key === 'daemon-websocket',
      )?.state,
    ).toBe('fail');
  });

  it('fails IPv6-only self state with explicit guidance', async () => {
    const base = doctorDeps();
    const exec = base.deps.exec;
    base.deps.exec = (cmd, args, opts) =>
      args[0] === 'status'
        ? {
            code: 0,
            stdout: JSON.stringify({
              BackendState: 'Running',
              Self: {
                DNSName: 'daemon.ts.net.',
                TailscaleIPs: ['fd7a:115c:a1e0::1'],
                Online: true,
              },
            }),
            stderr: '',
          }
        : exec(cmd, args, opts);
    const checks = byKey(await inspectTailscaleTransport(base.deps));
    expect(checks['tailnet-up']?.state).toBe('fail');
    expect(checks['tailnet-up']?.detail).toMatch(/IPv4/i);
  });
});
