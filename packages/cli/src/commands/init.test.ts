import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';

// Stub the two heavy onboard entrypoints so we can assert *which* path `initCommand` takes.
const h = vi.hoisted(() => ({
  runInitDoctor: vi.fn(async () => 0),
  runInit: vi.fn(async () => 0),
  wireCommand: vi.fn(async () => 0),
  repair: 'init' as 'wire' | 'init' | undefined,
}));
vi.mock('../onboard/doctor.js', () => ({
  runInitDoctor: h.runInitDoctor,
  inspectProvisioning: async () => ({
    primerManaged: true,
    harnesses: [],
    drift: ['x'],
    notes: [],
    anyConfigured: true,
    ...(h.repair !== undefined ? { repair: h.repair } : {}),
  }),
}));
vi.mock('../onboard/init.js', () => ({ runInit: h.runInit }));
vi.mock('./wire.js', () => ({ wireCommand: h.wireCommand }));

const { initCommand } = await import('./init.js');

describe('musterd init dispatch (ADR 087 — --check --fix)', () => {
  afterEach(() => vi.clearAllMocks());

  it('bare `init` runs the interactive setup', async () => {
    await initCommand(parseArgs([]));
    expect(h.runInit).toHaveBeenCalledOnce();
    expect(h.runInitDoctor).not.toHaveBeenCalled();
  });

  it('`init --check` runs the read-only doctor and never repairs', async () => {
    h.runInitDoctor.mockResolvedValueOnce(1); // drift present
    const code = await initCommand(parseArgs(['--check']));
    expect(code).toBe(1);
    expect(h.runInitDoctor).toHaveBeenCalledOnce();
    expect(h.runInit).not.toHaveBeenCalled(); // no --fix ⇒ no write
  });

  it('`init --check --fix` repairs by re-running init when drift is found', async () => {
    h.runInitDoctor.mockResolvedValueOnce(1); // drift
    h.runInit.mockResolvedValueOnce(0);
    const code = await initCommand(parseArgs(['--check', '--fix']));
    expect(h.runInitDoctor).toHaveBeenCalledOnce();
    expect(h.runInit).toHaveBeenCalledOnce(); // repaired
    expect(code).toBe(0);
  });

  it('`init --check --fix` does NOT run init when the check is already clean', async () => {
    h.runInitDoctor.mockResolvedValueOnce(0); // healthy
    const code = await initCommand(parseArgs(['--check', '--fix']));
    expect(code).toBe(0);
    expect(h.runInit).not.toHaveBeenCalled(); // nothing to repair
  });

  it('repairs entry-only drift with `wire`, never full onboarding (ADR 165)', async () => {
    // `runInit` mints a member and trips the already-bound guard; on a repo-root-shared entry it also
    // repairs this seat by taking the slot from whoever holds it. `wire` is the headless rewrite.
    h.repair = 'wire';
    h.runInitDoctor.mockResolvedValueOnce(1);
    await initCommand(parseArgs(['--check', '--fix']));
    expect(h.wireCommand).toHaveBeenCalledOnce();
    expect(h.runInit).not.toHaveBeenCalled();
    h.repair = 'init';
  });

  it('falls back to full onboarding when the drift needs it', async () => {
    h.repair = 'init';
    h.runInitDoctor.mockResolvedValueOnce(1);
    await initCommand(parseArgs(['--check', '--fix']));
    expect(h.runInit).toHaveBeenCalledOnce();
    expect(h.wireCommand).not.toHaveBeenCalled();
  });

  it('`init --check --fix --json` stays a pure read-only report (no repair intermixed)', async () => {
    h.runInitDoctor.mockResolvedValueOnce(1);
    const code = await initCommand(parseArgs(['--check', '--fix', '--json']));
    expect(code).toBe(1);
    expect(h.runInit).not.toHaveBeenCalled();
  });
});
