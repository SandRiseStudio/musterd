import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// vi.mock calls below are hoisted above these imports, so init.js resolves the mocked deps.
import {
  cachedTeamLive,
  missingGitignoreEntries,
  runInit,
  runPruneBindings,
  runRefreshGuidance,
} from './init.js';

// Shared, hoisted test doubles the mock factories below close over.
const h = vi.hoisted(() => {
  const confirmQueue: unknown[] = [];
  const selectQueue: unknown[] = [];
  const textQueue: unknown[] = [];
  const http = {
    createTeam: vi.fn(async () => ({
      token: 'tok-creator',
      human_credential: 'mscr_creator',
      agent_key: 'mskey_team',
    })),
    addMember: vi.fn(async () => ({ token: 'tok-ada' })),
    roster: vi.fn(async () => ({ members: [{ name: 'Ada', presence: 'online' }] })),
    inbox: vi.fn(async () => ({ messages: [] })),
  };
  const harness = {
    id: 'claude-code',
    label: 'Claude Code',
    surface: 'claude-code',
    guidance: {
      skillPath: '.claude/skills/musterd/SKILL.md',
      frontmatter: 'claude-code' as const,
      commandsDir: '.claude/commands',
      sessionsSkillPath: '.claude/skills/musterd-label-sessions/SKILL.md',
    },
    detect: vi.fn(async () => ({ installed: true, configured: false, detail: 'claude 1.0' })),
    configure: vi.fn(async () => ({
      target: 'claude mcp (scope: local)',
      activation: 'run `claude` here',
      scope: 'wired into this folder only',
    })),
    provision: vi.fn(async (plan: { servers: { name: string }[] }) => ({
      servers: plan.servers.map((s) => s.name),
      permissions: { allow: [], ask: [], deny: [] },
      target: 'claude mcp (scope: local)',
    })),
  };
  const config: {
    server: string;
    current: string | undefined;
    identities: Record<string, { name: string; key: string; surface: string }>;
    knownIdentities: { team: string; name: string; key: string; surface: string }[];
    bindings: Record<string, { team: string; seat: string; surface: string }>;
    agentKeys: Record<string, string>;
    rosterHome: Record<string, string>;
  } = {
    server: 'http://localhost:4849',
    current: undefined,
    identities: {},
    knownIdentities: [],
    bindings: {},
    agentKeys: {},
    rosterHome: {},
  };
  // Queue of outcomes for the `watchClaim` fake (`musterd claim`'s live WS handshake, driven by
  // init.ts's "activate an existing member" branch, ADR 077) — one entry consumed per claim attempt.
  const claimQueue: Array<
    { state: 'occupied' } | { state: 'refused'; code: string; message: string }
  > = [];
  const box: { folderBinding: { team: string } | null; folderSpec: { team: string } | null } = {
    folderBinding: null,
    folderSpec: null,
  };
  const claimKeys: (string | undefined)[] = [];
  return {
    confirmQueue,
    selectQueue,
    textQueue,
    http,
    harness,
    config,
    claimQueue,
    claimKeys,
    ...box,
  };
});

vi.mock('@clack/prompts', () => ({
  isCancel: (v: unknown) => typeof v === 'symbol',
  cancel: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), step: vi.fn(), success: vi.fn(), error: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  confirm: vi.fn(async () => h.confirmQueue.shift()),
  select: vi.fn(async () => h.selectQueue.shift()),
  text: vi.fn(async () => h.textQueue.shift()),
}));

vi.mock('../client.js', () => ({
  HttpClient: vi.fn(() => h.http),
  // Fakes `musterd claim`'s live WS handshake for init.ts's "existing member" branch: consumes one
  // queued outcome and fires the matching callback on the next microtask (mirrors a real WS reply).
  watchClaim: (opts: {
    key?: string;
    target: { seat?: string; role?: string };
    onOccupied?: (seat: { name: string }, presenceId: string) => void;
    onRefused?: (code: string, message: string, claimable: string[], hint: string) => void;
  }) => {
    h.claimKeys.push(opts.key);
    const outcome = h.claimQueue.shift() ?? { state: 'occupied' as const };
    queueMicrotask(() => {
      if (outcome.state === 'occupied') {
        opts.onOccupied?.({ name: opts.target.seat ?? 'Ada' }, 'presence-1');
      } else {
        opts.onRefused?.(outcome.code, outcome.message, [], '');
      }
    });
    return { close: vi.fn() };
  },
}));

