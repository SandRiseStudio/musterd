import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectResult } from './harness.js';

// Hoisted mock state: the harnesses the doctor inspects + the primer classification + the folder
// binding (findBinding) so we can exercise the baked-claim-vs-binding.json value-coherence check.
const h = vi.hoisted(() => ({
  harnesses: [] as { label: string; detect: () => Promise<DetectResult> }[],
  primer: 'managed' as 'none' | 'unmarked' | 'managed',
  binding: null as { claim?: unknown } | null,
}));

vi.mock('./harnesses/index.js', () => ({
  get HARNESSES() {
    return h.harnesses;
  },
}));
vi.mock('./primer.js', () => ({ classifyPrimerTarget: () => h.primer }));
vi.mock('../config.js', () => ({ findBinding: () => h.binding }));

const { inspectProvisioning } = await import('./doctor.js');

function harness(label: string, installed: boolean, configured: boolean, registeredClaim?: string) {
  return {
    label,
    detect: async () => ({
      installed,
      configured,
      detail: label,
      ...(registeredClaim !== undefined ? { registeredClaim } : {}),
    }),
  };
}

describe('inspectProvisioning', () => {
  beforeEach(() => {
    h.harnesses = [];
    h.primer = 'managed';
    h.binding = null;
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

  it('flags a baked MUSTERD_CLAIM that disagrees with binding.json (the re-claim drift)', async () => {
    h.primer = 'managed';
    h.binding = { claim: { mode: 'seat', name: 'Miley' } };
    h.harnesses = [harness('Claude Code', true, true, 'seat:Sonnet')];
    const r = await inspectProvisioning('/x');
    expect(r.drift).toHaveLength(1);
    expect(r.drift[0]).toContain('MUSTERD_CLAIM=seat:Sonnet');
    expect(r.drift[0]).toContain('seat:Miley');
  });

  it('is quiet when the baked claim matches binding.json', async () => {
    h.primer = 'managed';
    h.binding = { claim: { mode: 'seat', name: 'Miley' } };
    h.harnesses = [harness('Claude Code', true, true, 'seat:Miley')];
    const r = await inspectProvisioning('/x');
    expect(r.drift).toEqual([]);
  });

  it('does not flag when the MCP env carries no baked claim (post-fix provisioning)', async () => {
    h.primer = 'managed';
    h.binding = { claim: { mode: 'seat', name: 'Miley' } };
    h.harnesses = [harness('Claude Code', true, true)]; // no registeredClaim
    const r = await inspectProvisioning('/x');
    expect(r.drift).toEqual([]);
  });
});
