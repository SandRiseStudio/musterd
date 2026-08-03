import { describe, expect, it } from 'vitest';
import { codexCandidates, resetCodexBinCache, resolveCodexBin } from './codexBin.js';

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
