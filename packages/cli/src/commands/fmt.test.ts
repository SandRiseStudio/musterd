import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Parsed } from '../args.js';
import { fmtCommand } from './fmt.js';

const P = (flags: Record<string, string | boolean> = {}): Parsed => ({
  flags,
  positionals: ['fmt'],
});

let dir: string;

function writeMusterd(
  team: string,
  seats: Record<string, string>,
  roles?: Record<string, string>,
): void {
  mkdirSync(join(dir, '.musterd', 'seats'), { recursive: true });
  writeFileSync(join(dir, '.musterd', 'team.toml'), team);
  for (const [n, b] of Object.entries(seats)) {
    writeFileSync(join(dir, '.musterd', 'seats', `${n}.toml`), b);
  }
  if (roles) {
    mkdirSync(join(dir, '.musterd', 'roles'), { recursive: true });
    for (const [n, b] of Object.entries(roles)) {
      writeFileSync(join(dir, '.musterd', 'roles', `${n}.toml`), b);
    }
  }
}

/** Run fmt with --json and read the payload it printed. */
async function captureJson(parsed: Parsed): Promise<{ exit: number; json: any }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    chunks.push(String(c));
    return true;
  });
  try {
    const exit = await fmtCommand(parsed, dir);
    return { exit, json: JSON.parse(chunks.join('')) };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-fmt-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('musterd fmt (ADR 058 guard 2)', () => {
  it('names DATA LOSS separately from cosmetic drift — an unknown key is a deletion, not a tidy-up', async () => {
    // The measured live instance: seats/autorefresh.toml carries an authored `charter`, which is in
    // RoleFileSchema but NOT SeatFileSchema, so fmt deletes it. Byte-comparison alone reports this
    // identically to a stray blank line; it must not.
    writeMusterd('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\ncharter = "A paragraph a human wrote."\n',
    });
    const out = await captureJson(P({ check: true, json: true }));
    expect(out.exit).toBe(1);
    expect(out.json.dataLoss).toEqual([{ file: 'seats/olive.toml', keys: ['charter'] }]);
  });

  it('a cosmetic-only drift is NOT reported as data loss', async () => {
    writeMusterd('slug   =   "alpha"\n', { olive: 'role="reviewer"\nkind="agent"\n' });
    const out = await captureJson(P({ check: true, json: true }));
    expect(out.exit).toBe(1);
    expect(out.json.drifted.length).toBeGreaterThan(0);
    // The whole point: drift alone must never masquerade as deletion.
    expect(out.json.dataLoss).toEqual([]);
  });

  it('every data-loss file is also drifted — the invariant the exit code relies on', async () => {
    // An unknown key is absent from the serialized form, so its file's bytes ALWAYS differ. That
    // makes dataLoss a strict subset of drifted, which is why the exit condition does not mention
    // it. Pinned rather than assumed: if a schema ever round-tripped an unknown key, this breaks
    // and the exit code would start missing data loss silently.
    writeMusterd('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\nnot_a_real_key = "keepme"\n',
    });
    const out = await captureJson(P({ check: true, json: true }));
    expect(out.json.dataLoss).toEqual([{ file: 'seats/olive.toml', keys: ['not_a_real_key'] }]);
    for (const d of out.json.dataLoss) expect(out.json.drifted).toContain(d.file);
    expect(out.exit).toBe(1);
  });

  it('formats roles/*.toml — the durable class ADR 298 gave a writer but no formatter', async () => {
    writeMusterd(
      'slug = "alpha"\n',
      { olive: 'kind = "agent"\nrole = "reviewer"\n' },
      // Reversed key order + sloppy spacing, exactly what a hand-written role file looks like.
      { platform: 'charter   =  "Owns the rails."\nsummary="Platform."\n' },
    );
    expect(await fmtCommand(P(), dir)).toBe(0);
    expect(readFileSync(join(dir, '.musterd', 'roles', 'platform.toml'), 'utf8')).toBe(
      'summary = "Platform."\ncharter = "Owns the rails."\n',
    );
    expect(await fmtCommand(P({ check: true }), dir)).toBe(0);
  });

  it('--check FAILS on a non-canonical role file, and names it', async () => {
    writeMusterd(
      'slug = "alpha"\n',
      { olive: 'kind = "agent"\nrole = "reviewer"\n' },
      { platform: 'charter = "Owns the rails."\nsummary = "Platform."\n' },
    );
    expect(await fmtCommand(P({ check: true, json: true }), dir)).toBe(1);
  });

  it('a team with no roles/ dir still formats — absence is not an error', async () => {
    writeMusterd('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    expect(await fmtCommand(P({ check: true }), dir)).toBe(0);
  });

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
