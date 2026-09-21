import { describe, expect, it } from 'vitest';
import { hasRunnable } from './claudeBin.js';

describe('hasRunnable', () => {
  it('returns help text a CLI prints on stderr (opencode 1.18.31 prints `run --help` there)', async () => {
    const res = await hasRunnable(process.execPath, [
      '-e',
      "process.stderr.write('Options:\\n  --format  format: default or json\\n')",
    ]);
    expect(res.ok).toBe(true);
    expect(res.out).toMatch(/\B--format\b/);
    expect(res.out).toMatch(/\bjson\b/);
  });

  it('keeps stdout first so a version on stdout is matched before stderr noise', async () => {
    const res = await hasRunnable(process.execPath, [
      '-e',
      "process.stdout.write('1.2.3\\n'); process.stderr.write('warning: 9.9.9 deprecated\\n')",
    ]);
    expect(res.ok).toBe(true);
    expect(/(\d+\.\d+\.\d+)/.exec(res.out)?.[1]).toBe('1.2.3');
  });
});
