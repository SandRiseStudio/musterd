import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';

// Stub the two heavy onboard entrypoints so we can assert *which* path `initCommand` takes.
const h = vi.hoisted(() => ({
  runInitDoctor: vi.fn(async () => 0),
  runInit: vi.fn(async () => 0),
}));
vi.mock('../onboard/doctor.js', () => ({ runInitDoctor: h.runInitDoctor }));
vi.mock('../onboard/init.js', () => ({ runInit: h.runInit }));

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

  it('`init --check --fix --json` stays a pure read-only report (no repair intermixed)', async () => {
    h.runInitDoctor.mockResolvedValueOnce(1);
    const code = await initCommand(parseArgs(['--check', '--fix', '--json']));
    expect(code).toBe(1);
    expect(h.runInit).not.toHaveBeenCalled();
  });
});
