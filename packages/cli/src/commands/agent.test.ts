import { mkdtempSync, rmSync } from 'node:fs';
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
  saveBinding: vi.fn(),
  saveWorkspaceSpec: vi.fn(),
  writeSeatFile: vi.fn(),
  configure: vi.fn(async () => ({ target: 'claude mcp', activation: '' })),
  // dir is set to a real temp dir per-test (the command chdir's into it to register MCP).
  workspace: { dir: '', kind: 'worktree' as const, branch: 'agent/June', created: true },
  rosterHome: {} as Record<string, string>,
}));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'ritual',
    config: { server: 'http://localhost:4849', agentKeys: { ritual: 'mskey_team' } },
    http: { addMember: h.addMember, roster: h.roster, issueGrant: h.issueGrant },
  }),
}));
vi.mock('../config.js', () => ({
  loadConfig: () => ({ rosterHome: h.rosterHome }),
  saveBinding: h.saveBinding,
  saveWorkspaceSpec: h.saveWorkspaceSpec,
}));
vi.mock('../roster.js', () => ({ writeSeatFile: h.writeSeatFile }));
vi.mock('../onboard/harnesses/claudeCode.js', () => ({ claudeCode: { configure: h.configure } }));
vi.mock('../onboard/workspace.js', () => ({ provisionWorkspace: () => h.workspace }));

const { agentCommand } = await import('./agent.js');

describe('musterd agent <name>', () => {
  const cwd0 = process.cwd();
  beforeEach(() => {
    vi.clearAllMocks();
    h.rosterHome = {};
    h.workspace.dir = mkdtempSync(join(tmpdir(), 'magent-'));
  });
  afterEach(() => {
    process.chdir(cwd0); // safety: command restores cwd, but guard the suite if it ever throws mid-way
    rmSync(h.workspace.dir, { recursive: true, force: true });
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
        team: 'ritual',
        agent_key: 'mskey_team',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'June' },
      }),
    );
    // MCP registered with the v0.3 env triple + autojoin
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_AGENT_KEY).toBe('mskey_team');
    // claim is carried by binding.json (asserted above via saveBinding), not baked into the MCP env
    expect(entry.env.MUSTERD_CLAIM).toBeUndefined();
    expect(entry.env.MUSTERD_AUTOJOIN).toBe('1');

    // The secret-free committed launch spec is written (no agent_key/grant fields).
    expect(h.saveWorkspaceSpec).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({
        team: 'ritual',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'June' },
      }),
    );
    const specArg = h.saveWorkspaceSpec.mock.calls[0]![1] as Record<string, unknown>;
    expect(specArg.agent_key).toBeUndefined();
    expect(specArg.grant).toBeUndefined();
  });

  it('issues a standing grant and threads it into the binding + autojoin env (ADR 077)', async () => {
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    // A standing seat grant is minted so autojoin occupies without an approval request.
    expect(h.issueGrant).toHaveBeenCalledWith('ritual', {
      scope: 'seat',
      target: 'June',
      lifetime: 'standing',
    });
    // The grant is persisted in the workspace binding...
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({ grant: 'msgr_standing' }),
    );
    // ...and flows to MUSTERD_GRANT so the launched adapter claims with it.
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_GRANT).toBe('msgr_standing');
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
