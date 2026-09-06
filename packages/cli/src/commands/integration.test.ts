import { IntegrationDoctorReportSchema } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { CliError } from '../errors.js';
import type { Exec } from '../process.js';
import { integrationCommand, type IntegrationCommandDeps } from './integration.js';

const status = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'daemon.tailnet.ts.net.', TailscaleIPs: ['100.64.0.10'], Online: true },
});
const apertureConfig = {
  providers: { anthropic: { baseurl: 'https://api.anthropic.com', models: ['claude'] } },
  grants: [{
    src: ['tag:musterd-agent', 'tag:musterd-member-a7f3c2'],
    app: { 'tailscale.com/cap/aperture': [{ role: 'agent', models: ['claude'], quotas: [{ bucket: 'daily:<user>' }] }] },
  }],
  quotas: { 'daily:<user>': { capacity: '$10', rate: '$5/day', on_exceed: 'reject' } },
  database: { retention: { duration: '0', purge: ['captures', 'tools'], require_export: false } },
};

function harness(overrides: Partial<IntegrationCommandDeps> = {}) {
  const output: string[] = [];
  const commands: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const exec: Exec = (cmd, args) => {
    commands.push([cmd, ...args].join(' '));
    if (args[0] === 'version') return { code: 0, stdout: '1.80.0', stderr: '' };
    if (args[0] === 'status') return { code: 0, stdout: status, stderr: '' };
    return { code: 0, stdout: JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }), stderr: '' };
  };
  const deps: IntegrationCommandDeps = {
    exec,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ config: JSON.stringify(apertureConfig), hash: '8d14c921aabbccdd' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    probeUpgrade: async () => 'allowed',
    server: 'http://127.0.0.1:4849',
    now: () => 123,
    out: (text) => output.push(text),
    ...overrides,
  };
  return { deps, output, commands, requests };
}

async function run(argv: string[], overrides: Partial<IntegrationCommandDeps> = {}) {
  const state = harness(overrides);
  const code = await integrationCommand(parseArgs(argv), state.deps);
  return { ...state, code, text: state.output.join('') };
}

describe('musterd integration doctor (ADR 385)', () => {
  it('rejects missing and unknown subcommands as usage errors', async () => {
    for (const argv of [[], ['unknown']]) {
      await expect(integrationCommand(parseArgs(argv), harness().deps)).rejects.toMatchObject({ exitCode: 2 });
    }
  });

  it('renders healthy off sections with no subprocess or network effects when neither is selected', async () => {
    const result = await run(['doctor']);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual([]);
    expect(result.requests).toEqual([]);
    expect(result.text).toContain('TAILSCALE TRANSPORT — off');
    expect(result.text).toContain('APERTURE MODEL ENFORCEMENT — off');
  });

  it.each([
    ['Tailscale only', ['doctor', '--tailscale'], 3, 1, 0],
    ['Aperture only', ['doctor', '--aperture', 'https://aperture.tailnet.ts.net'], 0, 0, 1],
    ['both', ['doctor', '--tailscale', '--aperture', 'https://aperture.tailnet.ts.net'], 3, 1, 1],
  ] as const)('runs %s independently', async (_name, argv, commandCount, healthCount, apertureCount) => {
    const result = await run([...argv]);
    expect(result.code).toBe(0);
    expect(result.commands).toHaveLength(commandCount);
    expect(result.requests.filter((request) => request.url.endsWith('/health'))).toHaveLength(healthCount);
    expect(result.requests.filter((request) => request.url.endsWith('/api/config'))).toHaveLength(apertureCount);
  });

  it('returns 1 when a selected inspector fails', async () => {
    const result = await run(['doctor', '--tailscale'], {
      exec: () => ({ code: 127, stdout: '', stderr: 'missing' }),
    });
    expect(result.code).toBe(1);
    expect(result.text).toContain('TAILSCALE TRANSPORT — blocked');
  });

  it('emits exactly the protocol report as JSON without ANSI or commentary', async () => {
    const result = await run(['doctor', '--tailscale', '--json']);
    const parsed = JSON.parse(result.text);
    expect(IntegrationDoctorReportSchema.parse(parsed)).toEqual(parsed);
    expect(result.text).not.toMatch(/\x1b\[/);
    expect(result.text.trimEnd()).toBe(JSON.stringify(parsed));
  });

  it.each([
    'http://aperture.tailnet.ts.net',
    'ftp://aperture.tailnet.ts.net',
    'not-a-url',
  ])('requires HTTPS for a non-loopback Aperture URL: %s', async (url) => {
    await expect(integrationCommand(parseArgs(['doctor', '--aperture', url]), harness().deps)).rejects.toBeInstanceOf(CliError);
  });

  it.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
    'https://aperture.tailnet.ts.net',
  ])('accepts the secure or loopback Aperture URL %s', async (url) => {
    expect((await run(['doctor', '--aperture', url])).code).toBe(0);
  });

  it('rejects a valueless --aperture flag', async () => {
    await expect(integrationCommand(parseArgs(['doctor', '--aperture']), harness().deps)).rejects.toMatchObject({ exitCode: 2 });
  });

  it('makes exactly one bounded GET to /api/config', async () => {
    const result = await run(['doctor', '--aperture', 'https://aperture.tailnet.ts.net/base']);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.url).toBe('https://aperture.tailnet.ts.net/api/config');
    expect(result.requests[0]?.init?.method).toBe('GET');
    expect(result.requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['non-2xx', async () => new Response('provider_key=do-not-echo', { status: 503 })],
    ['malformed JSON', async () => new Response('provider_key=do-not-echo', { status: 200 })],
    ['wrong wrapper', async () => new Response(JSON.stringify({ config: 7, hash: 'x', secret: 'provider_key=do-not-echo' }), { status: 200 })],
  ] as const)('redacts response text for %s failures', async (_name, fetch) => {
    const result = await run(['doctor', '--aperture', 'https://aperture.tailnet.ts.net'], { fetch });
    expect(result.code).toBe(1);
    expect(result.text).not.toContain('do-not-echo');
    expect(result.text).toContain('Aperture config API');
  });

  it('permits only the three Tailscale reads and GET network requests', async () => {
    const result = await run(['doctor', '--tailscale', '--aperture', 'https://aperture.tailnet.ts.net']);
    expect(result.commands).toEqual([
      'tailscale version',
      'tailscale status --json',
      'tailscale serve status --json',
    ]);
    expect(result.requests.every((request) => request.init?.method === 'GET')).toBe(true);
  });
});
