import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectResult } from './harness.js';

// Hoisted mock state: the harnesses the doctor inspects + the primer classification.
const h = vi.hoisted(() => ({
  harnesses: [] as { label: string; detect: () => Promise<DetectResult> }[],
  primer: 'managed' as 'none' | 'unmarked' | 'managed',
}));

vi.mock('./harnesses/index.js', () => ({
  get HARNESSES() {
    return h.harnesses;
  },
}));
vi.mock('./primer.js', () => ({ classifyPrimerTarget: () => h.primer }));

const { inspectProvisioning } = await import('./doctor.js');

function harness(label: string, installed: boolean, configured: boolean) {
  return { label, detect: async () => ({ installed, configured, detail: label }) };
}

describe('inspectProvisioning', () => {
  beforeEach(() => {
    h.harnesses = [];
    h.primer = 'managed';
  });

  it('flags the headline drift: primer present but no server registered', async () => {
    h.primer = 'managed';
    h.harnesses = [harness('Claude Code', true, false)];
    const r = await inspectProvisioning('/x');
    expect(r.primerManaged).toBe(true);
    expect(r.anyConfigured).toBe(false);
    expect(r.drift).toHaveLength(1);
    expect(r.drift[0]).toContain('auto-joined');
  });

  it('is healthy when primer and server both present', async () => {
    h.primer = 'managed';
    h.harnesses = [harness('Claude Code', true, true)];
    const r = await inspectProvisioning('/x');
    expect(r.anyConfigured).toBe(true);
    expect(r.drift).toEqual([]);
  });

  it('flags the reverse drift: server registered but no primer', async () => {
    h.primer = 'none';
    h.harnesses = [harness('Claude Code', true, true)];
    const r = await inspectProvisioning('/x');
    expect(r.drift).toHaveLength(1);
    expect(r.drift[0]).toContain('no musterd primer');
  });

  it('does not flag an unprovisioned folder (no primer, no server)', async () => {
    h.primer = 'none';
    h.harnesses = [harness('Claude Code', true, false)];
    const r = await inspectProvisioning('/x');
    expect(r.drift).toEqual([]);
    expect(r.anyConfigured).toBe(false);
    expect(r.primerManaged).toBe(false);
  });

  it('does not flag a primer with no harness installed (nothing to fix)', async () => {
    h.primer = 'managed';
    h.harnesses = [harness('Claude Code', false, false)];
    const r = await inspectProvisioning('/x');
    expect(r.drift).toEqual([]);
  });

  it('treats any one configured harness as configured', async () => {
    h.primer = 'managed';
    h.harnesses = [harness('Claude Code', true, false), harness('Cursor', true, true)];
    const r = await inspectProvisioning('/x');
    expect(r.anyConfigured).toBe(true);
    expect(r.drift).toEqual([]);
  });
});
