import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';

const h = vi.hoisted(() => ({
  addMember: vi.fn(async () => ({ member: { name: 'June' }, token: 'mskd_tok' })),
  saveBinding: vi.fn(),
  writeSeatFile: vi.fn(),
  configure: vi.fn(async () => ({ target: 'claude mcp', activation: '' })),
  // dir is set to a real temp dir per-test (the command chdir's into it to register MCP).
  workspace: { dir: '', kind: 'worktree' as const, branch: 'agent/June', created: true },
  rosterHome: {} as Record<string, string>,
}));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'ritual',
    config: { server: 'http://localhost:4849' },
    http: { addMember: h.addMember },
  }),
}));
vi.mock('../config.js', () => ({
  loadConfig: () => ({ rosterHome: h.rosterHome }),
  saveBinding: h.saveBinding,
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
    // binding written into the workspace dir with the minted token
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({
        team: 'ritual',
        member: 'June',
        token: 'mskd_tok',
        surface: 'claude-code',
      }),
    );
    // MCP registered with the autojoin env
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_MEMBER).toBe('June');
    expect(entry.env.MUSTERD_TOKEN).toBe('mskd_tok');
    expect(entry.env.MUSTERD_AUTOJOIN).toBe('1');
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

  it('rejects a name with whitespace', async () => {
    await expect(agentCommand(parseArgs(['two words']))).rejects.toThrow(/usage/);
  });
});
