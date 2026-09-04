import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseTailscaleSelf, probeUpgradeHost, serveForwardsPort } from './tailscale.js';

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
    expect(parseTailscaleSelf(JSON.stringify({ Self: { DNSName: 'x', TailscaleIPs: '100.64.0.1', Online: true } }))).toBeNull();
  });

  it('recognizes only a serve entry that forwards the requested TCP port', () => {
    expect(serveForwardsPort(JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }), 4849)).toBe(true);
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
    await expect(probeUpgradeHost({ hostname: '127.0.0.1', port: denied.port }, 'daemon.tailnet.ts.net')).resolves.toBe('rejected');
    await new Promise<void>((resolve) => denied.server.close(() => resolve()));

    const allowed = await listen((socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.destroy();
    });
    await expect(probeUpgradeHost({ hostname: '127.0.0.1', port: allowed.port }, 'daemon.tailnet.ts.net')).resolves.toBe('allowed');
    await new Promise<void>((resolve) => allowed.server.close(() => resolve()));
  });
});