vi.mock('./harnesses/index.js', () => ({ HARNESSES: [h.harness] }));

vi.mock('../config.js', () => ({
  loadConfig: () => h.config,
  saveConfig: vi.fn(),
  saveBinding: vi.fn((cwd: string) => join(cwd, '.musterd', 'binding.json')),
  saveWorkspaceSpec: vi.fn((cwd: string) => join(cwd, '.musterd', 'workspace.json')),
  rememberIdentity: vi.fn((cfg: { knownIdentities: unknown[] }, si: unknown) => {
    cfg.knownIdentities.push(si);
  }),
  findBinding: vi.fn(() => h.folderBinding),
  findWorkspaceSpec: vi.fn(() => h.folderSpec),
  wsBase: vi.fn((server: string) => server.replace(/^http/, 'ws')),
}));

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));

let cwd: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-init-'));
  process.chdir(cwd);
  cwd = process.cwd(); // normalize macOS /var → /private/var so relative() stays in-tree

  h.confirmQueue.length = 0;
  h.selectQueue.length = 0;
  h.textQueue.length = 0;
  h.claimQueue.length = 0;
  h.claimKeys.length = 0;
  h.folderBinding = null;
  h.folderSpec = null;
  Object.assign(h.config, {
    server: 'http://localhost:4849',
    current: undefined,
    identities: {},
    bindings: {},
    agentKeys: {},
  });
  h.http.createTeam.mockResolvedValue({
    token: 'tok-creator',
    human_credential: 'mscr_creator',
    agent_key: 'mskey_team',
  });
  h.http.addMember.mockResolvedValue({ token: 'tok-ada' });
  h.http.roster.mockResolvedValue({ members: [{ name: 'Ada', presence: 'online' }] });
  h.http.inbox.mockResolvedValue({ messages: [] });
  h.harness.detect.mockResolvedValue({ installed: true, configured: false, detail: 'claude 1.0' });
  h.harness.configure.mockResolvedValue({
    target: 'claude mcp (scope: local)',
    activation: 'run `claude` here',
    scope: 'wired into this folder only',
  });
  h.harness.provision.mockImplementation(async (plan: { servers: { name: string }[] }) => ({
    servers: plan.servers.map((s) => s.name),
    permissions: { allow: [], ask: [], deny: [] },
    target: 'claude mcp (scope: local)',
  }));

  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(console, 'clear').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true }) as Response),
  );
});

afterEach(() => {
  process.chdir(origCwd);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Queue a full happy-path answer set: create team → add agent → configure → role → primer. */
function happyAnswers() {
  h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend'); // slug, you, your-role, name, role
  h.selectQueue.push('new', 'claude-code', 'generalist'); // intent, harness, role-template
  h.confirmQueue.push(true, true, true); // autojoin, connect, write-primer
}

describe('runInit — guards and exits', () => {
  it('refuses outside a TTY with exit code 2', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runInit()).toBe(2);
    expect(errSpy).toHaveBeenCalled();
  });

  it('stops with exit 1 when the daemon is down and the user declines to start it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as Response),
    );
    h.confirmQueue.push(false); // decline "start the daemon now?"
    expect(await runInit()).toBe(1);
  });

  it('starts the daemon, then proceeds (watch posture) when health comes up', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: n++ > 0 }) as Response), // first probe down, then up
    );
    h.confirmQueue.push(true); // start the daemon now?
    h.textQueue.push('dawn', 'nick', ''); // createTeam
    h.selectQueue.push('watch'); // intent
    expect(await runInit()).toBe(0);
    const { spawn } = await import('node:child_process');
    expect(spawn).toHaveBeenCalled();
  });

  it('cancelling a prompt bails with exit code 130', async () => {
    h.textQueue.push(Symbol('cancel')); // cancel at the first createTeam prompt
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    await expect(runInit()).rejects.toThrow('exit:130');
    expect(exitSpy).toHaveBeenCalledWith(130);
  });
});

