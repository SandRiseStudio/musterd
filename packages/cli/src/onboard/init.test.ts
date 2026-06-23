import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// vi.mock calls below are hoisted above these imports, so init.js resolves the mocked deps.
import { cachedTeamLive, runInit } from './init.js';

// Shared, hoisted test doubles the mock factories below close over.
const h = vi.hoisted(() => {
  const confirmQueue: unknown[] = [];
  const selectQueue: unknown[] = [];
  const textQueue: unknown[] = [];
  const http = {
    createTeam: vi.fn(async () => ({ token: 'tok-creator' })),
    addMember: vi.fn(async () => ({ token: 'tok-ada' })),
    roster: vi.fn(async () => ({ members: [{ name: 'Ada', presence: 'online' }] })),
    inbox: vi.fn(async () => ({ messages: [] })),
  };
  const harness = {
    id: 'claude-code',
    label: 'Claude Code',
    surface: 'claude-code',
    detect: vi.fn(async () => ({ installed: true, configured: false, detail: 'claude 1.0' })),
    configure: vi.fn(async () => ({
      target: 'claude mcp (scope: local)',
      activation: 'run `claude` here',
      scope: 'wired into this folder only',
    })),
  };
  const config: {
    server: string;
    current: string | undefined;
    identities: Record<string, { name: string; token: string; surface: string }>;
    bindings: Record<string, { team: string; member: string; surface: string }>;
  } = { server: 'http://localhost:4849', current: undefined, identities: {}, bindings: {} };
  return { confirmQueue, selectQueue, textQueue, http, harness, config };
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

vi.mock('../client.js', () => ({ HttpClient: vi.fn(() => h.http) }));

vi.mock('./harnesses/index.js', () => ({ HARNESSES: [h.harness] }));

vi.mock('../config.js', () => ({
  loadConfig: () => h.config,
  saveConfig: vi.fn(),
  saveBinding: vi.fn((cwd: string) => join(cwd, '.musterd', 'binding.json')),
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
  Object.assign(h.config, {
    server: 'http://localhost:4849',
    current: undefined,
    identities: {},
    bindings: {},
  });
  h.http.createTeam.mockResolvedValue({ token: 'tok-creator' });
  h.http.addMember.mockResolvedValue({ token: 'tok-ada' });
  h.http.roster.mockResolvedValue({ members: [{ name: 'Ada', presence: 'online' }] });
  h.http.inbox.mockResolvedValue({ messages: [] });
  h.harness.detect.mockResolvedValue({ installed: true, configured: false, detail: 'claude 1.0' });
  h.harness.configure.mockResolvedValue({
    target: 'claude mcp (scope: local)',
    activation: 'run `claude` here',
    scope: 'wired into this folder only',
  });

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

/** Queue a full happy-path answer set: create team → add agent → configure → primer. */
function happyAnswers() {
  h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend'); // slug, you, your-role, name, role
  h.selectQueue.push('new', 'claude-code'); // intent, harness
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
    h.config.identities['dawn'] = { name: 'nick', token: 'tok', surface: 'cli' };
    h.http.inbox.mockResolvedValue({ messages: [] }); // cachedTeamLive → true
    h.selectQueue.push('dawn'); // which team? → reuse
    h.selectQueue.push('watch'); // intent
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).not.toHaveBeenCalled();
  });

  it('falls back to create when the cached team is gone (stale token)', async () => {
    h.config.current = 'gone';
    h.config.identities['gone'] = { name: 'nick', token: 'stale', surface: 'cli' };
    h.http.inbox.mockRejectedValue(new Error('invalid token')); // cachedTeamLive → false
    h.textQueue.push('dawn', 'nick', ''); // createTeam
    h.selectQueue.push('watch'); // intent
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).toHaveBeenCalled();
  });

  it('cached-and-live, but the user chooses to create a new team', async () => {
    h.config.current = 'dawn';
    h.config.identities['dawn'] = { name: 'nick', token: 'tok', surface: 'cli' };
    h.selectQueue.push('__new__'); // which team? → new
    h.textQueue.push('fresh', 'nick', ''); // createTeam
    h.selectQueue.push('watch'); // intent
    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).toHaveBeenCalled();
  });
});

describe('runInit — intent branches', () => {
  it('watch posture leaves without minting a member', async () => {
    h.textQueue.push('dawn', 'nick', '');
    h.selectQueue.push('watch');
    expect(await runInit()).toBe(0);
    expect(h.http.addMember).not.toHaveBeenCalled();
  });

  it('"activate existing" + decline-add-new makes no changes', async () => {
    h.textQueue.push('dawn', 'nick', '');
    h.selectQueue.push('existing');
    h.confirmQueue.push(false); // "add a new agent instead?" → no
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
    // autojoin baked into the env passed to configure
    const entry = h.harness.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env['MUSTERD_AUTOJOIN']).toBe('1');
    expect(entry.env['MUSTERD_DRIVER']).toBe('nick');
  });

  it('declining the connect step prints manual setup and exits 0', async () => {
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'claude-code');
    h.confirmQueue.push(true, false); // autojoin yes, connect NO
    expect(await runInit()).toBe(0);
    expect(h.harness.configure).not.toHaveBeenCalled();
  });

  it('returns 1 when minting the member fails', async () => {
    h.http.addMember.mockRejectedValue(new Error('member "Ada" already exists'));
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'claude-code');
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
    h.selectQueue.push('new', 'claude-code');
    h.confirmQueue.push(true, true, false); // autojoin, connect, primer NO
    expect(await runInit()).toBe(0);
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
  it('offers to gitignore an in-tree secret config and appends it', async () => {
    // binding path already ignored → "already covered"; the harness secret is not → offer to add.
    writeFileSync(join(cwd, '.gitignore'), '.musterd/binding.json\n');
    h.harness.configure.mockResolvedValue({
      target: '.cursor/mcp.json',
      activation: 'reopen Cursor',
      secretPath: join(cwd, '.cursor', 'mcp.json'),
    });
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'claude-code');
    h.confirmQueue.push(true, true, true, true); // autojoin, connect, gitignore-add, primer
    expect(await runInit()).toBe(0);
    const gi = readFileSync(join(cwd, '.gitignore'), 'utf8');
    expect(gi).toContain('.cursor/mcp.json');
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
