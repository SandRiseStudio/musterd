import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, WORKSPACE_SPEC_FILE } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';

// Capture what each harness would register, without shelling a real `claude` or writing any config.
const h = vi.hoisted(() => ({
  configure: vi.fn(async () => ({ target: 'claude mcp', activation: '' })),
  configureCursor: vi.fn(async () => ({ target: '.cursor/mcp.json', activation: '' })),
  configureCodex: vi.fn(async () => ({ target: '.codex/config.toml', activation: '' })),
}));
vi.mock('../onboard/harnesses/claudeCode.js', () => ({
  claudeCode: {
    id: 'claude-code',
    label: 'Claude Code',
    surface: 'claude-code',
    entryScope: 'repo-shared',
    configure: h.configure,
  },
}));
vi.mock('../onboard/harnesses/cursor.js', () => ({
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    surface: 'cursor',
    entryScope: 'folder',
    configure: h.configureCursor,
  },
}));
vi.mock('../onboard/harnesses/codex.js', () => ({
  codex: {
    id: 'codex',
    label: 'Codex',
    surface: 'codex',
    entryScope: 'folder',
    configure: h.configureCodex,
  },
}));

const { wireCommand, harnessWiredFor, wireConfigures } = await import('./wire.js');

let cwd: string;
let configPath: string;

beforeEach(() => {
  // Call history is per-test: several assertions below read `mock.calls[0]`, which silently reads a
  // PREVIOUS test's call once a hoisted vi.fn accumulates across the file.
  h.configure.mockClear();
  h.configureCursor.mockClear();
  h.configureCodex.mockClear();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-wire-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  configPath = join(mkdtempSync(join(tmpdir(), 'musterd-wire-cfg-')), 'config.json');
  process.env['MUSTERD_CONFIG'] = configPath;
  delete process.env['MUSTERD_AGENT_KEY'];
  delete process.env['MUSTERD_GRANT'];
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
  delete process.env['MUSTERD_CONFIG'];
  delete process.env['MUSTERD_AGENT_KEY'];
});

/** Write a committed .musterd/workspace.json (secret-free) in cwd. */
function writeSpec(spec: Record<string, unknown>) {
  mkdirSync(join(cwd, BINDING_DIR), { recursive: true });
  writeFileSync(join(cwd, BINDING_DIR, WORKSPACE_SPEC_FILE), JSON.stringify(spec), 'utf8');
}
/** Seed the global config with a team agent key. */
function writeConfig(agentKeys: Record<string, string>) {
  writeFileSync(
    configPath,
    JSON.stringify({
      server: 'http://localhost:4849',
      current: 'bravo',
      identities: {},
      knownIdentities: [],
      bindings: {},
      agentKeys,
      rosterHome: {},
    }),
    'utf8',
  );
}
function readBinding() {
  return JSON.parse(readFileSync(join(cwd, BINDING_DIR, BINDING_FILE), 'utf8'));
}
/** Record which harness this folder was provisioned for (the v1 manifest wire dispatches on —
 *  identity declares no surface since ADR 281; Task 6 moves wire onto the v2 desired set). */
function writeManifest(harness: string) {
  mkdirSync(join(cwd, BINDING_DIR), { recursive: true });
  writeFileSync(
    join(cwd, BINDING_DIR, 'provisioned.json'),
    JSON.stringify({
      version: 1,
      role: '',
      harness,
      mcpServers: ['musterd'],
      permissions: { allow: [], ask: [], deny: [] },
      provisionedAt: '2026-08-01T00:00:00.000Z',
    }),
    'utf8',
  );
}
async function run(argv: string[]) {
  const out: string[] = [];
  const errs: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c: never) => (errs.push(String(c)), true));
  const code = await wireCommand(parseArgs(argv));
  return { code, out: out.join(''), err: errs.join('') };
}

const SPEC = {
  version: 2,
  server: 'http://localhost:4849',
  team: 'bravo',
  claim: { mode: 'seat', name: 'Sonnet' },
};

