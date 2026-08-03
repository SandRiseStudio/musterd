import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectResult } from './harness.js';

// Hoisted mock state: the harnesses the doctor inspects + the primer classification + the folder
// binding (findBinding) so we can exercise the baked-claim-vs-binding.json value-coherence check.
const h = vi.hoisted(() => ({
  bindings: {} as Record<string, { team: string; seat: string; surface: string }>,
  harnesses: [] as { label: string; detect: () => Promise<DetectResult> }[],
  primer: 'managed' as 'none' | 'unmarked' | 'managed',
  binding: null as Record<string, unknown> | null,
  roster: { members: [] as any[] },
  rosterThrows: false,
  agentKeys: {} as Record<string, string>,
  knownIdentities: [] as { team: string; name: string; key: string; surface: string }[],
}));

vi.mock('./harnesses/index.js', () => ({
  get HARNESSES() {
    return h.harnesses;
  },
}));
vi.mock('./primer.js', () => ({ classifyPrimerTarget: () => h.primer }));
vi.mock('../config.js', () => ({
  findBinding: () => h.binding,
  // ADR 162: the doctor reads the binding registry to note stale entries.
  loadConfig: () => ({
    bindings: h.bindings,
    // install-topology §6(a): the dead-binding check reads the team key it holds + the ADR 059 vault.
    agentKeys: h.agentKeys,
    knownIdentities: h.knownIdentities,
  }),
}));
vi.mock('../client.js', () => ({
  HttpClient: class {
    async roster() {
      if (h.rosterThrows) throw new Error('unreachable');
      return h.roster;
    }
  },
}));

const { buildSkewNotes, inspectProvisioning, runSessionProbe } = await import('./doctor.js');
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

/** A harness whose registered entry we can inspect — the read-back the poisoned-entry sweep needs. */
function harnessWithEntry(
  label: string,
  extra: {
    registeredModel?: string;
    registeredArgs?: string[];
    registeredGrant?: string;
    registeredAgentKey?: string;
  },
) {
  return {
    label,
    detect: async () => ({ installed: true, configured: true, detail: label, ...extra }),
  };
}

