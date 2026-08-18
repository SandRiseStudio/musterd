import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntry } from '../mcpEntry.js';
import { codex } from './codex.js';
import { inspectCodexHookDrift } from './codexHooks.js';
import { hasServer, renderServer } from './codexToml.js';

const binding = {
  server: 'http://localhost:4849',
  team: 'dawn',
  agent_key: 'mskey_secret',
  surface: 'codex' as const,
  claim: { mode: 'seat' as const, name: 'Ada' },
};

let cwd: string;
let origCwd: string;
const cfgPath = () => join(cwd, '.codex', 'config.toml');

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-codex-'));
  process.chdir(cwd);
  cwd = process.cwd(); // normalize macOS /var → /private/var
});
afterEach(() => {
  process.chdir(origCwd);
});

describe('codex.configure', () => {
  it('writes the musterd server into project-local .codex/config.toml and detects it', async () => {
    const result = await codex.configure(buildEntry(binding), binding);
    expect(result.target).toContain('.codex/config.toml');
    expect(result.secretPath).toBe(cfgPath());

    const toml = readFileSync(cfgPath(), 'utf8');
    expect(hasServer(toml, 'musterd')).toBe(true);
    // ADR 165: no per-seat state reaches the written config — team resolves from binding/workspace.
    expect(toml).not.toContain('MUSTERD_TEAM');

    const after = await codex.detect();
    expect(after.configured).toBe(true);
    expect(inspectCodexHookDrift(cwd)).toEqual([]);
  });

  it('preserves existing user config when adding musterd', async () => {
    mkdirSync(join(cwd, '.codex'), { recursive: true });
    writeFileSync(
      cfgPath(),
      'model = "o3"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = []\n',
    );
    await codex.configure(buildEntry(binding), binding);
    const toml = readFileSync(cfgPath(), 'utf8');
    expect(toml).toContain('model = "o3"');
    expect(hasServer(toml, 'context7')).toBe(true);
    expect(hasServer(toml, 'musterd')).toBe(true);
  });
});

describe('codex.provision / unprovision', () => {
  it('provisions role servers additively, reports no permissions, keeps ${ENV} references', async () => {
    await codex.configure(buildEntry(binding), binding); // seed musterd
    const result = await codex.provision!({
      servers: [
        {
          name: 'supabase',
          command: 'npx',
          args: ['-y', '@supabase/mcp'],
          env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' },
        },
      ],
      permissions: { allow: ['edit'], ask: [], deny: [] },
    });
    expect(result.servers).toEqual(['supabase']);
    expect(result.permissions).toEqual({ allow: [], ask: [], deny: [] });
    const toml = readFileSync(cfgPath(), 'utf8');
    expect(hasServer(toml, 'musterd')).toBe(true); // untouched
    expect(toml).toContain('SUPABASE_ACCESS_TOKEN = "${SUPABASE_ACCESS_TOKEN}"'); // reference kept
  });

  it('unprovisions exactly the named servers, leaving the rest', async () => {
    await codex.configure(buildEntry(binding), binding);
    await codex.provision!({
      servers: [{ name: 'supabase', command: 'npx', args: [], env: {} }],
      permissions: { allow: [], ask: [], deny: [] },
    });
    await codex.unprovision!({
      servers: ['supabase'],
      permissions: { allow: [], ask: [], deny: [] },
    });
    const toml = readFileSync(cfgPath(), 'utf8');
    expect(hasServer(toml, 'supabase')).toBe(false);
    expect(hasServer(toml, 'musterd')).toBe(true);
  });

  it('unprovision is a no-op when there is no config file', async () => {
    await expect(
      codex.unprovision!({ servers: ['musterd'], permissions: { allow: [], ask: [], deny: [] } }),
    ).resolves.toBeUndefined();
  });
});

