import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { CliError } from '../errors.js';

const h = vi.hoisted(() => ({
  addMember: vi.fn(async () => ({ member: { name: 'June' }, token: 'mskd_tok' })),
  roster: vi.fn(async () => ({ members: [] as Array<{ name: string; kind: string }> })),
  issueGrant: vi.fn(async () => ({
    grant: { id: 'g1', target: 'June', scope: 'seat', lifetime: 'standing' },
    token: 'msgr_standing',
  })),
  mintBootstrapCredential: vi.fn(async () => ({
    credential: { id: 'bc1', use: 'claim_seat', target: 'June' },
    agent_key: 'mskey_scoped_june',
  })),
  saveBinding: vi.fn(),
  saveWorkspaceSpec: vi.fn(),
  writeSeatFile: vi.fn(),
  configure: vi.fn(async () => ({ target: 'claude mcp', activation: '' })),
  configureCursor: vi.fn(async () => ({ target: '.cursor/mcp.json', activation: '' })),
  configureCodex: vi.fn(async () => ({ target: '.codex/config.toml', activation: '' })),
  // dir is set to a real temp dir per-test (the command chdir's into it to register MCP).
  workspace: { dir: '', kind: 'worktree' as const, branch: 'agent/June', created: true },
  rosterHome: {} as Record<string, string>,
  // Mutable so a test can model the machine that has LOST the team agent key (the empty
  // `agentKeys` map an interrupted config prune leaves behind) — see the preflight suite.
  agentKeys: {} as Record<string, string>,
}));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'ritual',
    config: { server: 'http://localhost:4849', agentKeys: h.agentKeys },
    http: {
      addMember: h.addMember,
      roster: h.roster,
      issueGrant: h.issueGrant,
      mintBootstrapCredential: h.mintBootstrapCredential,
    },
  }),
}));
vi.mock('../config.js', () => ({
  loadConfig: () => ({ rosterHome: h.rosterHome }),
  saveBinding: h.saveBinding,
  saveWorkspaceSpec: h.saveWorkspaceSpec,
}));
vi.mock('../roster.js', () => ({ writeSeatFile: h.writeSeatFile }));
vi.mock('../onboard/harnesses/index.js', () => ({
  HARNESSES: [
    { id: 'claude-code', label: 'Claude Code', surface: 'claude-code', configure: h.configure },
    { id: 'cursor', label: 'Cursor', surface: 'cursor', configure: h.configureCursor },
    { id: 'codex', label: 'Codex', surface: 'codex', configure: h.configureCodex },
  ],
}));
vi.mock('../onboard/workspace.js', () => ({ provisionWorkspace: () => h.workspace }));

const { agentCommand } = await import('./agent.js');

