import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectResult } from './harness.js';

// Hoisted mock state: the harnesses the doctor inspects + the primer classification + the folder
// binding (findBinding) so we can exercise the baked-claim-vs-binding.json value-coherence check.
const h = vi.hoisted(() => ({
  harnesses: [] as { label: string; detect: () => Promise<DetectResult> }[],
  primer: 'managed' as 'none' | 'unmarked' | 'managed',
  binding: null as Record<string, unknown> | null,
  roster: { members: [] as any[] },
  rosterThrows: false,
}));

vi.mock('./harnesses/index.js', () => ({
  get HARNESSES() {
    return h.harnesses;
  },
}));
vi.mock('./primer.js', () => ({ classifyPrimerTarget: () => h.primer }));
vi.mock('../config.js', () => ({ findBinding: () => h.binding }));
vi.mock('../client.js', () => ({
  HttpClient: class {
    async roster() {
      if (h.rosterThrows) throw new Error('unreachable');
      return h.roster;
    }
  },
}));

const { inspectProvisioning } = await import('./doctor.js');
const { writeGuidance, CANONICAL_SKILL_PATH } = await import('./guidance.js');
const { writeProvisionManifest } = await import('./manifest.js');

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

describe('inspectProvisioning — duplicate adapters (ADR 092)', () => {
  beforeEach(() => {
    h.harnesses = [];
    h.primer = 'none';
    h.binding = {
      server: 'http://x',
      team: 'dawn',
      surface: 'cli',
      claim: { mode: 'seat', name: 'Ada' },
    };
    h.roster = { members: [] };
    h.rosterThrows = false;
    process.env['MUSTERD_WORKSPACE'] = 'repo@main';
  });
  afterEach(() => {
    delete process.env['MUSTERD_WORKSPACE'];
  });

  function ada(...presences: { status: string; workspace: string }[]) {
    h.roster = {
      members: [
        { name: 'Ada', presences: presences.map((p) => ({ surface: 'claude-code', ...p })) },
      ],
    };
  }

  it('warns (note, not drift) when the seat has >1 live adapter in this workspace', async () => {
    ada({ status: 'online', workspace: 'repo@main' }, { status: 'online', workspace: 'repo@main' });
    const r = await inspectProvisioning('/x');
    expect(r.drift).toEqual([]);
    expect(r.notes.some((n) => n.includes('2 live adapters'))).toBe(true);
  });

  it('is quiet with a single live adapter in this workspace', async () => {
    ada({ status: 'online', workspace: 'repo@main' });
    const r = await inspectProvisioning('/x');
    expect(r.notes.some((n) => n.includes('live adapters'))).toBe(false);
  });

  it('ignores duplicates that live in a different workspace', async () => {
    ada(
      { status: 'online', workspace: 'repo@main' },
      { status: 'online', workspace: 'other@branch' },
    );
    const r = await inspectProvisioning('/x');
    expect(r.notes.some((n) => n.includes('live adapters'))).toBe(false);
  });

  it('does not count offline presences as live adapters', async () => {
    ada(
      { status: 'online', workspace: 'repo@main' },
      { status: 'offline', workspace: 'repo@main' },
    );
    const r = await inspectProvisioning('/x');
    expect(r.notes.some((n) => n.includes('live adapters'))).toBe(false);
  });

  it('stays silent when the server is unreachable (best-effort, never invents drift)', async () => {
    h.rosterThrows = true;
    const r = await inspectProvisioning('/x');
    expect(r.notes).toEqual([]);
    expect(r.drift).toEqual([]);
  });

  it('is silent for a role/chat folder with no fixed seat', async () => {
    h.binding = { server: 'http://x', team: 'dawn', surface: 'cli', claim: { mode: 'chat' } };
    ada({ status: 'online', workspace: 'repo@main' }, { status: 'online', workspace: 'repo@main' });
    const r = await inspectProvisioning('/x');
    expect(r.notes).toEqual([]);
  });
});

describe('inspectProvisioning — guidance drift (ADR 085)', () => {
  beforeEach(() => {
    h.harnesses = [];
    h.primer = 'none';
    h.binding = null;
  });

  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'musterd-doctor-'));
  }

  it('is quiet for a freshly written, unedited guidance surface', async () => {
    const dir = tmp();
    const g = writeGuidance(dir, [], { team: 'dawn' }); // canonical file only
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: g.files, contentVersion: g.contentVersion },
    });
    const r = await inspectProvisioning(dir);
    expect(r.drift).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it('flags a stale-version skill as drift (exit-1)', async () => {
    const dir = tmp();
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: [CANONICAL_SKILL_PATH], contentVersion: 0 },
    });
    // A file stamped at an older content version than the current template.
    const abs = join(dir, CANONICAL_SKILL_PATH);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'old body\n<!-- musterd:content v0 sha256:0000000000000000 -->\n');
    const r = await inspectProvisioning(dir);
    expect(r.drift.some((d) => d.includes('v0') && d.includes('musterd init'))).toBe(true);
  });

  it('flags a recorded-but-missing skill file as drift', async () => {
    const dir = tmp();
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: [CANONICAL_SKILL_PATH], contentVersion: 1 },
    });
    const r = await inspectProvisioning(dir);
    expect(r.drift.some((d) => d.includes('is gone'))).toBe(true);
  });

  it('does not flag a freshly-written, untouched skill as edited', async () => {
    // Regression guard: the stamp hashes the newline-normalized body, so an unedited file round-trips
    // and the doctor stays quiet. (Hashing the raw renderable falsely flagged every fresh file, since
    // the renderers `join('\n')` with no trailing newline.)
    const dir = tmp();
    const g = writeGuidance(dir, [], { team: 'dawn' });
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: g.files, contentVersion: g.contentVersion },
    });
    const r = await inspectProvisioning(dir);
    expect(r.notes.some((n) => n.includes('local edits'))).toBe(false);
  });

  it('reports a hand-edited skill as a warn-only note, not drift', async () => {
    const dir = tmp();
    const g = writeGuidance(dir, [], { team: 'dawn' });
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: g.files, contentVersion: g.contentVersion },
    });
    // Break the body so it no longer hashes to its own stamp.
    const abs = join(dir, CANONICAL_SKILL_PATH);
    writeFileSync(abs, readFileSync(abs, 'utf8').replace('Using musterd', 'MY EDIT'));
    const r = await inspectProvisioning(dir);
    expect(r.drift).toEqual([]);
    expect(r.notes.some((n) => n.includes('local edits'))).toBe(true);
  });
});