describe('inspectProvisioning', () => {
  beforeEach(() => {
    h.harnesses = [];
    h.primer = 'managed';
    h.binding = null;
    h.bindings = {};
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

  // The tripwire the #273 one was missing: it fired only on an ABSENT declaration, so a confidently
  // WRONG one looked identical to a correct one — the mode that poisons diversity conclusions while
  // looking healthy.
  it('flags a declaration contradicted by an observation, naming both and where the stale one lives', async () => {
    h.primer = 'managed';
    h.binding = {
      claim: { mode: 'seat', name: 'Miley' },
      model: 'grok-4.5',
      model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 },
    };
    h.harnesses = [harness('Claude Code', true, true)];
    const r = await inspectProvisioning('/x');
    const line = r.drift.find((d) => d.includes('claude-opus-4-8'));
    expect(line).toBeDefined();
    expect(line).toContain('grok-4.5');
    expect(line).toContain('binding.json');
  });

  it('is quiet when the observation agrees with the declaration', async () => {
    h.primer = 'managed';
    h.binding = {
      claim: { mode: 'seat', name: 'Miley' },
      model: 'claude-opus-4-8',
      model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 },
    };
    h.harnesses = [harness('Claude Code', true, true)];
    const r = await inspectProvisioning('/x');
    expect(r.drift).toEqual([]);
  });

  // The same tripwire one field over: `surface` never got `model`'s observation path, so it is
  // believed on a declaration alone while labelling presence, audit and the roster as fact.
  it('flags a declared surface contradicted by the harness that captured the session', async () => {
    h.primer = 'managed';
    h.binding = {
      claim: { mode: 'seat', name: 'Miley' },
      surface: 'cursor',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    };
    h.harnesses = [harness('Claude Code', true, true)];
    const r = await inspectProvisioning('/x');
    const line = r.drift.find((d) => d.includes('surface'));
    expect(line).toBeDefined();
    expect(line).toContain('cursor'); // the stale declaration
    expect(line).toContain('claude-code'); // what actually ran
    expect(line).toContain('MUSTERD_SURFACE'); // the rung above the binding, where it can also hide
  });

  it('falls back to the model observation when no session was captured', async () => {
    h.primer = 'managed';
    h.binding = {
      claim: { mode: 'seat', name: 'Miley' },
      surface: 'cursor',
      model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 1 },
    };
    h.harnesses = [harness('Claude Code', true, true)];
    const r = await inspectProvisioning('/x');
    expect(r.drift.find((d) => d.includes('surface'))).toBeDefined();
  });

  it('is quiet about surface when the capture agrees, or when nothing was ever captured', async () => {
    h.primer = 'managed';
    h.binding = {
      claim: { mode: 'seat', name: 'Miley' },
      surface: 'claude-code',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    };
    h.harnesses = [harness('Claude Code', true, true)];
    expect((await inspectProvisioning('/x')).drift).toEqual([]);

    // A declaration with no capture is not a contradiction. Codex has no hook path at all, so it
    // lives here permanently — warning would fire forever on every Codex seat.
    h.binding = { claim: { mode: 'seat', name: 'Miley' }, surface: 'codex' };
    expect((await inspectProvisioning('/x')).drift).toEqual([]);
  });

  it('is quiet when there is an observation but nothing was ever declared', async () => {
    // Nothing to contradict: the seat attests the observation and is not drifting.
    h.primer = 'managed';
    h.binding = {
      claim: { mode: 'seat', name: 'Miley' },
      model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 },
    };
    h.harnesses = [harness('Claude Code', true, true)];
    const r = await inspectProvisioning('/x');
    expect(r.drift).toEqual([]);
  });

  it('is quiet when a declaration exists but nothing has been observed yet', async () => {
    h.primer = 'managed';
    h.binding = { claim: { mode: 'seat', name: 'Miley' }, model: 'grok-4.5' };
    h.harnesses = [harness('Claude Code', true, true)];
    const r = await inspectProvisioning('/x');
    expect(r.drift).toEqual([]);
  });

  // Entries written before the unbake still carry a snapshot at the TOP of the adapter's ladder,
  // where no observation can correct it. The guard stops new ones; this finds the existing ones.
  it('flags a registered MUSTERD_MODEL as a legacy baked snapshot, with the removal command', async () => {
    h.primer = 'managed';
    h.binding = { claim: { mode: 'seat', name: 'Miley' } };
    h.harnesses = [harnessWithEntry('Claude Code', { registeredModel: 'grok-4.5' })];
    const r = await inspectProvisioning('/x');
    const line = r.drift.find((d) => d.includes('MUSTERD_MODEL'));
    expect(line).toBeDefined();
    expect(line).toContain('grok-4.5');
    expect(line).toContain('musterd wire');
  });

  // INVERTED by ADR 165. This used to fire only on a MISMATCH, which missed the common case: the
  // entry is shared by every worktree of the repo, so a grant that happens to match THIS folder's
  // binding is still a per-seat credential sitting in a slot every sibling reads.
  it("flags a baked grant even when it matches this folder's binding", async () => {
    h.primer = 'managed';
    h.binding = { claim: { mode: 'seat', name: 'Miley' }, grant: 'msgr_mine' };
    h.harnesses = [harnessWithEntry('Claude Code', { registeredGrant: 'msgr_mine' })];
    const r = await inspectProvisioning('/x');
    const line = r.drift.find((d) => d.includes('MUSTERD_GRANT'));
    expect(line).toBeDefined();
    expect(line).toContain('musterd wire');
  });

  it("flags a baked agent key — a sibling seat's team credential, not just a grant", async () => {
    h.primer = 'managed';
    h.binding = { claim: { mode: 'seat', name: 'Miley' } };
    h.harnesses = [harnessWithEntry('Claude Code', { registeredAgentKey: 'mskey_someone' })];
    const r = await inspectProvisioning('/x');
    expect(r.drift.find((d) => d.includes('MUSTERD_AGENT_KEY'))).toBeDefined();
  });

  it('marks entry-only drift as headlessly repairable', async () => {
    h.primer = 'managed';
    h.binding = { claim: { mode: 'seat', name: 'Miley' }, grant: 'msgr_mine' };
    h.harnesses = [harnessWithEntry('Claude Code', { registeredGrant: 'msgr_mine' })];
    const r = await inspectProvisioning('/x');
    expect(r.repair).toBe('wire');
  });

  it('does not claim headless repair when the drift needs full onboarding', async () => {
    // No primer + a configured harness ⇒ the "server wired, no primer" drift, which `wire` cannot fix.
    h.primer = 'none';
    h.binding = { claim: { mode: 'seat', name: 'Miley' } };
    h.harnesses = [harnessWithEntry('Claude Code', {})];
    const r = await inspectProvisioning('/x');
    expect(r.repair).toBe('init');
  });

  it('is quiet about a normal entry with no baked model and matching secrets', async () => {
    h.primer = 'managed';
    h.binding = { claim: { mode: 'seat', name: 'Miley' } };
    h.harnesses = [
      harnessWithEntry('Claude Code', { registeredArgs: ['/x/packages/mcp/dist/i.js'] }),
    ];
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

describe('inspectProvisioning — model attestation (ADR 120)', () => {
  beforeEach(() => {
    h.harnesses = [];
    h.primer = 'none';
    h.binding = {
      server: 'http://x',
      team: 'dawn',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'Ada' },
    };
    h.rosterThrows = false;
    process.env['MUSTERD_WORKSPACE'] = 'repo@main';
  });
  afterEach(() => {
    delete process.env['MUSTERD_WORKSPACE'];
  });

  it('reports an unknown live MCP attestation as a warn-only provisioning note', async () => {
    h.roster = {
      members: [
        {
          name: 'Ada',
          presences: [{ surface: 'claude-code', status: 'online', workspace: 'repo@main' }],
        },
      ],
    };

    const report = await inspectProvisioning('/x');

    expect(report.drift).toEqual([]);
    expect(report.notes).toContainEqual(
      expect.stringContaining('MCP model declaration is unknown'),
    );
  });
});

/**
 * The dead binding (install-topology §6(a)): a folder claiming a HUMAN seat while carrying the TEAM
 * AGENT KEY. It occupies once and then 403s forever, which is the state `/Users/nick/agents` was in
 * for two days. L1 (#457) stopped new ones being written; this check finds the ones already on disk.
 *
 * Three properties matter more than the happy path: it must not fire on the legitimate agent case
 * (every agent worktree has exactly this key), it must not invent a verdict when the roster is
 * unreachable (seat kind is only knowable there), and it must not route `--fix` at `musterd init` —
 * the command that wrote it.
 */
describe('inspectProvisioning — the dead binding (install-topology §6(a))', () => {
  beforeEach(() => {
    h.harnesses = [];
    h.primer = 'none';
    h.bindings = {};
    h.rosterThrows = false;
    h.agentKeys = { dawn: 'mskey_team' };
    h.knownIdentities = [];
    h.binding = {
      server: 'http://x',
      team: 'dawn',
      agent_key: 'mskey_team',
      surface: 'cli',
      claim: { mode: 'seat', name: 'nick' },
    };
    h.roster = { members: [{ name: 'nick', kind: 'human' }] };
  });

  it('reports a human seat bound with the team agent key as drift, not a note', async () => {
    const report = await inspectProvisioning('/ws');

    expect(report.drift).toContainEqual(
      expect.stringContaining('the binding carries the team agent key'),
    );
    expect(report.drift.join(' ')).toContain('/ws/.musterd/binding.json');
    expect(report.repair).toBe('identity');
  });

  it('names the rebind when this machine still holds their credential', async () => {
    h.knownIdentities = [{ team: 'dawn', name: 'nick', key: 'mscr_still_here', surface: 'cli' }];

    const report = await inspectProvisioning('/ws');

    expect(report.drift.join(' ')).toContain('musterd join dawn --as nick');
    // The destructive verb must NOT be suggested when nothing needs re-issuing.
    expect(report.drift.join(' ')).not.toContain('musterd team credential');
  });

  it('names the re-issue when it holds nothing usable — a vault entry of the team key is nothing', async () => {
    // The vault can hold the team key for this seat (that is how the dead binding got written in the
    // first place). Treating it as a credential would send the reader to a rebind that cannot work.
    h.knownIdentities = [{ team: 'dawn', name: 'nick', key: 'mskey_team', surface: 'cli' }];

    const report = await inspectProvisioning('/ws');

    expect(report.drift.join(' ')).toContain('musterd team credential nick');
    expect(report.drift.join(' ')).not.toContain('musterd join');
  });

  it('stays silent for an agent seat holding the same key — that is the correct shape', async () => {
    h.roster = { members: [{ name: 'nick', kind: 'agent' }] };

    const report = await inspectProvisioning('/ws');

    expect(report.drift).toEqual([]);
    expect(report.repair).toBeUndefined();
  });

  it('stays silent for an observer — hidden from the roster, and claimed with the team key by design', async () => {
    // ADR 063 observers never appear in the roster at all, so an absent name is not a verdict.
    h.roster = { members: [] };

    const report = await inspectProvisioning('/ws');

    expect(report.drift).toEqual([]);
    expect(report.repair).toBeUndefined();
  });

  it('stays silent when the binding carries a real seat credential', async () => {
    h.binding = { ...(h.binding as object), agent_key: 'mscr_mine' };

    const report = await inspectProvisioning('/ws');

    expect(report.drift).toEqual([]);
  });

  it('cannot verify with the daemon down: an honest note, never drift and never silence', async () => {
    h.rosterThrows = true;

    const report = await inspectProvisioning('/ws');

    expect(report.drift).toEqual([]);
    expect(report.notes).toContainEqual(expect.stringContaining(`couldn't verify seat "nick"`));
    // Says what the abstention costs, rather than leaving the reader to assume health (ADR 173).
    expect(report.notes.join(' ')).toContain('correct for an agent seat and dead for a human one');
  });

  it('does not run the check at all when the folder has no fixed-seat binding', async () => {
    h.binding = {
      server: 'http://x',
      team: 'dawn',
      agent_key: 'mskey_team',
      surface: 'cli',
      claim: { mode: 'role', role: 'backend' },
    };

    const report = await inspectProvisioning('/ws');

    expect(report.drift).toEqual([]);
    expect(report.notes.join(' ')).not.toContain('verify seat');
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

/**
 * ADR 171 — the expected set, not the receipt.
 *
 * The pre-171 doctor iterated the manifest's recorded file list, so a guidance file added to the
 * templates AFTER a folder was provisioned was never expected and therefore could never be missed:
 * the ADR 167 nudge-relay skill was absent from 8 of 8 dogfood worktrees and drew 0 drift lines.
 * Arm 1 below is that incident; arms 2-4 are the guards that keep the wider expected set from
 * inventing drift, and they are expected to pass both before and after (see the ADR).
 */
describe('inspectProvisioning — guidance expected-set drift (ADR 171)', () => {
  beforeEach(() => {
    h.harnesses = [];
    h.primer = 'managed';
    h.binding = null;
    h.bindings = {};
  });

  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'musterd-doctor-171-'));
  }

  /** A configured harness that declares guidance placement — the thing `guidanceTargets` reads. */
  function harnessWithGuidance(label: string, guidance: Record<string, string>, configured = true) {
    return {
      label,
      guidance: { frontmatter: 'claude-code', ...guidance },
      detect: async () => ({ installed: true, configured, detail: label }),
    };
  }

  /** Provision a folder with ONLY the canonical skill written + recorded — the pre-171 shape. */
  function provisionCanonicalOnly(dir: string): void {
    const g = writeGuidance(dir, [], { team: 'dawn' });
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: g.files, contentVersion: g.contentVersion },
    });
  }

  // ARM 1 — the incident. Fails against pre-171 code, which is the point.
  it('flags a guidance file added after this folder was provisioned', async () => {
    const dir = tmp();
    provisionCanonicalOnly(dir);
    // A skill this build would write, that postdates the manifest — never recorded, never on disk.
    h.harnesses = [
      harnessWithGuidance('Claude Code', {
        skillPath: '.musterd/skill/SKILL.md', // already written by provisionCanonicalOnly
        nudgeSkillPath: '.claude/skills/musterd-nudge-relay/SKILL.md',
      }),
    ];
    const r = await inspectProvisioning(dir);
    expect(
      r.drift.some((d) => d.includes('musterd-nudge-relay') && d.includes('--refresh-guidance')),
    ).toBe(true);
  });

  // ARM 2 — guard: a user's own file at a managed path is theirs, not drift.
  it('treats a stampless file at an expected path as a note, never drift', async () => {
    const dir = tmp();
    provisionCanonicalOnly(dir);
    const rel = '.claude/skills/musterd-nudge-relay/SKILL.md';
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'my own notes, no musterd stamp\n');
    h.harnesses = [
      harnessWithGuidance('Claude Code', {
        skillPath: '.musterd/skill/SKILL.md',
        nudgeSkillPath: rel,
      }),
    ];
    const r = await inspectProvisioning(dir);
    expect(r.drift.some((d) => d.includes('musterd-nudge-relay'))).toBe(false);
    expect(r.notes.some((n) => n.includes('musterd-nudge-relay'))).toBe(true);
  });

  // ARM 3 — guard: expectation is scoped to harnesses wired HERE, mirroring the hook check.
  it('expects nothing from a harness that is not configured in this folder', async () => {
    const dir = tmp();
    provisionCanonicalOnly(dir);
    h.harnesses = [
      harnessWithGuidance('Cursor', { skillPath: '.cursor/rules/musterd.mdc' }, false),
    ];
    const r = await inspectProvisioning(dir);
    expect(r.drift.some((d) => d.includes('.cursor'))).toBe(false);
  });

  // ARM 5 — the regression this ADR's own first implementation shipped, caught by its guard metric
  // on a live seat. `init` writes guidance for the ONE harness chosen at provisioning time, and
  // `--refresh-guidance` refuses to add a new harness's files (that is provisioning, not a refresh).
  // So expecting guidance from every CONFIGURED harness produced four drift lines on a real folder
  // that the prescribed command provably could not clear. Expectation must track what the repair
  // writes, which is `establishedHarnesses` — presence of the skill file, not detection of the tool.
  it('expects nothing from a configured harness this folder was never provisioned with', async () => {
    const dir = tmp();
    provisionCanonicalOnly(dir);
    h.harnesses = [
      // Configured — the tool is installed and the musterd server is registered — but its guidance
      // was never written here, so `--refresh-guidance` would not write it either.
      harnessWithGuidance('Cursor', {
        skillPath: '.cursor/rules/musterd.mdc',
        commandsDir: '.cursor/commands',
      }),
    ];
    const r = await inspectProvisioning(dir);
    expect(r.drift.some((d) => d.includes('.cursor'))).toBe(false);
  });

  // ARM 4 — guard: musterd retiring a path is not the folder's problem.
  it('is silent about a recorded path this build no longer writes', async () => {
    const dir = tmp();
    const g = writeGuidance(dir, [], { team: 'dawn' });
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      // A path musterd used to write and no longer does — absent on disk, and that is correct.
      guidance: {
        files: [...g.files, '.claude/skills/musterd-retired/SKILL.md'],
        contentVersion: g.contentVersion,
      },
    });
    const r = await inspectProvisioning(dir);
    expect(r.drift.some((d) => d.includes('musterd-retired'))).toBe(false);
  });

  // GUARD METRIC — one line per surface for one fact. Six identical-in-substance lines for a single
  // version bump is the noise failure mode ADR 168 pre-registered against its own instrument.
  it('collapses a fleet-wide version bump into one line, not one per file', async () => {
    const dir = tmp();
    const stale = ['.musterd/skill/SKILL.md', '.claude/commands/musterd-standup.md'];
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: stale, contentVersion: 0 },
    });
    for (const rel of stale) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, 'old body\n<!-- musterd:content v0 sha256:0000000000000000 -->\n');
    }
    h.harnesses = [
      harnessWithGuidance('Claude Code', {
        skillPath: '.musterd/skill/SKILL.md',
        commandsDir: '.claude/commands',
      }),
    ];
    const r = await inspectProvisioning(dir);
    const versionLines = r.drift.filter((d) => d.includes('v0') && d.includes('current is'));
    expect(versionLines).toHaveLength(1);
    expect(versionLines[0]).toContain('2 musterd guidance files');
  });
});

