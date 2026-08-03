import { describe, expect, it } from 'vitest';
import { codexCandidates, probeCodexCli, resetCodexBinCache, resolveCodexBin } from './codexBin.js';

describe('resolveCodexBin', () => {
  it('probes PATH without a shell and caches a runnable executable', async () => {
    resetCodexBinCache();
    const calls: string[] = [];
    const runnable = async (cmd: string) => {
      calls.push(cmd);
      return { ok: cmd === 'codex' };
    };
    expect(await resolveCodexBin(runnable)).toBe('codex');
    expect(await resolveCodexBin(runnable)).toBe('codex');
    expect(calls).toEqual(['codex']);
  });

  it('does not cache a miss, so a later installation becomes visible', async () => {
    resetCodexBinCache();
    let installed = false;
    const runnable = async (cmd: string) => ({ ok: installed && cmd === 'codex' });
    expect(await resolveCodexBin(runnable)).toBeNull();
    installed = true;
    expect(await resolveCodexBin(runnable)).toBe('codex');
  });

  it('includes absolute fallbacks for a minimal launchd PATH', () => {
    expect(codexCandidates()).toEqual(
      expect.arrayContaining([
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
      ]),
    );
  });
});

describe('probeCodexCli', () => {
  it('requires JSONL fresh exec and resume with an exact session id', async () => {
    const run = async (args: string[]) => {
      if (args[0] === '--version') return { ok: true, out: 'codex-cli 0.146.0\n' };
      if (args[1] === '--help') return { ok: true, out: 'Usage: codex exec [OPTIONS]\n  --json\n' };
      return {
        ok: true,
        out: 'Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\n  --json\n',
      };
    };
    await expect(probeCodexCli(run)).resolves.toEqual({ supported: true, version: '0.146.0' });
  });

  it('returns a short reason rather than command output for an incompatible install', async () => {
    const run = async () => ({ ok: true, out: 'untrusted diagnostic mskey_never-print' });
    await expect(probeCodexCli(run)).resolves.toEqual({
      supported: false,
      reason: 'Codex CLI does not advertise exec --json',
    });
  });
});
