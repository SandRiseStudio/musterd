import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Parsed } from '../args.js';
import { fmtCommand } from './fmt.js';

const P = (flags: Record<string, string | boolean> = {}): Parsed => ({
  flags,
  positionals: ['fmt'],
});

let dir: string;

function writeMusterd(team: string, seats: Record<string, string>): void {
  mkdirSync(join(dir, '.musterd', 'seats'), { recursive: true });
  writeFileSync(join(dir, '.musterd', 'team.toml'), team);
  for (const [n, b] of Object.entries(seats)) {
    writeFileSync(join(dir, '.musterd', 'seats', `${n}.toml`), b);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-fmt-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('musterd fmt (ADR 058 guard 2)', () => {
  it('--check fails (exit 1) on non-canonical files', async () => {
    writeMusterd('slug = "alpha"\n', { olive: 'role = "reviewer"\nkind = "agent"\n' }); // keys reversed
    expect(await fmtCommand(P({ check: true, json: true }), dir)).toBe(1);
  });

  it('rewrites to canonical, then --check passes', async () => {
    writeMusterd('slug   =   "alpha"\n', { olive: 'role="reviewer"\n\nkind="agent"\n' });
    expect(await fmtCommand(P(), dir)).toBe(0);
    expect(readFileSync(join(dir, '.musterd', 'seats', 'olive.toml'), 'utf8')).toBe(
      'kind = "agent"\nrole = "reviewer"\n',
    );
    expect(readFileSync(join(dir, '.musterd', 'team.toml'), 'utf8')).toBe('slug = "alpha"\n');
    expect(await fmtCommand(P({ check: true }), dir)).toBe(0);
  });

  it('is a no-op (exit 0) when files are already canonical', async () => {
    writeMusterd('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    expect(await fmtCommand(P(), dir)).toBe(0);
  });

  it('errors when there is no .musterd/team.toml', async () => {
    await expect(fmtCommand(P(), dir)).rejects.toThrow(/no \.musterd/);
  });
});
