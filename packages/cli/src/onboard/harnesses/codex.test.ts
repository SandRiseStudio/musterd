import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntry } from '../mcpEntry.js';
import { codex } from './codex.js';
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