describe('runInit — team selection', () => {
  it('reuses a cached team that is still live on this daemon', async () => {
    h.config.current = 'dawn';
    h.config.identities['dawn'] = { name: 'nick', key: 'mscr_creator', surface: 'cli' };
    h.http.inbox.mockResolvedValue({ messages: [] }); // cachedTeamLive → true
    h.selectQueue.push('dawn'); // which team? → reuse
    h.selectQueue.push('watch'); // intent
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).not.toHaveBeenCalled();
  });

  it('falls back to create when the cached team is gone (stale token)', async () => {
    h.config.current = 'gone';
    h.config.identities['gone'] = { name: 'nick', key: 'mscr_stale', surface: 'cli' };
    h.http.inbox.mockRejectedValue(new Error('invalid token')); // cachedTeamLive → false
    h.textQueue.push('dawn', 'nick', ''); // createTeam
    h.selectQueue.push('watch'); // intent
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).toHaveBeenCalled();
  });

  it('cached-and-live, but the user chooses to create a new team', async () => {
    h.config.current = 'dawn';
    h.config.identities['dawn'] = { name: 'nick', key: 'mscr_creator', surface: 'cli' };
    h.selectQueue.push('__new__'); // which team? → new
    h.textQueue.push('fresh', 'nick', ''); // createTeam
    h.selectQueue.push('watch'); // intent
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).toHaveBeenCalled();
  });
});

describe("runInit — the folder's own team outranks the machine cache (ADR 161)", () => {
  it("offers the folder's team as the default, even when config.current names another live team", async () => {
    h.folderBinding = { team: 'revive' };
    h.config.current = 'dawn';
    h.config.identities['dawn'] = { name: 'nick', key: 'mscr_dawn', surface: 'cli' };
    h.config.identities['revive'] = { name: 'nick', key: 'mscr_revive', surface: 'cli' };
    h.http.inbox.mockResolvedValue({ messages: [] }); // both teams probe live
    h.selectQueue.push('revive'); // which team? → the folder's own
    h.selectQueue.push('watch');
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).not.toHaveBeenCalled();
  });

  it('REFUSES by default when the folder names a team this machine cannot reach — the near-miss that motivated this', async () => {
    // The live shape: bound to revive, but config.current is a dead experiment team and there is no
    // credential for revive. Pre-ADR this fell straight through to "name your team".
    h.folderBinding = { team: 'revive' };
    h.config.current = 'cookoff-gb2';
    h.config.identities['cookoff-gb2'] = { name: 'nick', key: 'mscr_dead', surface: 'cli' };
    h.http.inbox.mockRejectedValue(new Error('no such team'));
    h.confirmQueue.push(false); // "create a different team here anyway?" → no
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).not.toHaveBeenCalled();
  });

  it('still allows it on an explicit yes, so the escape hatch survives', async () => {
    h.folderBinding = { team: 'revive' };
    h.config.current = undefined;
    h.http.inbox.mockRejectedValue(new Error('no such team'));
    h.confirmQueue.push(true); // yes, repoint this folder
    h.textQueue.push('fresh', 'nick', '');
    h.selectQueue.push('watch');
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).toHaveBeenCalled();
  });

  it('falls back to the workspace spec when there is no binding yet (fresh clone)', async () => {
    h.folderSpec = { team: 'revive' };
    h.config.identities['revive'] = { name: 'nick', key: 'mscr_revive', surface: 'cli' };
    h.http.inbox.mockResolvedValue({ messages: [] });
    h.selectQueue.push('revive');
    h.selectQueue.push('watch');
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).not.toHaveBeenCalled();
  });
});

