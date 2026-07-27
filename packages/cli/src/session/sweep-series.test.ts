import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  latestFinding,
  readSweepSeries,
  repeatedDemotions,
  type SweepSample,
} from './sweep-series.js';

function sample(at: number, demoted: string[], extra: Partial<SweepSample> = {}): SweepSample {
  return {
    at,
    judged: 20,
    disagreed: demoted.length,
    dangerous: 0,
    demoted: demoted.length,
    workspaces: demoted.map((workspace) => ({ workspace, demoted: true })),
    ...extra,
  };
}

function seriesFile(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-sweep-'));
  const path = join(dir, 'series.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return path;
}

describe('readSweepSeries', () => {
  it('reads samples oldest-first and tolerates a missing file', () => {
    const path = seriesFile([sample(1, []), sample(2, ['/a'])]);
    expect(readSweepSeries(path).map((s) => s.at)).toEqual([1, 2]);
    expect(readSweepSeries(join(path, 'nope'))).toEqual([]);
  });

  it('skips a torn or non-conforming line rather than throwing', () => {
    // The writer appends; a run killed mid-write leaves a partial line. One bad line must not
    // blind the whole series — that would be the instrument silently producing nothing.
    const path = seriesFile([sample(1, ['/a'])]);
    writeFileSync(path, JSON.stringify(sample(1, ['/a'])) + '\n{"at":2,"jud', 'utf8');
    expect(readSweepSeries(path).map((s) => s.at)).toEqual([1]);
  });
});

describe('latestFinding', () => {
  it('is undefined when the newest sample is clean — silence at zero is the point', () => {
    expect(latestFinding([sample(1, ['/a']), sample(2, [])])).toBeUndefined();
  });

  it('is undefined for an empty series (never run) rather than inventing health', () => {
    expect(latestFinding([])).toBeUndefined();
  });

  it('reports the newest sample’s demoted workspaces', () => {
    const f = latestFinding([sample(1, []), sample(2, ['/a', '/b'])]);
    expect(f).toEqual({ at: 2, demoted: 2, workspaces: ['/a', '/b'], repeated: [] });
  });

  it('marks a workspace repeated only when the PREVIOUS sample demoted it too', () => {
    const f = latestFinding([sample(1, ['/a']), sample(2, ['/a', '/b'])]);
    expect(f?.repeated).toEqual(['/a']);
  });
});

describe('repeatedDemotions', () => {
  it('intersects the two samples by workspace', () => {
    expect(repeatedDemotions(sample(1, ['/a', '/c']), sample(2, ['/a', '/b']))).toEqual(['/a']);
  });

  it('is empty when there is no previous sample', () => {
    expect(repeatedDemotions(undefined, sample(2, ['/a']))).toEqual([]);
  });

  it('ignores workspaces present but not demoted', () => {
    const prev: SweepSample = {
      ...sample(1, []),
      workspaces: [{ workspace: '/a' }, { workspace: '/b', demoted: true }],
    };
    expect(repeatedDemotions(prev, sample(2, ['/a', '/b']))).toEqual(['/b']);
  });
});
