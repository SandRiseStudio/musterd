import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSeat, seatFileExists, seatFilePath, writeSeatFile } from './roster.js';

describe('roster seat-file writer (ADR 058 §5)', () => {
  it('buildSeat drops lifecycle/until when forever (minimal shape)', () => {
    expect(buildSeat({ kind: 'agent', role: 'reviewer' })).toEqual({
      kind: 'agent',
      role: 'reviewer',
    });
    expect(buildSeat({ kind: 'agent', role: 'x', lifecycle: 'forever' })).toEqual({
      kind: 'agent',
      role: 'x',
    });
  });

  it('buildSeat keeps a non-forever lifecycle and normalizes until to canonical ISO', () => {
    expect(
      buildSeat({ kind: 'agent', role: 'x', lifecycle: 'until', until: '2026-07-01T00:00:00Z' }),
    ).toEqual({ kind: 'agent', role: 'x', lifecycle: 'until', until: '2026-07-01T00:00:00.000Z' });
    expect(buildSeat({ kind: 'human', role: '', lifecycle: 'session' })).toEqual({
      kind: 'human',
      role: '',
      lifecycle: 'session',
    });
  });

  describe('writeSeatFile', () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'musterd-roster-'));
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it('writes canonical TOML under <home>/.musterd/seats, token-free, coloured from birth (ADR 374)', () => {
      const p = writeSeatFile(home, 'olive', { kind: 'agent', role: 'reviewer' });
      expect(p).toBe(seatFilePath(home, 'olive'));
      expect(seatFileExists(home, 'olive')).toBe(true);
      const body = readFileSync(p, 'utf8');
      // The hue is assigned at write when the caller names none — the file is where a colour is born
      // on a file-backed team — and it lands as the last top-level key.
      expect(body).toMatch(/^kind = "agent"\nrole = "reviewer"\nhue = \d+\n$/);
      expect(body).not.toMatch(/token|mskd_/);
    });

    it('keeps an explicit hue, and a second seat is placed clear of the first', () => {
      writeSeatFile(home, 'olive', { kind: 'agent', role: 'reviewer', hue: 200 });
      expect(readFileSync(seatFilePath(home, 'olive'), 'utf8')).toBe(
        'kind = "agent"\nrole = "reviewer"\nhue = 200\n',
      );
      const p = writeSeatFile(home, 'olive-2', { kind: 'agent', role: 'reviewer' });
      const hue = Number(/hue = (\d+)/.exec(readFileSync(p, 'utf8'))![1]);
      expect(hue).not.toBe(200);
    });
  });
});