describe('build skew (ADR 135) — warn-only freshness, never drift', () => {
  const sha = (c: string) => c.repeat(40);
  // A temp non-git dir as repoDir keeps the origin/main comparison silent, isolating check (a).
  const noGit = () => mkdtempSync(join(tmpdir(), 'musterd-nogit-'));

  it('notes a CLI-vs-daemon mismatch, silent on match or unknown', async () => {
    const differs = await buildSkewNotes({
      cliRef: sha('a'),
      daemonBuild: async () => sha('d'),
      repoDir: noGit(),
    });
    expect(differs.join(' ')).toContain('differs from the daemon');
    expect(differs.join(' ')).toContain(sha('a').slice(0, 7));

    const matches = await buildSkewNotes({
      cliRef: sha('d'),
      daemonBuild: async () => sha('d'),
      repoDir: noGit(),
    });
    expect(matches).toEqual([]);

    // unstamped CLI → total silence (no daemon fetch even attempted)
    expect(await buildSkewNotes({ cliRef: undefined, repoDir: noGit() })).toEqual([]);
    // unreachable daemon → silence, never a throw
    const down = await buildSkewNotes({
      cliRef: sha('a'),
      daemonBuild: async () => {
        throw new Error('ECONNREFUSED');
      },
      repoDir: noGit(),
    });
    expect(down).toEqual([]);
  });

  // Found live: a seat with uncommitted edits builds `<sha>-dirty` while the daemon runs clean
  // `<sha>`. Both truncate to the same 7 chars for display, so the line read "your CLI build
  // (3260685) differs from the daemon (3260685)" — and prescribed a rebuild that could not help,
  // because the difference was the developer's own uncommitted work. It fired on every active seat
  // at every session start, which is the noise failure mode, not a freshness signal.
  it('does not call an uncommitted working tree skew (same commit, `-dirty` marker)', async () => {
    const dirty = await buildSkewNotes({
      cliRef: `${sha('a')}-dirty`,
      daemonBuild: async () => sha('a'),
      repoDir: noGit(),
    });
    expect(dirty).toEqual([]);
    // A genuinely different commit still reports, marker or not.
    const real = await buildSkewNotes({
      cliRef: `${sha('a')}-dirty`,
      daemonBuild: async () => sha('d'),
      repoDir: noGit(),
    });
    expect(real.some((n) => n.includes('differs from the daemon'))).toBe(true);
  });

  it('runSessionProbe prints one line on mismatch and ALWAYS exits 0 (hook contract)', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => {
      lines.push(String(c));
      return true;
    }) as never);
    // An unprovisioned temp folder so the artifact half of the probe stays silent, isolating skew.
    const bare = mkdtempSync(join(tmpdir(), 'musterd-bare-'));
    try {
      const mismatch = await runSessionProbe({
        cliRef: sha('a'),
        daemonBuild: async () => sha('d'),
        cwd: bare,
      });
      expect(mismatch).toBe(0);
      expect(lines.join('')).toContain('differs from the daemon');

      lines.length = 0;
      expect(
        await runSessionProbe({ cliRef: sha('d'), daemonBuild: async () => sha('d'), cwd: bare }),
      ).toBe(0);
      expect(lines.join('')).toBe('');
      expect(await runSessionProbe({ cliRef: undefined, cwd: bare })).toBe(0); // unstamped → silence
      expect(
        await runSessionProbe({
          cliRef: sha('a'),
          cwd: bare,
          daemonBuild: async () => {
            throw new Error('down');
          },
        }),
      ).toBe(0); // daemon down → silence, exit 0
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * ADR 171 increment 2 — detection delivery.
 *
 * The doctor's drift lines reached nobody: the `SessionStart` hook runs this probe and nothing else,
 * so guidance/hook drift was visible only to whoever deliberately typed `musterd init --check`. The
 * probe now carries artifact drift too. Its contract is the constraint: pure file I/O (no network,
 * no git, and no `detect()`, which shells out to `claude mcp get`), silent when clean, always exit 0,
 * and — because this stdout lands in model context every session — ONE bounded line however many
 * files drifted.
 */
describe('session-start probe — artifact drift (ADR 171 inc 2)', () => {
  const sha = (c: string) => c.repeat(40);

  beforeEach(() => {
    h.harnesses = [];
    h.primer = 'managed';
    h.binding = null;
    h.bindings = {};
  });

  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'musterd-probe-'));
  }

  /** Capture the probe's stdout for a folder, with build skew forced silent. */
  async function probe(cwd: string): Promise<string[]> {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => {
      lines.push(String(c));
      return true;
    }) as never);
    try {
      const code = await runSessionProbe({
        cliRef: sha('d'),
        daemonBuild: async () => sha('d'), // equal → no skew line
        cwd,
      });
      expect(code).toBe(0); // the hook contract, asserted on every single path
    } finally {
      spy.mockRestore();
    }
    return lines.join('').split('\n').filter(Boolean);
  }

  it('is silent on a folder with no musterd provisioning at all', async () => {
    expect(await probe(tmp())).toEqual([]);
  });

  it('is silent on a fully current folder — the steady state costs zero tokens', async () => {
    const dir = tmp();
    const g = writeGuidance(dir, [], { team: 'dawn' });
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: g.files, contentVersion: g.contentVersion },
    });
    expect(await probe(dir)).toEqual([]);
  });

  it('names guidance drift the doctor would have kept to itself', async () => {
    const dir = tmp();
    const g = writeGuidance(dir, [], { team: 'dawn' });
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: g.files, contentVersion: g.contentVersion },
    });
    h.harnesses = [
      {
        label: 'Claude Code',
        guidance: {
          frontmatter: 'claude-code',
          skillPath: '.musterd/skill/SKILL.md',
          nudgeSkillPath: '.claude/skills/musterd-nudge-relay/SKILL.md',
        },
        detect: async () => ({ installed: true, configured: true, detail: 'Claude Code' }),
      },
    ];
    const lines = await probe(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--refresh-guidance');
  });

  it('names hook drift, and stays ONE line however many artifacts drifted', async () => {
    const dir = tmp();
    const g = writeGuidance(dir, [], { team: 'dawn' });
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: g.files, contentVersion: g.contentVersion },
    });
    // A settings file with no musterd hooks at all: every hook carrying a `missing` line fires.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
    h.harnesses = [
      {
        label: 'Claude Code',
        guidance: {
          frontmatter: 'claude-code',
          skillPath: '.musterd/skill/SKILL.md',
          nudgeSkillPath: '.claude/skills/musterd-nudge-relay/SKILL.md',
        },
        detect: async () => ({ installed: true, configured: true, detail: 'Claude Code' }),
      },
    ];
    const lines = await probe(dir);
    // The token guard: several hooks AND a guidance file drifted, and it is still one line.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--refresh-guidance');
    expect(lines[0]).toContain('--refresh-hooks');
  });

  it('names only the repair that is actually needed', async () => {
    const dir = tmp();
    const g = writeGuidance(dir, [], { team: 'dawn' });
    writeProvisionManifest(dir, {
      role: 'x',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: g.files, contentVersion: g.contentVersion },
    });
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
    const lines = await probe(dir); // no harness guidance declared → guidance is clean
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--refresh-hooks');
    expect(lines[0]).not.toContain('--refresh-guidance');
  });
});

