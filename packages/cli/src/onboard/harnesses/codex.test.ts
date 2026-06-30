import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntry } from '../mcpEntry.js';
import { codex } from './codex.js';
import { hasServer } from './codexToml.js';

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
    expect(toml).toContain('MUSTERD_TEAM = "dawn"');

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