describe('runRefreshGuidance — guidance only, never identity (ADR 161)', () => {
  it('refuses in an unbound folder rather than guessing a team', () => {
    expect(runRefreshGuidance(cwd)).toBe(1);
  });

  it('writes stamped guidance for a harness already present, and touches nothing else', () => {
    h.folderBinding = { team: 'revive' };
    // Seed the harness's skill file so the refresh treats it as present (a refresh never PROVISIONS).
    mkdirSync(join(cwd, '.claude', 'skills', 'musterd'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', 'skills', 'musterd', 'SKILL.md'),
      'old\n<!-- musterd:content v1 sha256:abcd1234 -->\n',
    );
    expect(runRefreshGuidance(cwd)).toBe(0);
    const written = readFileSync(join(cwd, '.claude', 'skills', 'musterd', 'SKILL.md'), 'utf8');
    expect(written).toContain('musterd:content v');
    // The identity/config surfaces stay untouched — that is the whole point of the flag.
    expect(existsSync(join(cwd, '.musterd', 'binding.json'))).toBe(false);
    expect(h.harness.configure).not.toHaveBeenCalled();
    expect(h.http.createTeam).not.toHaveBeenCalled();
    expect(h.http.addMember).not.toHaveBeenCalled();
  });

  it('does not add guidance for a harness the folder does not already carry', () => {
    h.folderBinding = { team: 'revive' };
    expect(runRefreshGuidance(cwd)).toBe(0);
    expect(existsSync(join(cwd, '.claude', 'skills', 'musterd', 'SKILL.md'))).toBe(false);
  });

  it('writes NOTHING at all in a folder with no guidance — not even the canonical skill (caught live)', () => {
    // writeGuidance always emits the canonical file, which is right for init and wrong for a
    // refresh: an unprovisioned worktree would sprout a file from a command that promises only to
    // refresh. Observed for real against agents-izzo before this guard existed.
    h.folderBinding = { team: 'revive' };
    expect(runRefreshGuidance(cwd)).toBe(0);
    expect(existsSync(join(cwd, '.musterd', 'skill', 'SKILL.md'))).toBe(false);
  });
});

describe('runPruneBindings — the registry only grows (ADR 162)', () => {
  it('reports stale entries without touching them, and removes them only with --apply', () => {
    const gone = join(tmpdir(), 'musterd-gone-does-not-exist');
    h.config.bindings[gone] = { team: 'dawn', seat: 'scout', surface: 'claude-code' };
    h.config.bindings[cwd] = { team: 'revive', seat: 'stanley', surface: 'claude-code' };

    // Dry run: reports, changes nothing.
    expect(runPruneBindings()).toBe(0);
    expect(Object.keys(h.config.bindings)).toContain(gone);

    // --apply: drops the dead folder, keeps the live one.
    expect(runPruneBindings({ apply: true })).toBe(0);
    expect(Object.keys(h.config.bindings)).toEqual([cwd]);
  });

  it('never touches credentials, even when every binding is stale', () => {
    h.config.bindings[join(tmpdir(), 'musterd-gone-1')] = {
      team: 'dawn',
      seat: 'scout',
      surface: 'claude-code',
    };
    h.config.identities['cookoff-gb2'] = { name: 'nick', key: 'mscr_keep', surface: 'cli' };
    h.config.agentKeys['cookoff-gb2'] = 'mskey_keep';
    expect(runPruneBindings({ apply: true })).toBe(0);
    expect(h.config.identities['cookoff-gb2']).toBeDefined();
    expect(h.config.agentKeys['cookoff-gb2']).toBe('mskey_keep');
  });

  it('says so plainly when the registry is already clean', () => {
    h.config.bindings[cwd] = { team: 'revive', seat: 'stanley', surface: 'claude-code' };
    expect(runPruneBindings({ apply: true })).toBe(0);
    expect(Object.keys(h.config.bindings)).toEqual([cwd]);
  });
});

describe('runInit — intent branches', () => {
  it('watch posture leaves without minting a member', async () => {
    h.textQueue.push('dawn', 'nick', '');
    h.selectQueue.push('watch');
    expect(await runInit()).toBe(0);
    expect(h.http.addMember).not.toHaveBeenCalled();
  });

  it('"activate an existing member" drives the real claim flow and occupies the seat (ADR 077)', async () => {
    h.textQueue.push('dawn', 'nick', ''); // createTeam
    h.selectQueue.push('existing'); // intent
    h.textQueue.push('Miley'); // which member to reactivate
    h.claimQueue.push({ state: 'occupied' });
    expect(await runInit()).toBe(0);
    // No new member is minted — reactivating an existing one is a claim, not an add.
    expect(h.http.addMember).not.toHaveBeenCalled();
  });

  it('"activate an existing member" authenticates as the SEAT when the vault knows it', async () => {
    // install-topology §6(a): handing the shared team key to any target is what wrote the dead
    // binding at /Users/nick/agents — the team key cannot act as a human seat, so the claim landed
    // and every request after it 403'd. L1 now refuses that claim outright, which would turn this
    // into a loud failure while the credential that works sat in the vault the whole time.
    h.config.agentKeys['dawn'] = 'mskey_team';
    h.config.knownIdentities.push({
      team: 'dawn',
      name: 'Miley',
      key: 'mscr_miley',
      surface: 'cli',
    });
    h.textQueue.push('dawn', 'nick', '');
    h.selectQueue.push('existing');
    h.textQueue.push('Miley');
    h.claimQueue.push({ state: 'occupied' });

    expect(await runInit()).toBe(0);
    expect(h.claimKeys).toEqual(['mscr_miley']);
  });

  it('"activate an existing member" still falls back to the team key when the vault has nothing', async () => {
    // The legitimate agent-seat activation must not change shape.
    h.config.agentKeys['dawn'] = 'mskey_team';
    h.textQueue.push('dawn', 'nick', '');
    h.selectQueue.push('existing');
    h.textQueue.push('scout');
    h.claimQueue.push({ state: 'occupied' });

    expect(await runInit()).toBe(0);
    expect(h.claimKeys).toEqual(['mskey_team']);
  });

  it('"activate an existing member" surfaces a refusal instead of dead-ending', async () => {
    h.textQueue.push('dawn', 'nick', ''); // createTeam
    h.selectQueue.push('existing'); // intent
    h.textQueue.push('Miley'); // which member to reactivate
    h.claimQueue.push({ state: 'refused', code: 'not_found', message: 'no such seat' });
    // The wizard catches the refusal and exits 0 (a guided no-op), not a thrown CliError.
    expect(await runInit()).toBe(0);
    expect(h.http.addMember).not.toHaveBeenCalled();
  });

  it('reports when no agent harness is installed', async () => {
    h.harness.detect.mockResolvedValue({ installed: false, configured: false });
    h.textQueue.push('dawn', 'nick', '');
    h.selectQueue.push('new');
    expect(await runInit()).toBe(0);
    expect(h.http.addMember).not.toHaveBeenCalled();
  });
});

describe('runInit — add-agent happy path', () => {
  it('mints the member, configures the harness, writes the primer, sees it online', async () => {
    happyAnswers();
    expect(await runInit()).toBe(0);
    expect(h.http.addMember).toHaveBeenCalledWith('dawn', {
      name: 'Ada',
      kind: 'agent',
      role: 'backend',
    });
    expect(h.harness.configure).toHaveBeenCalled();
    // primer written to AGENTS.md in the (temp) cwd
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toContain('## Your musterd team');
    // autojoin/driver go into binding.json, never the repo-root-shared entry (ADR 165 inc 2)
    const entry = h.harness.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env['MUSTERD_AUTOJOIN']).toBeUndefined();
    expect(entry.env['MUSTERD_DRIVER']).toBeUndefined();
    const { saveBinding } = await import('../config.js');
    const binding = vi.mocked(saveBinding).mock.calls[0]![1] as Record<string, unknown>;
    expect(binding['autojoin']).toBe(true);
    expect(binding['driver']).toBe('nick');
  });

  it('declining the connect step prints manual setup and exits 0', async () => {
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'claude-code', 'generalist'); // intent, harness, role-template
    h.confirmQueue.push(true, false); // autojoin yes, connect NO
    expect(await runInit()).toBe(0);
    expect(h.harness.configure).not.toHaveBeenCalled();
  });

  it('returns 1 when minting the member fails', async () => {
    h.http.addMember.mockRejectedValue(new Error('member "Ada" already exists'));
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'claude-code', 'generalist'); // intent, harness, role-template
    h.confirmQueue.push(true); // autojoin (mint happens before connect)
    expect(await runInit()).toBe(1);
  });

  it('returns 1 when harness configuration fails', async () => {
    h.harness.configure.mockRejectedValue(new Error('claude mcp add failed'));
    happyAnswers();
    expect(await runInit()).toBe(1);
  });

  it('repoints an already-configured harness and warns about the new member', async () => {
    h.harness.detect.mockResolvedValue({ installed: true, configured: true, detail: 'claude 1.0' });
    happyAnswers();
    expect(await runInit()).toBe(0);
    expect(h.http.addMember).toHaveBeenCalled();
  });

  it('declining the primer still completes successfully', async () => {
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'claude-code', 'generalist'); // intent, harness, role
    h.confirmQueue.push(true, true, false); // autojoin, connect, primer NO
    expect(await runInit()).toBe(0);
  });

  it('provisioning a richer role calls provision and derives the label from the template', async () => {
    h.textQueue.push('dawn', 'nick', '', 'Ada'); // slug, you, your-role, name (no free-text role)
    h.selectQueue.push('new', 'claude-code', 'backend'); // intent, harness, role-template = backend
    h.confirmQueue.push(false, true, true, true); // override-label NO, autojoin, connect, primer
    expect(await runInit()).toBe(0);
    // roster/primer label is derived from the chosen template, not a free-text prompt (ADR 038)
    expect(h.http.addMember).toHaveBeenCalledWith('dawn', {
      name: 'Ada',
      kind: 'agent',
      role: 'backend',
    });
    expect(h.harness.provision).toHaveBeenCalled();
    const plan = h.harness.provision.mock.calls[0]![0] as { servers: { name: string }[] };
    expect(plan.servers.map((s) => s.name)).toContain('supabase');
    // manifest records what was provisioned
    const manifest = JSON.parse(readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8'));
    expect(manifest.mcpServers).toContain('supabase');
    expect(manifest.role).toBe('backend');
    // the role's charter lands in the managed primer block, labelled with the derived role
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toContain('## Your charter');
  });

  it('an explicit free-text override wins over the template-derived label', async () => {
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'platform'); // …name, then the override label
    h.selectQueue.push('new', 'claude-code', 'backend'); // role-template = backend
    h.confirmQueue.push(true, true, true, true); // override-label YES, autojoin, connect, primer
    expect(await runInit()).toBe(0);
    expect(h.http.addMember).toHaveBeenCalledWith('dawn', {
      name: 'Ada',
      kind: 'agent',
      role: 'platform',
    });
    // the tools still come from the chosen template, regardless of the label override
    expect(h.harness.provision).toHaveBeenCalled();
  });

  it('appends to an existing unmarked AGENTS.md (primer target = unmarked)', async () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# My project\n\nhello\n');
    happyAnswers();
    expect(await runInit()).toBe(0);
    const out = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    expect(out).toContain('# My project');
    expect(out).toContain('## Your musterd team');
  });
});