describe('musterd agent <name>', () => {
  const cwd0 = process.cwd();
  beforeEach(() => {
    vi.clearAllMocks();
    h.rosterHome = {};
    h.agentKeys = { ritual: 'mskey_team' };
    delete process.env['MUSTERD_AGENT_KEY'];
    h.workspace.dir = mkdtempSync(join(tmpdir(), 'magent-'));
  });
  afterEach(() => {
    process.chdir(cwd0); // safety: command restores cwd, but guard the suite if it ever throws mid-way
    rmSync(h.workspace.dir, { recursive: true, force: true });
  });

  describe('the infra-touch gate (ADR 227 inc 2) — this verb rewrites the machine-shared MCP entry', () => {
    it('asks the gate with verb "agent" and prints the one warn line, then PROCEEDS', async () => {
      const infraGate = vi.fn(async () => 'nick holds platform — route an ask instead (ADR 227)');
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
        chunks.push(String(c));
        return true;
      });
      let code: number;
      try {
        code = await agentCommand(parseArgs(['June']), { infraGate });
      } finally {
        spy.mockRestore();
      }
      expect(code).toBe(0); // warn-never-block: the provisioning still ran
      expect(infraGate).toHaveBeenCalledWith('agent');
      expect(chunks.join('')).toContain('nick holds platform');
      expect(h.configure).toHaveBeenCalled(); // proceeded through to the shared-entry write
    });

    it('stays silent when the gate answers null — holder, human shell, or unreachable daemon', async () => {
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
        chunks.push(String(c));
        return true;
      });
      let code: number;
      try {
        code = await agentCommand(parseArgs(['June']), { infraGate: async () => null });
      } finally {
        spy.mockRestore();
      }
      expect(code).toBe(0);
      expect(chunks.join('')).not.toContain('ADR 227');
    });
  });

  it('adds the agent, binds the workspace, and registers MCP with autojoin', async () => {
    const code = await agentCommand(parseArgs(['June', '--role', 'engineer']));
    expect(code).toBe(0);

    expect(h.addMember).toHaveBeenCalledWith('ritual', {
      name: 'June',
      kind: 'agent',
      role: 'engineer',
    });
    // binding written into the workspace dir with the team agent key + seat claim (v0.3, ADR 075)
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({
        version: 2,
        team: 'ritual',
        agent_key: 'mskey_scoped_june',
        claim: { mode: 'seat', name: 'June' },
      }),
    );
    // v2 identity carries no surface (ADR 281) — runtime Surface is launcher-only (ADR 286).
    const bindingArg = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(bindingArg['surface']).toBeUndefined();
    // MCP registered with NO secret (agent_key/grant) in the harness config, so an in-tree config
    // (Cursor/Codex) is commit-safe (ADR 018/115) — and, critically, **no `MUSTERD_BINDING`** (ADR 143).
    //
    // This assertion used to be its inverse. Naming the binding file in the env looked harmless, because
    // we chdir into the worktree first — but Claude Code keys its *local* MCP scope by **repo root**, and
    // every seat worktree is a git worktree of the same repo. So the env was one global slot that each
    // `musterd agent` overwrote, and provisioning one seat re-pointed *every live session on the machine*
    // at it. On 2026-07-13 they all booted as `dolly` and superseded each other off their own seats.
    //
    // The adapter anchors on the binding it finds by walking up from its **cwd** — genuinely per-worktree,
    // unlike the shared config — so the env was never needed here. Omitting it makes the shared entry
    // identical for every seat, and therefore harmless.
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_BINDING).toBeUndefined();
    // ADR 165 + increment 2 completed what the comment above began: the shared entry carries
    // NOTHING. Surface/key/claim live in binding.json; autojoin/driver (the last two baked names)
    // moved there too — the entry env is fully empty for the agent path.
    expect(entry.env).toEqual({});

    // The secret-free committed launch spec is written (no agent_key/grant fields).
    expect(h.saveWorkspaceSpec).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({
        version: 2,
        team: 'ritual',
        claim: { mode: 'seat', name: 'June' },
      }),
    );
    const specArg = h.saveWorkspaceSpec.mock.calls[0]![1] as Record<string, unknown>;
    expect(specArg.agent_key).toBeUndefined();
    expect(specArg.grant).toBeUndefined();
    expect(specArg['surface']).toBeUndefined();
  });

  it('writes the ADR 261 permissions floor into the WORKTREE so a non-interactive seat works day one', async () => {
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    const settings = JSON.parse(
      readFileSync(join(h.workspace.dir, '.claude', 'settings.local.json'), 'utf8'),
    ) as { permissions?: { allow?: string[]; deny?: string[] } };
    // The ryder shape, closed at the source: Edit/Write and the repo gates present, no deny.
    expect(settings.permissions?.allow).toEqual(expect.arrayContaining(['Edit', 'Write', 'Read']));
    expect(settings.permissions?.allow?.some((e) => e.startsWith('Bash(pnpm '))).toBe(true);
    expect(settings.permissions?.deny ?? []).toEqual([]);
  });

  it('--profile read-only layers the deny ceiling over the floor (ADR 261 decision 3)', async () => {
    const code = await agentCommand(parseArgs(['Watcher', '--profile', 'read-only']));
    expect(code).toBe(0);
    const settings = JSON.parse(
      readFileSync(join(h.workspace.dir, '.claude', 'settings.local.json'), 'utf8'),
    ) as { permissions?: { allow?: string[]; deny?: string[] } };
    expect(settings.permissions?.deny).toEqual(expect.arrayContaining(['Edit', 'Write']));
    // Deny-wins-allows-kept: the floor's allows stay present and inert under the ceiling.
    expect(settings.permissions?.allow).toContain('Read');
  });

  it('--profile provisions the workspace without touching the team fact (ADR 272 inc 2)', async () => {
    const code = await agentCommand(parseArgs(['Watcher', '--profile', 'read-only']));
    expect(code).toBe(0);
    // No role label reaches the roster from a profile pick — a profile is configuration, not identity.
    expect(h.addMember).toHaveBeenCalledWith('ritual', { name: 'Watcher', kind: 'agent' });
  });

  it('--role is the team fact only — it labels the member and provisions NOTHING (ADR 272 inc 2)', async () => {
    const code = await agentCommand(parseArgs(['Watcher', '--role', 'read-only']));
    expect(code).toBe(0);
    expect(h.addMember).toHaveBeenCalledWith('ritual', {
      name: 'Watcher',
      kind: 'agent',
      role: 'read-only',
    });
    const settings = JSON.parse(
      readFileSync(join(h.workspace.dir, '.claude', 'settings.local.json'), 'utf8'),
    ) as { permissions?: { deny?: string[] } };
    // Even a label that NAMES a profile compiles no ceiling — the coupling is what inc 2 removed.
    expect(settings.permissions?.deny ?? []).toEqual([]);
  });

  it('--role <label> --profile <name> sets the label from one and the workspace from the other', async () => {
    const code = await agentCommand(
      parseArgs(['Watcher', '--role', 'auditor', '--profile', 'read-only']),
    );
    expect(code).toBe(0);
    expect(h.addMember).toHaveBeenCalledWith('ritual', {
      name: 'Watcher',
      kind: 'agent',
      role: 'auditor',
    });
    const settings = JSON.parse(
      readFileSync(join(h.workspace.dir, '.claude', 'settings.local.json'), 'utf8'),
    ) as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toEqual(expect.arrayContaining(['Edit', 'Write']));
  });

  it('an unknown --profile still creates the seat — permissions are best-effort (floor-only, no throw)', async () => {
    const code = await agentCommand(parseArgs(['Zed', '--profile', 'no-such-profile']));
    expect(code).toBe(0);
  });

  it('--driver <you> records the driver in binding.json, never the shared entry (ADR 155/165 inc 2)', async () => {
    const code = await agentCommand(parseArgs(['June', '--driver', 'nick']));
    expect(code).toBe(0);
    // The entry is repo-root-shared: a driver baked there marked EVERY sibling worktree as driven.
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_DRIVER).toBeUndefined();
    const binding = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(binding.driver).toBe('nick');
  });

  it('writes autojoin into the binding (per-worktree), not the shared entry (ADR 165 inc 2)', async () => {
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    const binding = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(binding.autojoin).toBe(true);
    expect(binding.driver).toBeUndefined(); // opt-in: no driver unless asked (ADR 155)
  });

  it('issues a standing grant and persists it in the binding (source of truth), not the env (ADR 077)', async () => {
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    // A standing seat grant is minted so autojoin occupies without an approval request.
    expect(h.issueGrant).toHaveBeenCalledWith('ritual', {
      scope: 'seat',
      target: 'June',
      lifetime: 'standing',
    });
    // The grant is persisted in the workspace binding.json — the adapter reads it via MUSTERD_BINDING.
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({ grant: 'msgr_standing' }),
    );
    // ...and is NOT inlined into the harness env (no secret baked into the config).
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_GRANT).toBeUndefined();
  });

  it('still comes online if the grant mint fails (falls back to the approval lane)', async () => {
    h.issueGrant.mockRejectedValueOnce(new Error('not admin'));
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    // No grant in the binding; autojoin will route through the approval lane instead.
    const binding = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(binding.grant).toBeUndefined();
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_GRANT).toBeUndefined();
  });

  it('--harness cursor wires the Cursor adapter — and bakes no surface anywhere', async () => {
    const code = await agentCommand(parseArgs(['June', '--harness', 'cursor']));
    expect(code).toBe(0);
    expect(h.configureCursor).toHaveBeenCalled();
    expect(h.configure).not.toHaveBeenCalled();
    // v2 identity carries no surface (ADR 281): the launcher provides it at runtime (ADR 286).
    const bindingArg = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(bindingArg['surface']).toBeUndefined();
    const specArg = h.saveWorkspaceSpec.mock.calls[0]![1] as Record<string, unknown>;
    expect(specArg['surface']).toBeUndefined();
    const entry = h.configureCursor.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_SURFACE).toBeUndefined();
  });

  it('--harness codex wires the Codex adapter', async () => {
    const code = await agentCommand(parseArgs(['June', '--harness', 'codex']));
    expect(code).toBe(0);
    expect(h.configureCodex).toHaveBeenCalled();
    expect(h.configure).not.toHaveBeenCalled();
    const entry = h.configureCodex.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_SURFACE).toBeUndefined();
  });

  it('defaults to the claude-code harness when --harness is omitted', async () => {
    await agentCommand(parseArgs(['June']));
    expect(h.configure).toHaveBeenCalled();
    expect(h.configureCursor).not.toHaveBeenCalled();
  });

  it('rejects an unknown harness with the valid set', async () => {
    await expect(agentCommand(parseArgs(['June', '--harness', 'emacs']))).rejects.toThrow(
      /unknown harness "emacs".*claude-code, cursor, codex/s,
    );
  });

  it('writes a seat file first for a file-backed team', async () => {
    h.rosterHome = { ritual: '/home/ritual/.musterd' };
    await agentCommand(parseArgs(['June']));
    expect(h.writeSeatFile).toHaveBeenCalledWith('/home/ritual/.musterd', 'June', {
      kind: 'agent',
    });
  });

  it('still succeeds when MCP registration fails (member + workspace already done)', async () => {
    h.configure.mockRejectedValueOnce(new Error('claude not found'));
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    expect(h.saveBinding).toHaveBeenCalled(); // workspace was still provisioned
  });

  it('is idempotent: reuses an already-declared agent seat and still (re)builds the workspace', async () => {
    // e.g. the seat was already created via `team add June` — addMember conflicts.
    h.addMember.mockRejectedValueOnce(
      new CliError('member "June" already exists in "ritual"', 9, 'conflict'),
    );
    h.roster.mockResolvedValueOnce({ members: [{ name: 'June', kind: 'agent' }] });
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    expect(h.saveBinding).toHaveBeenCalled(); // workspace still provisioned
    expect(h.configure).toHaveBeenCalled(); // MCP still wired
  });

  it('refuses to reuse a seat that already exists as a human', async () => {
    h.addMember.mockRejectedValueOnce(
      new CliError('member "June" already exists in "ritual"', 9, 'conflict'),
    );
    h.roster.mockResolvedValueOnce({ members: [{ name: 'June', kind: 'human' }] });
    await expect(agentCommand(parseArgs(['June']))).rejects.toThrow(/as a human, not an agent/);
    expect(h.saveBinding).not.toHaveBeenCalled();
  });

  it('rejects a name with whitespace', async () => {
    await expect(agentCommand(parseArgs(['two words']))).rejects.toThrow(/usage/);
  });
});

