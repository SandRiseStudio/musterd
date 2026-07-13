import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertBindSecurity,
  checkUpgrade,
  DEFAULT_HOST,
  HEARTBEAT_INTERVAL_MS,
  hostnameOf,
  isLocalPeer,
  isLoopbackHost,
  PRESENCE_TIMEOUT_MS,
  RECLAIM_GRACE_MS,
  resolveConfig,
} from './config.js';

// resolveConfig reads process.env; snapshot and restore so cases don't leak into each other.
const TOUCHED = [
  'MUSTERD_HOST',
  'MUSTERD_PORT',
  'MUSTERD_TLS_CERT',
  'MUSTERD_TLS_KEY',
  'MUSTERD_INSECURE_TRUST_PROXY',
  'MUSTERD_HEARTBEAT_INTERVAL_MS',
  'MUSTERD_PRESENCE_TIMEOUT_MS',
  'MUSTERD_REAPER_INTERVAL_MS',
  'MUSTERD_RECLAIM_GRACE_MS',
  'MUSTERD_ALLOWED_HOSTS',
  'MUSTERD_ALLOWED_ORIGINS',
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('isLoopbackHost', () => {
  it('accepts loopback names and the 127/8 block', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'LocalHost']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });
  it('rejects routable hosts and wildcards', () => {
    for (const h of [
      '0.0.0.0',
      '::',
      '10.0.0.1',
      '100.64.0.1',
      'box.tailnet.ts.net',
      '192.168.1.5',
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('isLocalPeer', () => {
  it('accepts a loopback peer, including the IPv4-mapped IPv6 form a dual-stack listener reports', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
      expect(isLocalPeer(a, false)).toBe(true);
    }
  });

  it('rejects a routable peer', () => {
    for (const a of ['10.0.0.1', '192.168.1.5', '100.64.0.1', '::ffff:203.0.113.7']) {
      expect(isLocalPeer(a, false)).toBe(false);
    }
  });

  // The whole point of the flag. Behind a TLS-terminating proxy every remote request arrives FROM the
  // proxy — i.e. from loopback — so a peer check that ignored trustProxy would read the open internet
  // as "local" and hand it the keys. Loopback must stop meaning "local" the moment we trust a proxy.
  it('trusts no peer at all when a proxy is trusted — loopback included', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isLocalPeer(a, true)).toBe(false);
    }
  });

  it('fails closed on a missing peer address (destroyed socket)', () => {
    expect(isLocalPeer(undefined, false)).toBe(false);
    expect(isLocalPeer('', false)).toBe(false);
  });
});

describe('assertBindSecurity', () => {
  it('always allows loopback, plaintext or not', () => {
    expect(() =>
      assertBindSecurity({ host: '127.0.0.1', hasTls: false, trustProxy: false }),
    ).not.toThrow();
    expect(() =>
      assertBindSecurity({ host: 'localhost', hasTls: false, trustProxy: false }),
    ).not.toThrow();
  });
  it('refuses a non-loopback plaintext bind, with guidance', () => {
    expect(() => assertBindSecurity({ host: '0.0.0.0', hasTls: false, trustProxy: false })).toThrow(
      /refusing to bind 0\.0\.0\.0 in plaintext/,
    );
    expect(() =>
      assertBindSecurity({ host: '10.0.0.1', hasTls: false, trustProxy: false }),
    ).toThrow(/cross-network-overlay\.md/);
  });
  it('allows a non-loopback bind with native TLS or a trusted proxy', () => {
    expect(() =>
      assertBindSecurity({ host: '10.0.0.1', hasTls: true, trustProxy: false }),
    ).not.toThrow();
    expect(() =>
      assertBindSecurity({ host: '10.0.0.1', hasTls: false, trustProxy: true }),
    ).not.toThrow();
  });
});

describe('hostnameOf', () => {
  it('strips ports and IPv6 brackets', () => {
    expect(hostnameOf('127.0.0.1:4849')).toBe('127.0.0.1');
    expect(hostnameOf('box.tailnet.ts.net')).toBe('box.tailnet.ts.net');
    expect(hostnameOf('[::1]:4849')).toBe('::1');
    expect(hostnameOf('[::1]')).toBe('::1');
  });
});

