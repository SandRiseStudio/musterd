import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import type { Exec, ExecResult } from '../broadcast/hosted.js';
import { CliError } from '../errors.js';
import { streamCommand, type StreamDeps } from './stream.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

const TS_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'nicks-laptop.tail400343.ts.net.', TailscaleIPs: ['100.100.246.14'] },
});

function greenExec(over: Record<string, ExecResult> = {}): Exec {
  return (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    for (const [prefix, result] of Object.entries(over)) {
      if (key.startsWith(prefix)) return result;
    }
    if (key === 'tailscale version') return ok('1.80.0');
    if (key === 'tailscale status --json') return ok(TS_STATUS);
    if (key === 'tailscale serve status --json')
      return ok(JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }));
    if (key === 'fly version') return ok('flyctl v0.3.0');
    if (key === 'fly auth whoami') return ok('nick@example.com');
    if (key.startsWith('fly status')) return ok('{}');
    if (key.startsWith('fly secrets list'))
      return ok(
        JSON.stringify([
          { name: 'TS_AUTHKEY', digest: 'dc45' },
          { name: 'MUSTERD_STREAM_KEY', digest: '26a8' },
        ]),
      );
    if (key.startsWith('fly machine list')) return ok('[]');
    return { code: 1, stdout: '', stderr: `unexpected: ${key}` };
  };
}

describe('musterd stream', () => {
  let repo: string;
  let out: string[];
  let base: StreamDeps;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'musterd-stream-'));
    mkdirSync(join(repo, 'scripts', 'broadcast'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'broadcast', 'hosted.Dockerfile'), '# marker\n');
    out = [];
    base = {
      exec: greenExec(),
      probeUpgrade: async () => 'allowed',
      cwd: repo,
      server: 'http://127.0.0.1:4849',
      out: (s) => void out.push(s),
      err: (s) => void out.push(s),
    };
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const run = (argv: string[], over: Partial<StreamDeps> = {}) =>
    streamCommand(parseArgs(argv), { ...base, ...over });

  const digest = 'sha256:' + 'a'.repeat(64);
  const withImage = () =>
    writeFileSync(join(repo, 'scripts', 'broadcast', '.image-digest'), digest);

  it('needs a subcommand and rejects an unknown one', async () => {
    await expect(run([])).rejects.toThrow(CliError);
    await expect(run(['blast'])).rejects.toThrow(/unknown subcommand/);
  });

  describe('doctor', () => {
    it('exits 0 and says ready on a fully-green system', async () => {
      withImage();
      expect(await run(['doctor'])).toBe(0);
      expect(out.join('')).toContain('ready');
    });

    it('exits 1 and prints the repair when something is missing', async () => {
      // No .image-digest written — the image check is the one that fails.
      expect(await run(['doctor'])).toBe(1);
      const text = out.join('');
      expect(text).toContain('capture image built');
      expect(text).toContain('musterd stream build');
    });

    it('emits machine-readable checks under --json', async () => {
      const code = await run(['doctor', '--json']);
      const doc = JSON.parse(out.join('')) as {
        ok: boolean;
        checks: { key: string; state: string }[];
      };
      expect(code).toBe(1);
      expect(doc.ok).toBe(false);
      expect(doc.checks.map((c) => c.key)).toContain('allowed-host');
    });

    it('probes the daemon on the configured port, not a hardcoded one', async () => {
      const seen: string[] = [];
      await run(['doctor'], {
        server: 'http://127.0.0.1:9999',
        probeUpgrade: async (h) => (seen.push(h), 'allowed'),
      });
      expect(seen).toEqual(['nicks-laptop.tail400343.ts.net', '100.100.246.14']);
      expect(out.join('')).toContain('tailscale serve forwards 9999');
    });
  });

  describe('start', () => {
    it('refuses without a recorded image rather than running a tag', async () => {
      await expect(run(['start'])).rejects.toThrow(/stream build/);
    });

    it('refuses when a machine is already live', async () => {
      withImage();
      const exec = greenExec({
        'fly machine list': ok(JSON.stringify([{ id: 'abc123', state: 'started' }])),
      });
      await expect(run(['start'], { exec })).rejects.toThrow(/already live \(machine abc123\)/);
    });

    it('refuses when the tailnet address cannot be discovered', async () => {
      withImage();
      const exec = greenExec({ 'tailscale status': { code: 1, stdout: '', stderr: '' } });
      await expect(run(['start'], { exec })).rejects.toThrow(/tailnet address/);
    });
  });

  describe('stop / status', () => {
    it('is a no-op when nothing is live', async () => {
      expect(await run(['stop'])).toBe(0);
      expect(out.join('')).toContain('nothing live');
      out.length = 0;
      expect(await run(['status'])).toBe(0);
      expect(out.join('')).toContain('not live');
    });

    it('stops the started machine with SIGINT so ffmpeg finalizes', async () => {
      const calls: string[][] = [];
      const inner = greenExec({
        'fly machine list': ok(JSON.stringify([{ id: 'abc123', state: 'started' }])),
        'fly machine stop': ok(''),
      });
      const exec: Exec = (cmd, args) => (calls.push([cmd, ...args]), inner(cmd, args));
      expect(await run(['stop'], { exec })).toBe(0);
      expect(calls).toContainEqual([
        'fly',
        'machine',
        'stop',
        'abc123',
        '-a',
        'musterd-broadcast',
        '--signal',
        'SIGINT',
        '--timeout',
        '30',
      ]);
    });

    it('reports the live machine and honours --app', async () => {
      const exec = greenExec({
        'fly machine list': ok(JSON.stringify([{ id: 'abc123', state: 'started' }])),
      });
      expect(await run(['status', '--app', 'other-app'], { exec })).toBe(0);
      expect(out.join('')).toContain('abc123');
      expect(out.join('')).toContain('other-app');
    });
  });
});