describe('binding-registry staleness note (ADR 162)', () => {
  beforeEach(() => {
    h.harnesses = [harness('Claude Code', true, true)];
    h.primer = 'managed';
    h.binding = null;
    h.bindings = {};
  });

  it('notes the count once stale entries are actually noisy, and names the fix', async () => {
    for (let i = 0; i < 6; i++) {
      h.bindings[join(tmpdir(), `musterd-doctor-gone-${i}`)] = {
        team: 'dawn',
        seat: 'scout',
        surface: 'claude-code',
      };
    }
    const r = await inspectProvisioning('/x');
    const note = r.notes.find((n) => n.includes('binding-registry'));
    expect(note).toContain('6 binding-registry entries');
    expect(note).toContain('--prune-bindings');
    expect(r.drift).toEqual([]); // warn-only, never exit-1
  });

  it('stays quiet below the threshold, and for folders that exist', async () => {
    h.bindings[join(tmpdir(), 'musterd-doctor-gone-solo')] = {
      team: 'dawn',
      seat: 'scout',
      surface: 'claude-code',
    };
    h.bindings[tmpdir()] = { team: 'revive', seat: 'stanley', surface: 'claude-code' };
    const r = await inspectProvisioning('/x');
    expect(r.notes.find((n) => n.includes('binding-registry'))).toBeUndefined();
  });
});

