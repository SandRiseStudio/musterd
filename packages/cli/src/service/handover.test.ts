import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearHandover, readHandover, writeHandover } from './handover.js';

describe('refresh handover record', () => {
  it('is valid only during its bounded grace window', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'guardian-handover-')), 'handover.json');
    writeHandover(path, { startedAt: 10_000, targetBuild: 'nextsha' });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ started_at: 10_000, target_build: 'nextsha' });
    expect(readHandover(path, 39_999)).toEqual({ startedAt: 10_000, targetBuild: 'nextsha' });
    expect(readHandover(path, 40_001)).toBeNull();

    clearHandover(path);
    expect(readHandover(path, 10_001)).toBeNull();
  });
});
