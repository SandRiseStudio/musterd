import { describe, expect, it } from 'vitest';
import { grokCandidates, probeGrokCli, resetGrokBinCache, resolveGrokBin } from './grokBin.js';

describe('resolveGrokBin', () => {
  it('probes PATH without a shell and caches a runnable executable', async () => {
    resetGrokBinCache();
    const calls: string[] = [];
    const runnable = async (cmd: string) => {
      calls.push(cmd);
      return { ok: cmd === 'grok' };
    };
    expect(await resolveGrokBin(runnable)).toBe('grok');
    expect(await resolveGrokBin(runnable)).toBe('grok');
    expect(calls).toEqual(['grok']);
  });

  it('does not cache a miss, so a later installation becomes visible', async () => {
    resetGrokBinCache();
    let installed = false;
    const runnable = async (cmd: string) => ({ ok: installed && cmd === 'grok' });
    expect(await resolveGrokBin(runnable)).toBeNull();
    installed = true;
    expect(await resolveGrokBin(runnable)).toBe('grok');
  });

  it('includes absolute fallbacks for a minimal launchd PATH', () => {
    expect(grokCandidates()).toEqual(
      expect.arrayContaining(['/opt/homebrew/bin/grok', '/usr/local/bin/grok']),
    );
  });
});

describe('probeGrokCli', () => {
  it('requires -p / --single and -r / --resume', async () => {
    const run = async (args: string[]) => {
      if (args[0] === '--version') return { ok: true, out: 'grok 1.0.13\n' };
      return { ok: true, out: 'Usage: grok [options]\n  -p, --single\n  -r, --resume <id>\n' };
    };
    await expect(probeGrokCli(run)).resolves.toEqual({ supported: true, version: '1.0.13' });
  });

  it('returns a short reason rather than command output for an incompatible install', async () => {
    const run = async () => ({ ok: true, out: 'untrusted diagnostic mskey_never-print' });
    await expect(probeGrokCli(run)).resolves.toEqual({
      supported: false,
      reason: 'Grok CLI does not advertise -p / --single',
    });
  });
});