describe('seat git attribution (ADR 109)', () => {
  const made: string[] = [];
  function tmp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    made.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A real repo — this check shells out to git, so a fake path would only prove it stays quiet. */
  function repo(): string {
    const dir = tmp('musterd-attrib-');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'human@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Human'], { cwd: dir });
    return dir;
  }

  beforeEach(() => {
    h.harnesses = [harness('Claude Code', true, true)];
    h.binding = {
      server: 'http://x',
      team: 'revive',
      agent_key: 'mskey_team',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'miley' },
    };
    h.roster = { members: [{ name: 'miley', kind: 'agent' }] };
  });

  it('notes a worktree attributed to the human, and prescribes the surgical repair', async () => {
    const r = await inspectProvisioning(repo());
    const note = r.notes.find((n) => n.includes('attributed to'));
    expect(note).toBeDefined();
    expect(note).toContain('human@example.com');
    expect(note).toContain('git config --worktree user.name "miley (musterd seat)"');
    expect(note).toContain('git config --worktree user.email "miley@revive.musterd"');
    // Warn-only: attribution is not a functional failure, so it must never fail the check.
    expect(r.drift.find((d) => d.includes('attributed to'))).toBeUndefined();
  });

  it('must NOT prescribe `musterd init` — that repoints the MCP entry every seat shares (ADR 143)', async () => {
    const r = await inspectProvisioning(repo());
    const note = r.notes.find((n) => n.includes('attributed to'))!;
    expect(note).toContain('do NOT run `musterd init`');
  });

  it('stays quiet once the identity is set', async () => {
    const dir = repo();
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: dir });
    execFileSync('git', ['config', '--worktree', 'user.email', 'miley@revive.musterd'], {
      cwd: dir,
    });
    const r = await inspectProvisioning(dir);
    expect(r.notes.find((n) => n.includes('attributed to'))).toBeUndefined();
  });

  it('flags a WRONG identity too, not just a missing one — the two-spellings drift', async () => {
    // A seat still on the pre-team-slug domain lands under two names in any per-seat rollup.
    const dir = repo();
    execFileSync('git', ['config', 'user.email', 'miley@musterd.local'], { cwd: dir });
    const r = await inspectProvisioning(dir);
    const note = r.notes.find((n) => n.includes('attributed to'))!;
    expect(note).toContain('miley@musterd.local');
    expect(note).toContain('miley@revive.musterd');
  });

  it('stays quiet outside a git repo — a plain folder has no identity to carry', async () => {
    const r = await inspectProvisioning(tmp('musterd-attrib-plain-'));
    expect(r.notes.find((n) => n.includes('attributed to'))).toBeUndefined();
  });

  it('stays SILENT for a human member — a person must keep their real git identity', async () => {
    // Without this gate the check fires in the human's own primary checkout and prescribes replacing
    // nick.sanders.a@gmail.com with a synthetic nick@revive.musterd, breaking GitHub attribution.
    // Verified live: it did exactly that before the credential-prefix gate.
    const dir = repo();
    h.binding = {
      server: 'http://x',
      team: 'revive',
      agent_key: 'mscr_human_credential',
      surface: 'cli',
      claim: { mode: 'seat', name: 'nick' },
    };
    const r = await inspectProvisioning(dir);
    expect(r.notes.find((n) => n.includes('attributed to'))).toBeUndefined();
  });

  it('stays quiet with no seat to attribute (unprovisioned folder)', async () => {
    h.binding = null;
    const r = await inspectProvisioning(repo());
    expect(r.notes.find((n) => n.includes('attributed to'))).toBeUndefined();
  });
});