describe('runInit — secret/gitignore handling', () => {
  it('offers to gitignore the in-tree secret config AND the provisioned guidance, appending both', async () => {
    // binding path already ignored → "already covered"; the harness secret + the guidance skill are not.
    writeFileSync(join(cwd, '.gitignore'), '.musterd/binding.json\n');
    h.harness.configure.mockResolvedValue({
      target: '.cursor/mcp.json',
      activation: 'reopen Cursor',
      secretPath: join(cwd, '.cursor', 'mcp.json'),
    });
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'claude-code', 'generalist'); // intent, harness, role
    // autojoin, connect, secret-gitignore, guidance-gitignore (ADR 085), primer — content-asserted below.
    h.confirmQueue.push(true, true, true, true, true);
    expect(await runInit()).toBe(0);
    const gi = readFileSync(join(cwd, '.gitignore'), 'utf8');
    expect(gi).toContain('.cursor/mcp.json'); // the token config (warnSecretConfig)
    expect(gi).toContain('.musterd/skill/SKILL.md'); // the provisioned guidance (offerGitignoreGuidance)
    expect(gi).toContain('# musterd');
  });
});

describe('cachedTeamLive', () => {
  it('is true when the authenticated inbox probe succeeds', async () => {
    h.http.inbox.mockResolvedValue({ messages: [] });
    expect(await cachedTeamLive('http://x', 'dawn', 'tok')).toBe(true);
  });

  it('is false when the probe rejects (stale token / wrong db)', async () => {
    h.http.inbox.mockRejectedValue(new Error('unauthorized'));
    expect(await cachedTeamLive('http://x', 'dawn', 'tok')).toBe(false);
  });
});

describe('missingGitignoreEntries — which guidance paths still need ignoring (ADR 085)', () => {
  const files = [
    '.musterd/skill/SKILL.md',
    '.cursor/rules/musterd.mdc',
    '.cursor/commands/musterd-standup.md',
  ];

  it('returns every path when the .gitignore covers none', () => {
    expect(missingGitignoreEntries('.claude/\n*.db\n', files)).toEqual(files);
  });

  it('drops paths already present, exact-line and leading-slash forms', () => {
    const body = '.cursor/rules/musterd.mdc\n/.musterd/skill/SKILL.md\n';
    expect(missingGitignoreEntries(body, files)).toEqual(['.cursor/commands/musterd-standup.md']);
  });

  it('returns none when all are covered (idempotent re-run)', () => {
    const body = files.join('\n') + '\n';
    expect(missingGitignoreEntries(body, files)).toEqual([]);
  });

  it('skips empties and out-of-tree paths, and de-duplicates', () => {
    expect(
      missingGitignoreEntries('', [
        '',
        '../outside',
        '.cursor/rules/musterd.mdc',
        '.cursor/rules/musterd.mdc',
      ]),
    ).toEqual(['.cursor/rules/musterd.mdc']);
  });
});