describe('the agent workspace receives its own scoped bootstrap credential', () => {
  it('does not require the legacy team agent key on this machine', async () => {
    h.agentKeys = {};
    h.rosterHome = { ritual: '/tmp/ritual-home' };
    expect(await agentCommand(parseArgs(['June']), { infraGate: async () => null })).toBe(0);
    expect(h.mintBootstrapCredential).toHaveBeenCalledWith('ritual', {
      use: 'claim_seat',
      target: 'June',
      label: expect.any(String),
    });
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({ agent_key: 'mskey_scoped_june' }),
    );
  });

  it('does not fall back to an ambient legacy key', async () => {
    process.env['MUSTERD_AGENT_KEY'] = 'mskey_legacy';
    await agentCommand(parseArgs(['June']), { infraGate: async () => null });
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({ agent_key: 'mskey_scoped_june' }),
    );
  });
});

describe('musterd agent <name> --hue (ADR 374)', () => {
  const cwd0 = process.cwd();
  beforeEach(() => {
    vi.clearAllMocks();
    h.rosterHome = {};
    h.agentKeys = { ritual: 'mskey_team' };
    h.workspace.dir = mkdtempSync(join(tmpdir(), 'magent-hue-'));
  });
  afterEach(() => {
    process.chdir(cwd0);
    rmSync(h.workspace.dir, { recursive: true, force: true });
  });

  it('writes the hue into the seat file on a file-backed team and sends it to the daemon', async () => {
    h.rosterHome = { ritual: h.workspace.dir };
    await agentCommand(parseArgs(['June', '--hue', '212']));
    expect(h.writeSeatFile).toHaveBeenCalledWith(
      h.workspace.dir,
      'June',
      expect.objectContaining({ kind: 'agent', hue: 212 }),
    );
    expect(h.addMember).toHaveBeenCalledWith('ritual', expect.objectContaining({ hue: 212 }));
  });

  it('refuses a hue off the wheel before touching anything', async () => {
    await expect(agentCommand(parseArgs(['June', '--hue', '360']))).rejects.toThrow(/0.*359/);
    expect(h.writeSeatFile).not.toHaveBeenCalled();
    expect(h.addMember).not.toHaveBeenCalled();
  });
});
