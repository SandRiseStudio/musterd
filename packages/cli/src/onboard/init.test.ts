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
  const multiQueue: unknown[] = [];
  const textQueue: unknown[] = [];
  // In-memory physical state for the fake fragment adapters (ADR 282): id → fingerprint or null.
  const fragState: Record<string, string | null> = {};
  const adapterFor = (id: string) => ({
    id,
    surface: 'other',
    adapterVersion: 1,
    availability: async () => ({ available: true }),
    target: async (ctx: { worktreeRoot: string }) => ({
      containers: [
        { containerKey: `folder ${ctx.worktreeRoot} ${id}`, scope: 'folder', handle: null },
      ],
    }),
    desiredFragments: async (ctx: { worktreeRoot: string }) => [
      {
        harness: id,
        resourceKey: `folder ${ctx.worktreeRoot} ${id} entry`,
        containerKey: `folder ${ctx.worktreeRoot} ${id}`,
        fragmentKey: 'entry',
        scope: 'folder',
        fingerprint: 'f'.repeat(64),
        payload: { id },
      },
    ],
    observe: async () =>
      fragState[id] ? { state: 'present', fingerprint: fragState[id]! } : { state: 'absent' },
    apply: vi.fn(async (_ctx: unknown, m: { kind: string; intent: { fingerprint: string } }) => {
      fragState[id] = m.kind === 'remove' ? null : m.intent.fingerprint;
    }),
  });
  const adapters: Record<string, ReturnType<typeof adapterFor>> = {};
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
  const selectOptions: { value: string; hint?: string }[][] = [];
  // A second harness, used only by the tests that need SELECTION to be a real choice. Kept out of
  // the default registry so every existing test keeps its single-harness world.
  const otherHarness = {
    ...harness,
    id: 'cursor',
    label: 'Cursor',
    surface: 'cursor',
    detect: vi.fn(async () => ({ installed: true, configured: false, detail: 'Cursor 1.0' })),
    configure: vi.fn(async () => ({ target: '.cursor/mcp.json', activation: 'open Cursor here' })),
    provision: vi.fn(async () => ({
      servers: [],
      permissions: { allow: [], ask: [], deny: [] },
      target: '.cursor/mcp.json',
    })),
  };
  // The registry the mocked module reads through a getter, so a test can widen it for its own case.
  const registry: unknown[] = [harness];
  return {
    confirmQueue,
    selectQueue,
    multiQueue,
    textQueue,
    fragState,
    adapterFor,
    adapters,
    http,
    harness,
    otherHarness,
    registry,
    config,
    claimQueue,
    claimKeys,
    selectOptions,
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
  select: vi.fn(async (o: { options?: { value: string; hint?: string }[] }) => {
    // Record what each picker OFFERED, not just what was chosen — "which teams can I reach from
    // here" is the thing L6 changed, and it is invisible from the return value alone.
    h.selectOptions.push(o?.options ?? []);
    return h.selectQueue.shift();
  }),
  multiselect: vi.fn(
    async (o: { options?: { value: string; hint?: string }[]; initialValues?: string[] }) => {
      h.selectOptions.push(o?.options ?? []);
      return h.multiQueue.length > 0 ? h.multiQueue.shift() : (o?.initialValues ?? []);
    },
  ),
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

// Read through a getter so a test can widen the registry for its own case (see "configures the
// harness that was chosen"): with a single-harness registry, "configured the chosen one" and
// "configured the only one" are indistinguishable, so that test would pass on a hard-coded pick.
vi.mock('./harnesses/index.js', () => ({
  get HARNESSES() {
    return h.registry;
  },
  // The fragment registry mirrors the lifecycle one, plus the always-available native adapter.
  harnessAdapters: () => [
    ...(h.registry as { id: string }[]).map(({ id }) => (h.adapters[id] ??= h.adapterFor(id))),
    (h.adapters['musterd'] ??= {
      ...h.adapterFor('musterd'),
      target: async () => ({ containers: [] }),
      desiredFragments: async () => [],
    }),
  ],
}));

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
  h.multiQueue.length = 0;
  h.textQueue.length = 0;
  for (const k of Object.keys(h.fragState)) delete h.fragState[k];
  for (const a of Object.values(h.adapters)) (a.apply as { mockClear?: () => void }).mockClear?.();
  h.claimQueue.length = 0;
  h.claimKeys.length = 0;
  h.selectOptions.length = 0;
  h.folderBinding = null;
  h.folderSpec = null;
  Object.assign(h.config, {
    server: 'http://localhost:4849',
    current: undefined,
    identities: {},
    // Reset the ADR 059 vault too: init's team picker reads it, so a leaked entry from an earlier
    // test silently changes which branch the next one takes.
    knownIdentities: [],
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
  h.selectQueue.push('new', 'generalist'); // intent, role-template
  h.multiQueue.push(['claude-code']); // the ADR 281 harness multi-select
  h.confirmQueue.push(true, true, true); // autojoin, wire, write-primer
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

/**
 * L6 / install-topology §3: **one team, many projects** is first-class, so wiring a second repo to a
 * team this machine already knows must have a path that is not "create a new team".
 *
 * The picker used to offer exactly `config.current` + create-new. But `identities` holds ONE identity
 * per team and only for the teams most recently acted on, while `knownIdentities` (ADR 059) is the
 * superset another team's join cannot evict. So a machine could hold a perfectly good credential for
 * a live team and still be routed at the one option that repoints the folder.
 */
describe('runInit — the picker offers every team this machine can reach (L6)', () => {
  it('offers a live vault team that is NOT config.current, instead of only create-new', async () => {
    h.config.current = 'dawn';
    h.config.identities['dawn'] = { name: 'nick', key: 'mscr_dawn', surface: 'cli' };
    // acme is in the vault only — the multi-team case the single-slot cache cannot represent.
    h.config.knownIdentities.push({
      team: 'acme',
      name: 'nick-a',
      key: 'mscr_acme',
      surface: 'cli',
    });
    h.selectQueue.push('acme', 'watch');

    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).not.toHaveBeenCalled();
    expect(h.selectOptions[0]!.map((o) => o.value)).toEqual(['dawn', 'acme', '__new__']);
  });

  it('names WHO you would be on each team — with several offered, "which team" is "which me"', async () => {
    h.config.current = 'dawn';
    h.config.identities['dawn'] = { name: 'nick', key: 'mscr_dawn', surface: 'cli' };
    h.config.knownIdentities.push({
      team: 'acme',
      name: 'nick-a',
      key: 'mscr_acme',
      surface: 'cli',
    });
    h.selectQueue.push('acme', 'watch');

    await runInit();
    const hints = Object.fromEntries(h.selectOptions[0]!.map((o) => [o.value, o.hint]));
    expect(hints['acme']).toContain('you are nick-a');
    expect(hints['dawn']).toContain('you are nick');
    expect(hints['dawn']).toContain('last used here');
  });

  it('picking a non-current team resolves its credential from the vault — the crash this would have been', async () => {
    // `config.identities[team]!.key` was a non-null assertion on a one-slot-per-team map: for any
    // team but the current one it is undefined at runtime, and picking one is the whole point.
    h.config.current = 'dawn';
    h.config.identities['dawn'] = { name: 'nick', key: 'mscr_dawn', surface: 'cli' };
    h.config.knownIdentities.push({
      team: 'acme',
      name: 'nick-a',
      key: 'mscr_acme',
      surface: 'cli',
    });
    h.selectQueue.push('acme', 'existing');
    h.textQueue.push('Miley');
    h.claimQueue.push({ state: 'occupied' });

    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).not.toHaveBeenCalled();
  });

  it("reaches the folder's own team from the vault alone — ADR 161 was defeated by the single slot", async () => {
    // Bound to revive, current is a dead experiment cell, and revive lives only in the vault. Before
    // L6 folderKey came from `identities` only, so this fell into "no working credential for it" and
    // offered to repoint the folder — the exact ADR 161 failure, one layer down.
    h.folderBinding = { team: 'revive' };
    h.config.current = 'cookoff-gb2';
    h.config.knownIdentities.push({
      team: 'revive',
      name: 'nick',
      key: 'mscr_revive',
      surface: 'cli',
    });
    h.selectQueue.push('revive', 'watch');

    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).not.toHaveBeenCalled();
    expect(h.selectOptions[0]![0]!.hint).toBe("this folder's team");
  });

  it('never offers a team it cannot reach on this daemon', async () => {
    h.config.current = 'dawn';
    h.config.identities['dawn'] = { name: 'nick', key: 'mscr_dawn', surface: 'cli' };
    h.config.knownIdentities.push({ team: 'gone', name: 'nick', key: 'mscr_gone', surface: 'cli' });
    // Only dawn answers; `gone` is a wiped db / another server.
    h.http.inbox.mockImplementation(async (team: string) => {
      if (team === 'gone') throw new Error('no such team');
      return { messages: [] };
    });
    h.selectQueue.push('dawn', 'watch');

    await runInit();
    expect(h.selectOptions[0]!.map((o) => o.value)).toEqual(['dawn', '__new__']);
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
    // The vault knows a live team now, so init offers it instead of routing at "create a new team"
    // (L6) — pick it, then the intent.
    h.selectQueue.push('dawn', 'existing');
    h.textQueue.push('Miley');
    h.claimQueue.push({ state: 'occupied' });

    expect(await runInit()).toBe(0);
    expect(h.http.createTeam).not.toHaveBeenCalled();
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

  it('an uninstalled harness stays selectable as pending; native-only init still completes', async () => {
    h.harness.detect.mockResolvedValue({ installed: false, configured: false });
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'generalist');
    h.multiQueue.push(['musterd']); // nothing external installed — keep only the native host
    h.confirmQueue.push(true, true, true); // autojoin, wire, primer
    expect(await runInit()).toBe(0);
    expect(h.http.addMember).toHaveBeenCalled();
    // The uninstalled harness was OFFERED (selection survives installation state, ADR 281)…
    const offered = h.selectOptions.find((opts) =>
      (opts as { value: string; hint?: string }[]).some((o) => o.value === 'claude-code'),
    ) as { value: string; hint?: string }[];
    expect(offered.find((o) => o.value === 'claude-code')?.hint).toContain('pending');
    // …and nothing external was configured.
    expect(h.adapters['claude-code']?.apply).not.toHaveBeenCalled();
  });
});

// The doctor tells a Cursor or Codex seat to "re-provision this folder with `musterd init` and pick
// <harness>" (doctor.ts, #663). That sentence REPLACED a false prescription — "run `musterd wire`",
// which configured Claude Code alone — so it inherits the burden the original failed: a prescription
// nobody asserts survives for months. `wire.test.ts` pins wire's half (it configures the harness the
// FOLDER declares); this is the mirror, that the harness wire cannot reach there, init can.
//
// The existing happy-path test below already asserts `configure` is called, but the mocked registry
// is a single harness with id 'claude-code' — which is precisely NOT the case the doctor's new
// sentence is about. Requested by izzo when accepting lane 01KZ7NQX71, who nearly bounced it because
// grepping `chosen.configure` in commands/init.ts finds nothing: that file is 72 lines and delegates,
// and the call is in onboard/init.ts. A claim that takes two lookups to confirm is one nobody will
// re-confirm later.
describe('runInit — configures the harness that was chosen, not only Claude Code', () => {
  // Both harnesses present, so picking one is a real choice. With the default single-harness
  // registry this test would pass against an implementation that ignored the selection entirely —
  // a fixture more convenient than production, which makes a green test evidence of nothing.
  beforeEach(() => {
    h.registry.length = 0;
    h.registry.push(h.harness, h.otherHarness);
  });
  afterEach(() => {
    h.registry.length = 0;
    h.registry.push(h.harness);
  });

  it('configures the selected non-claude-code harness, and leaves the other alone', async () => {
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'generalist');
    h.multiQueue.push(['cursor']); // the selection is cursor, NOT the registry's first entry
    h.confirmQueue.push(true, true, true);

    expect(await runInit()).toBe(0);

    // The prescription's whole content: selecting this harness reconciles THIS harness's fragments…
    expect(h.adapters['cursor']!.apply).toHaveBeenCalled();
    // …and not the one that happens to be first in the registry, which is the failure a
    // single-harness fixture cannot see.
    expect(h.adapters['claude-code']?.apply).not.toHaveBeenCalled();
    // The saved v2 selection records exactly what was picked.
    const manifest = JSON.parse(
      readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8'),
    ) as { desired: string[] };
    expect(manifest.desired).toEqual(['cursor']);
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
    // The selected harness's fragments were reconciled into place (ADR 282).
    expect(h.adapters['claude-code']!.apply).toHaveBeenCalled();
    // primer written to AGENTS.md in the (temp) cwd
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toContain('## Your musterd team');
    // The strict v2 manifest records the selection before reconciliation ran.
    const manifest = JSON.parse(
      readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8'),
    ) as { version: number; desired: string[] };
    expect(manifest.version).toBe(2);
    expect(manifest.desired).toEqual(['claude-code']);
    const { saveBinding } = await import('../config.js');
    const binding = vi.mocked(saveBinding).mock.calls[0]![1] as Record<string, unknown>;
    expect(binding['autojoin']).toBe(true);
    expect(binding['driver']).toBe('nick');
  });

  it('declining the wire step prints manual setup and exits 0 — the saved selection survives', async () => {
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'generalist'); // intent, role-template
    h.multiQueue.push(['claude-code']);
    h.confirmQueue.push(true, false); // autojoin yes, wire NO
    expect(await runInit()).toBe(0);
    expect(h.adapters['claude-code']?.apply).not.toHaveBeenCalled();
    // Desire was saved BEFORE the wire question, so `musterd wire` can finish the job headlessly.
    const manifest = JSON.parse(
      readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8'),
    ) as { desired: string[] };
    expect(manifest.desired).toEqual(['claude-code']);
  });

  it('returns 1 when minting the member fails', async () => {
    h.http.addMember.mockRejectedValue(new Error('member "Ada" already exists'));
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'backend');
    h.selectQueue.push('new', 'generalist'); // intent, role-template
    h.multiQueue.push(['claude-code']);
    h.confirmQueue.push(true); // autojoin (mint happens before wire)
    expect(await runInit()).toBe(1);
  });

  it('returns 1 when harness reconciliation fails', async () => {
    const adapter = (h.adapters['claude-code'] ??= h.adapterFor('claude-code'));
    (adapter.apply as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('claude mcp add failed'),
    );
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
    h.selectQueue.push('new', 'generalist'); // intent, role
    h.multiQueue.push(['claude-code']);
    h.confirmQueue.push(true, true, false); // autojoin, wire, primer NO
    expect(await runInit()).toBe(0);
  });

  it('provisioning a richer profile provisions its tools; the label comes only from the free-text prompt (ADR 272 inc 2)', async () => {
    h.textQueue.push('dawn', 'nick', '', 'Ada', ''); // slug, you, your-role, name, role label (blank)
    h.selectQueue.push('new', 'backend'); // intent, profile = backend
    h.multiQueue.push(['claude-code']); // the ADR 281 harness multi-select
    h.confirmQueue.push(true, true, true); // autojoin, wire, primer — no override gate anymore
    expect(await runInit()).toBe(0);
    // The profile pick does NOT derive the roster label — a profile is configuration, not identity.
    expect(h.http.addMember).toHaveBeenCalledWith('dawn', {
      name: 'Ada',
      kind: 'agent',
      role: '',
    });
    expect(h.harness.provision).toHaveBeenCalled();
    const plan = h.harness.provision.mock.calls[0]![0] as { servers: { name: string }[] };
    expect(plan.servers.map((s) => s.name)).toContain('supabase');
    // the v2 manifest records the provisioned PROFILE (not the roster label) AND the profile's
    // servers for exact removal
    const manifest = JSON.parse(readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8'));
    expect(manifest.version).toBe(2);
    expect(manifest.profile).toBe('backend');
    expect(manifest.contributions['role-tools']).toContain('role-server claude-code supabase');
    // and the profile's charter no longer lands in the primer — charter is the role layer's (ADR 272)
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).not.toContain('## Your charter');
  });

  it('a free-text label rides alongside an independent profile pick', async () => {
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'platform'); // …name, then the label
    h.selectQueue.push('new', 'backend'); // intent, profile = backend
    h.multiQueue.push(['claude-code']);
    h.confirmQueue.push(true, true, true); // autojoin, wire, primer
    expect(await runInit()).toBe(0);
    expect(h.http.addMember).toHaveBeenCalledWith('dawn', {
      name: 'Ada',
      kind: 'agent',
      role: 'platform',
    });
    // the tools come from the chosen profile, independent of the label
    expect(h.harness.provision).toHaveBeenCalled();
  });

  it("the primer's charter comes from the team role library, not the profile (ADR 272 inc 2)", async () => {
    h.http.roster.mockResolvedValue({
      members: [{ name: 'Ada', presence: 'online' }],
      roles: [{ name: 'platform', summary: 'infra toucher', charter: 'You touch infra.' }],
    } as never);
    h.textQueue.push('dawn', 'nick', '', 'Ada', 'platform'); // label names a library role
    h.selectQueue.push('new', 'backend'); // intent, profile = backend (has its own charter)
    h.multiQueue.push(['claude-code']);
    h.confirmQueue.push(true, true, true); // autojoin, wire, primer
    expect(await runInit()).toBe(0);
    const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('## Your charter (platform)');
    expect(agents).toContain('You touch infra.');
    // the backend PROFILE's charter must not be the source
    expect(agents).not.toContain('Own the server + data layer');
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

// The old secret/gitignore offers are structurally gone: since ADR 165 the harness entries carry no
// secret (only the ADR 286 launch marker), and the guidance files ride stamp-gated fragments the
// reconciler owns — there is no init-time "gitignore the token config" moment left to test. The
// binding.json warning (warnSecretConfig) keeps its own coverage in config.test.ts.

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