// The doctor's baked-env inspection used to see only Claude Code, because it was the only harness
// that read its own entry back. A per-seat secret or a stale MUSTERD_SURFACE in `.codex/config.toml`
// was therefore unreportable by construction (measured 2026-08-03).
describe('codex detect reads its own entry back', () => {
  it('surfaces baked legacy env as registered* fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-codex-detect-'));
    const prev = process.cwd();
    try {
      mkdirSync(join(dir, '.codex'), { recursive: true });
      writeFileSync(
        join(dir, '.codex', 'config.toml'),
        renderServer('musterd', {
          command: 'node',
          args: ['/x/bin.js'],
          env: {
            MUSTERD_SURFACE: 'codex',
            MUSTERD_AGENT_KEY: 'mskey_secret',
            MUSTERD_MODEL: 'gpt-5.6-luna',
          },
        }),
      );
      process.chdir(dir);
      const d = await codex.detect();
      expect(d.registeredSurface).toBe('codex');
      expect(d.registeredAgentKey).toBe('mskey_secret');
      expect(d.registeredModel).toBe('gpt-5.6-luna');
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports nothing when the folder has no codex entry at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-codex-detect-none-'));
    const prev = process.cwd();
    const prevHome = process.env['HOME'];
    try {
      // HOME is pinned to an empty dir: "no entry anywhere" is now a claim about the GLOBAL config
      // too, and against the real ~/.codex/config.toml this assertion would pass or fail depending
      // on whose machine ran it.
      process.env['HOME'] = dir;
      process.chdir(dir);
      const d = await codex.detect();
      expect(d.configured).toBe(false);
      expect(d.registeredSurface).toBeUndefined();
      expect(d.registeredAgentKey).toBeUndefined();
    } finally {
      process.chdir(prev);
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Hook drift is a claim about provisioning musterd DID, so it can only be made where musterd
 * provisioned Codex. `detect` used to compute `hookDrift` unconditionally and report it beside
 * `configured: false`, so every Claude-Code-only folder on the machine got a hard ✗ naming a Codex
 * file it has no reason to own — observed 2026-08-14 in the izzo seat, whose own `--check` printed
 * the two contradictory lines together: "Codex: no musterd server (~/.codex present)" and "✗ Codex:
 * the project-local Codex hooks are missing from .codex/hooks.json".
 *
 * It matters because `--check` is the drift instrument: the same run also carried a real, load-
 * bearing finding (no harness permissions block — ADR 261, where a non-interactive seat fails closed
 * on its first Write). A permanent unfixable ✗ standing next to a real one is how a checker gets
 * ignored, which is the failure ADR 168 exists to prevent.
 */
describe('codex hook drift is scoped to folders codex is actually wired into', () => {
  it('reports no hook drift when there is no musterd server for this folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-codex-nohooks-'));
    const prev = process.cwd();
    const prevHome = process.env['HOME'];
    try {
      process.env['HOME'] = dir; // no global entry either
      process.chdir(dir);
      const d = await codex.detect();
      expect(d.configured).toBe(false);
      // The bare fact the gate is built on: the file really is absent, so the raw inspector does
      // report drift — `detect` must decline to surface it, rather than the inspector going quiet.
      expect(inspectCodexHookDrift(process.cwd()).length).toBeGreaterThan(0);
      expect(d.hookDrift).toBeUndefined();
    } finally {
      process.chdir(prev);
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still reports hook drift once the folder carries a musterd server', async () => {
    await codex.configure(buildEntry(binding), binding);
    rmSync(join(cwd, '.codex', 'hooks.json'), { force: true }); // configure installs them; drift them
    const d = await codex.detect();
    expect(d.configured).toBe(true);
    expect(d.hookDrift).toBeDefined();
  });
});

/**
 * The other half of the same defect: once drift IS reported, the seat needs a repair it can run.
 * Codex declared no `refreshHooks`, so `musterd init --refresh-hooks` skipped it and the doctor
 * pointed at `musterd wire` — which only registers the MCP server and never calls
 * `installCodexHooks`, so it exits 0 having changed nothing. The only path that installed them was
 * the full `musterd init`, which ADR 161 forbids in a live seat's workspace. Verified 2026-08-14 by
 * running both against a drifted folder and watching the ✗ survive.
 */
describe('codex refreshHooks', () => {
  it('does not apply to a folder codex was never provisioned into (a refresh is not a first install)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-codex-refresh-none-'));
    try {
      expect(codex.refreshHooks?.applies(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies once the folder carries a musterd server, and reinstalls hooks that went missing', async () => {
    await codex.configure(buildEntry(binding), binding);
    rmSync(join(cwd, '.codex', 'hooks.json'), { force: true });
    expect(codex.refreshHooks?.applies(cwd)).toBe(true);
    const res = codex.refreshHooks!.run(cwd);
    expect(res.files).toContain(join(cwd, '.codex', 'hooks.json'));
    expect(res.warnings).toEqual([]);
    // The repair is real, not just a written file: the drift the doctor reported is now gone.
    expect(inspectCodexHookDrift(cwd)).toEqual([]);
  });

  it('warns instead of claiming success when the hooks file is malformed', async () => {
    await codex.configure(buildEntry(binding), binding);
    writeFileSync(join(cwd, '.codex', 'hooks.json'), '{ not json', 'utf8');
    const res = codex.refreshHooks!.run(cwd);
    // installCodexHooks declines to touch a malformed file (it may be hand-authored), and the
    // refresh driver prints "✓ refreshed" off the return value — so a silent [] here would report a
    // repair that did not happen, which is the exact failure ADR 168 exists to end.
    expect(res.files).toEqual([]);
    expect(res.warnings.join(' ')).toMatch(/malformed/);
  });
});

/**
 * Codex merges a **global** `~/.codex/config.toml` with the project-local one, and musterd only ever
 * writes the project file (ADR 031, deliberately non-invasive). `detect` read only the project file,
 * so a globally-registered musterd server read as ABSENT: `musterd init --check` printed "Codex: no
 * musterd server" and called the folder coherent while a Codex session launched there would in fact
 * get that server.
 *
 * Measured on the dogfood machine 2026-08-05: `~/.codex/config.toml` carried `[mcp_servers.musterd]`
 * with MUSTERD_AGENT_KEY, MUSTERD_GRANT, MUSTERD_AUTOJOIN=1, MUSTERD_MODEL and MUSTERD_SURFACE baked
 * in — every value ADR 165 unbaked because it outranks binding.json, sitting in a file that reaches
 * EVERY folder on the machine rather than one worktree. None of it was reportable.
 *
 * Cursor's detect already falls back to its global config; this closes the same gap for Codex, and
 * marks where the entry was found — because `configure` writes the project file, so a repair command
 * cannot reach a global one and must not be prescribed for it.
 */
describe('codex detect sees a globally-registered server', () => {
  let dir: string;
  let home: string;
  let prev: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-codex-global-'));
    home = join(dir, 'home');
    mkdirSync(join(home, '.codex'), { recursive: true });
    prev = process.cwd();
    prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(prev);
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const writeGlobal = (env: Record<string, string>) =>
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      renderServer('musterd', { command: 'node', args: ['/x/bin.js'], env }),
    );

  it('reports configured, and reads the global entry’s baked env back', async () => {
    writeGlobal({
      MUSTERD_AGENT_KEY: 'mskey_secret',
      MUSTERD_GRANT: 'msgr_secret',
      MUSTERD_AUTOJOIN: '1',
      MUSTERD_MODEL: 'gpt-5.6-luna',
      MUSTERD_SURFACE: 'codex',
    });
    const d = await codex.detect();
    expect(d.configured).toBe(true);
    expect(d.registeredAgentKey).toBe('mskey_secret');
    expect(d.registeredGrant).toBe('msgr_secret');
    expect(d.registeredAutojoin).toBe('1');
    expect(d.registeredModel).toBe('gpt-5.6-luna');
    expect(d.registeredSurface).toBe('codex');
  });

  it('names the global file as one no repair here can rewrite, and says so in the detail', async () => {
    writeGlobal({ MUSTERD_SURFACE: 'codex' });
    const d = await codex.detect();
    expect(d.registeredElsewhere).toBe(join(home, '.codex', 'config.toml'));
    expect(d.detail).toContain('~/.codex/config.toml');
  });

  it('prefers the project entry, which IS the file configure writes', async () => {
    writeGlobal({ MUSTERD_SURFACE: 'codex', MUSTERD_AGENT_KEY: 'mskey_global' });
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(
      join(dir, '.codex', 'config.toml'),
      renderServer('musterd', { command: 'node', args: ['/x/bin.js'], env: {} }),
    );
    const d = await codex.detect();
    // The project file wins, so the global file's baked key is not attributed to this folder...
    expect(d.registeredAgentKey).toBeUndefined();
    // ...and the entry read IS the one `configure` rewrites, so a repair may be prescribed.
    expect(d.registeredElsewhere).toBeUndefined();
  });
});