describe('checkUpgrade', () => {
  const cfg = {
    boundHost: '100.64.0.1',
    allowedHosts: ['daemon.example'],
    allowedOrigins: ['https://app.example'],
  };

  it('accepts a no-Origin client whose Host is the bound host (the CLI/MCP case)', () => {
    expect(checkUpgrade({ host: '100.64.0.1:4849' }, cfg)).toEqual({ ok: true });
  });
  it('accepts loopback and allowlisted Host', () => {
    expect(checkUpgrade({ host: 'localhost:4849' }, cfg).ok).toBe(true);
    expect(checkUpgrade({ host: 'daemon.example' }, cfg).ok).toBe(true);
  });
  it('rejects an un-allowlisted Origin (a browser drive-by)', () => {
    const r = checkUpgrade({ host: '100.64.0.1', origin: 'https://evil.example' }, cfg);
    expect(r.ok).toBe(false);
  });
  it('accepts an allowlisted Origin', () => {
    expect(checkUpgrade({ host: '100.64.0.1', origin: 'https://app.example' }, cfg).ok).toBe(true);
  });
  it('rejects a Host not loopback/bound/allowlisted (DNS-rebinding)', () => {
    const r = checkUpgrade({ host: 'attacker.example' }, cfg);
    expect(r).toEqual({ ok: false, reason: 'host not allowed: attacker.example' });
  });
  it('rejects a missing Host header', () => {
    expect(checkUpgrade({}, cfg)).toEqual({ ok: false, reason: 'missing Host header' });
  });
});

describe('resolveConfig', () => {
  it('defaults to loopback plaintext with compiled-in timeouts', () => {
    const c = resolveConfig();
    expect(c.host).toBe(DEFAULT_HOST);
    expect(c.tls).toBeNull();
    expect(c.scheme).toBe('ws');
    expect(c.trustProxy).toBe(false);
    expect(c.heartbeatIntervalMs).toBe(HEARTBEAT_INTERVAL_MS);
    expect(c.presenceTimeoutMs).toBe(PRESENCE_TIMEOUT_MS);
    expect(c.reclaimGraceMs).toBe(RECLAIM_GRACE_MS);
  });
  it('serves wss when both cert and key are configured', () => {
    const c = resolveConfig({ tlsCert: '/c.pem', tlsKey: '/k.pem' });
    expect(c.tls).toEqual({ certPath: '/c.pem', keyPath: '/k.pem' });
    expect(c.scheme).toBe('wss');
  });
  it('refuses a half-configured TLS', () => {
    expect(() => resolveConfig({ tlsCert: '/c.pem' })).toThrow(/half-configured/);
    process.env['MUSTERD_TLS_KEY'] = '/k.pem';
    expect(() => resolveConfig()).toThrow(/half-configured/);
  });
  it('reads tunable timeouts from env (WAN tuning), validating positivity', () => {
    process.env['MUSTERD_PRESENCE_TIMEOUT_MS'] = '120000';
    process.env['MUSTERD_RECLAIM_GRACE_MS'] = '90000';
    const c = resolveConfig();
    expect(c.presenceTimeoutMs).toBe(120_000);
    expect(c.reclaimGraceMs).toBe(90_000);
  });
  it('rejects a non-positive / non-numeric timeout', () => {
    process.env['MUSTERD_PRESENCE_TIMEOUT_MS'] = '-5';
    expect(() => resolveConfig()).toThrow(/positive integer/);
    process.env['MUSTERD_PRESENCE_TIMEOUT_MS'] = 'soon';
    expect(() => resolveConfig()).toThrow(/positive integer/);
  });
  it('parses trust-proxy and allowlists from env', () => {
    process.env['MUSTERD_INSECURE_TRUST_PROXY'] = 'true';
    process.env['MUSTERD_ALLOWED_HOSTS'] = 'a.example, b.example';
    process.env['MUSTERD_ALLOWED_ORIGINS'] = 'https://app.example';
    const c = resolveConfig();
    expect(c.trustProxy).toBe(true);
    expect(c.allowedHosts).toEqual(['a.example', 'b.example']);
    expect(c.allowedOrigins).toEqual(['https://app.example']);
  });
});