describe('musterd wire', () => {
  it('registers the server from the committed spec, resolving the key from global config', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_fromconfig' });
    const { code } = await run([]);
    expect(code).toBe(0);
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    // ADR 165: the entry is shared by every worktree of the repo, so it carries NO per-seat state —
    // no team, no key, no claim. The resolved key's destination is binding.json (asserted below),
    // which is per-worktree and what the adapter actually reads.
    expect(entry.env).toEqual({});
    // binding.json materialized with the resolved key
    expect(readBinding().agent_key).toBe('mskey_fromconfig');
  });

  it('preserves an attested model across a re-wire (ADR 101)', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_x' });
    // A seat provisioned with `--model` carries the declaration in the gitignored binding only — the
    // committed spec never holds it. Re-deriving the binding from the spec must not forget it.
    mkdirSync(join(cwd, BINDING_DIR), { recursive: true });
    writeFileSync(
      join(cwd, BINDING_DIR, BINDING_FILE),
      JSON.stringify({ ...SPEC, agent_key: 'mskey_x', model: 'claude-fable-5' }),
      'utf8',
    );
    await run([]);
    expect(readBinding().model).toBe('claude-fable-5');
  });

  it('leaves the model absent when the seat never declared one', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_x' });
    await run([]);
    // undeclared stays honestly undeclared — never a guess (the server renders `unknown`)
    expect(readBinding().model).toBeUndefined();
  });

  it('--autojoin opts into claim-on-launch via the binding, never the shared entry (ADR 165 inc 2)', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_x' });
    await run(['--autojoin']);
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_AUTOJOIN).toBeUndefined();
    expect(readBinding().autojoin).toBe(true);
  });

  it('a re-wire without --autojoin keeps the binding opted in (never silently flips a seat dormant)', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_x' });
    writeFileSync(
      join(cwd, BINDING_DIR, BINDING_FILE),
      JSON.stringify({ ...SPEC, agent_key: 'mskey_x', autojoin: true, driver: 'nick' }),
      'utf8',
    );
    await run([]);
    // autojoin + driver are per-worktree state like model — a re-wire carries them forward.
    expect(readBinding().autojoin).toBe(true);
    expect(readBinding().driver).toBe('nick');
  });

  it('--key overrides the config key; env is the middle precedence', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_config' });
    process.env['MUSTERD_AGENT_KEY'] = 'mskey_env';
    const flagRun = await run(['--key', 'mskey_flag']);
    expect(flagRun.code).toBe(0);
    // Precedence is unchanged (--key > env > config); what changed is WHERE the winner lands.
    // ADR 165: never the shared entry env — binding.json, which is per-worktree.
    expect(readBinding().agent_key).toBe('mskey_flag');
  });

  it('registers keyless + warns when no key is available anywhere', async () => {
    writeSpec(SPEC);
    writeConfig({}); // no key for bravo
    const { code, err } = await run([]);
    expect(code).toBe(0);
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_AGENT_KEY).toBeUndefined(); // registered without a key
    expect(err).toMatch(/no team agent key/i);
    expect(readBinding().agent_key).toBeUndefined();
  });

  it('errors clearly when there is no committed spec', async () => {
    writeConfig({ bravo: 'mskey_x' });
    await expect(wireCommand(parseArgs([]))).rejects.toMatchObject({ exitCode: 6 });
  });

  // What wire configures is what the doctor derives its repair advice from, so the two are only
  // trustworthy together. The advice used to come from a hard-coded ['claude-code']: the doctor
  // therefore told a Codex seat with a baked MUSTERD_SURFACE to edit its config by hand, and the
  // drift re-flagged on every --check forever — a permanently-red check nobody can clear teaches
  // everyone to skim the ✗ block. The prescription is now derived from these same functions.
  it('configures the harness this folder provisioned — a Codex folder gets Codex, not Claude Code', async () => {
    writeSpec(SPEC);
    writeManifest('codex');
    writeConfig({ bravo: 'mskey_x' });
    const { code } = await run([]);
    expect(code).toBe(0);
    expect(h.configureCodex).toHaveBeenCalledTimes(1);
    // ...and it does NOT create a Claude Code entry for a folder that never picked Claude Code.
    expect(h.configure).not.toHaveBeenCalled();
    expect(h.configureCursor).not.toHaveBeenCalled();
  });

  it('configures Cursor for a Cursor folder', async () => {
    writeSpec(SPEC);
    writeManifest('cursor');
    writeConfig({ bravo: 'mskey_x' });
    await run([]);
    expect(h.configureCursor).toHaveBeenCalledTimes(1);
    expect(h.configure).not.toHaveBeenCalled();
  });

  it('falls back to Claude Code when the provisioned harness names no adapter (cli, other)', async () => {
    // Old manifests can carry Presence-surface-ish values no adapter answers to. Wire still has a
    // job there — register the tools — so the default stands.
    writeSpec(SPEC);
    writeManifest('cli');
    writeConfig({ bravo: 'mskey_x' });
    await run([]);
    expect(h.configure).toHaveBeenCalledTimes(1);
    expect(h.configureCodex).not.toHaveBeenCalled();
  });

  it('says which harness it would configure, per folder — the doctor prescribes from this', () => {
    expect(harnessWiredFor('codex').id).toBe('codex');
    expect(harnessWiredFor('cursor').id).toBe('cursor');
    expect(harnessWiredFor('claude-code').id).toBe('claude-code');
    // Unknown/absent degrade to the default rather than to "no harness at all", so the doctor never
    // has to render an empty "`musterd wire` configures  only".
    expect(harnessWiredFor('cli').id).toBe('claude-code');
    expect(harnessWiredFor(undefined).id).toBe('claude-code');
    // The predicate the doctor asks per harness is the same answer, inverted.
    expect(wireConfigures('codex', 'codex')).toBe(true);
    expect(wireConfigures('claude-code', 'codex')).toBe(false);
    expect(wireConfigures('claude-code', undefined)).toBe(true);
  });

  it('never writes a secret into the committed workspace.json (it is secret-free by construction)', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_secret' });
    await run([]);
    // The committed spec on disk must not contain the key that landed in the binding/env.
    const specText = readFileSync(join(cwd, BINDING_DIR, WORKSPACE_SPEC_FILE), 'utf8');
    expect(specText).not.toContain('mskey_');
    // binding.json (gitignored) is where the secret lives.
    expect(existsSync(join(cwd, BINDING_DIR, BINDING_FILE))).toBe(true);
  });
});
