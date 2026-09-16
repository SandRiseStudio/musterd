import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { provisioningDriftOf } from './format.js';

/**
 * The adapter half of workspace self-heal (spec 2026-09-16, ADR 408 increment 4).
 *
 * The CLI writes `.musterd/drift.json`; this reads it and turns it into a warning that rides the
 * SAME `warnings` array as build skew and the sync wedge. One array, one discriminator, one place a
 * client looks — a fact that exists only when something is wrong IS a warning, and a second key
 * beside `warnings` is a key the clients that do not know it will drop (which is the defect lane
 * 01M2NRYJEQ just fixed, one key over).
 */
describe('provisioningDriftOf', () => {
  const dirs: string[] = [];
  const dir = (cache?: unknown): string => {
    const d = mkdtempSync(join(tmpdir(), 'musterd-pd-'));
    mkdirSync(join(d, '.musterd'));
    dirs.push(d);
    if (cache !== undefined) {
      writeFileSync(join(d, '.musterd', 'drift.json'), JSON.stringify(cache));
    }
    return d;
  };
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  const row = (over: Record<string, unknown> = {}) => ({
    inspected_at: 1700,
    build: 'abc',
    guidance: 2,
    hooks: 1,
    permissions: 0,
    declined: false,
    ...over,
  });

  it('reports the counts as a warning on the shared array', () => {
    const w = provisioningDriftOf(dir(row()));
    expect(w).toMatchObject({
      kind: 'provisioning_drift',
      guidance: 2,
      hooks: 1,
      permissions: 0,
      declined: false,
      repairable_at: 'session-start',
      inspected_at: 1700,
    });
    expect(String(w!.text)).toMatch(/musterd/);
  });

  // Guidance and in-worktree hooks are what increment 3 self-heals; the permission floor never is
  // (ADR 261 — it is the harness's security boundary). So a folder whose ONLY drift is permissions
  // will not improve by starting a new session, and saying "session-start" would be a lie a reader
  // would act on by doing nothing.
  it('is manual when only the permission floor is behind', () => {
    const w = provisioningDriftOf(dir(row({ guidance: 0, hooks: 0, permissions: 3 })));
    expect(w).toMatchObject({ repairable_at: 'manual', permissions: 3 });
    expect(String(w!.text)).toMatch(/--refresh-permissions/);
  });

  // The tombstone is the kill switch: drift is real and nothing will repair it by itself, so the
  // reader is the only thing that can. Naming session-start here would send them to a repair that
  // has been switched off in this folder.
  it('is manual when self-heal is declined, however repairable the drift', () => {
    const w = provisioningDriftOf(dir(row({ declined: true })));
    expect(w).toMatchObject({ repairable_at: 'manual', declined: true });
  });

  // Silence, on the same terms as build skew: an unknown state is never reported as a problem.
  it('is silent with no cache, an unparseable cache, or a clean one', () => {
    expect(provisioningDriftOf(dir())).toBeNull();
    const bad = dir();
    writeFileSync(join(bad, '.musterd', 'drift.json'), '{nope');
    expect(provisioningDriftOf(bad)).toBeNull();
    expect(provisioningDriftOf(dir(row({ guidance: 0, hooks: 0, permissions: 0 })))).toBeNull();
  });

  it('is silent rather than throwing when the folder cannot be read', () => {
    expect(provisioningDriftOf(join(tmpdir(), 'musterd-pd-does-not-exist'))).toBeNull();
    expect(provisioningDriftOf(undefined)).toBeNull();
  });

  // The line lands in model context at every inbox check, so it names counts and the commands that
  // fix them — never paths. Which file drifted does not change what the reader types.
  it('names only the repairs the counts actually call for', () => {
    const only = provisioningDriftOf(dir(row({ guidance: 1, hooks: 0, permissions: 0 })));
    expect(String(only!.text)).toMatch(/--refresh-guidance/);
    expect(String(only!.text)).not.toMatch(/--refresh-hooks/);
    expect(String(only!.text)).not.toMatch(/--refresh-permissions/);
  });
});
