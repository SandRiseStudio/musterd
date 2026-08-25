import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntry } from '../mcpEntry.js';
import { jsoncConflict, opencode } from './opencode.js';

const binding = {
  server: 'http://localhost:4849',
  team: 'dawn',
  agent_key: 'mskey_secret',
  surface: 'opencode' as const,
  claim: { mode: 'seat' as const, name: 'Ada' },
};

let cwd: string;
let origCwd: string;
const cfgPath = () => join(cwd, '.opencode', 'opencode.json');

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-opencode-'));
  process.chdir(cwd);
  cwd = process.cwd(); // normalize macOS /var → /private/var
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe('opencode.configure', () => {
  it('writes the musterd local-server entry into project-local .opencode/opencode.json and detects it', async () => {
    const result = await opencode.configure(buildEntry(binding), binding);
    expect(result.target).toContain('.opencode/opencode.json');
    expect(result.secretPath).toBe(cfgPath());

    const cfg = JSON.parse(readFileSync(cfgPath(), 'utf8')) as {
      mcp: Record<
        string,
        { type: string; command: string[]; environment?: Record<string, string> }
      >;
    };
    const entry = cfg.mcp['musterd'];
    expect(entry.type).toBe('local');
    expect(entry.command.length).toBeGreaterThanOrEqual(1);
    // ADR 165: no per-seat state reaches the written config — identity resolves from binding.
    expect(entry.environment?.MUSTERD_TEAM).toBeUndefined();
    // Parity with every sibling lifecycle adapter: configure writes the bare entry; the
    // ADR 286 launch marker is the fragment reconciler's to own, not configure's.
    expect(entry.environment?.MUSTERD_LAUNCH_SURFACE).toBeUndefined();

    const after = await opencode.detect();
    expect(after.configured).toBe(true);
  });

  it('preserves existing user config when adding musterd', async () => {
    mkdirSync(join(cwd, '.opencode'), { recursive: true });
    writeFileSync(
      cfgPath(),
      JSON.stringify({ theme: 'ayu', mcp: { context7: { type: 'local', command: ['npx'] } } }),
    );
    await opencode.configure(buildEntry(binding), binding);
    const cfg = JSON.parse(readFileSync(cfgPath(), 'utf8')) as {
      theme?: string;
      mcp: Record<string, unknown>;
    };
    expect(cfg.theme).toBe('ayu');
    expect(cfg.mcp['context7']).toBeDefined();
    expect(cfg.mcp['musterd']).toBeDefined();
  });

  it('refuses to write when the folder carries an opencode.jsonc — it does not race a second config', async () => {
    mkdirSync(join(cwd, '.opencode'), { recursive: true });
    writeFileSync(join(cwd, '.opencode', 'opencode.jsonc'), '{ // hand-tuned\n}');
    expect(jsoncConflict(cwd)).toContain('opencode.jsonc');
    await expect(opencode.configure(buildEntry(binding), binding)).rejects.toThrow(/jsonc/);
    expect(existsSync(cfgPath())).toBe(false);
  });
});

describe('opencode.provision / unprovision', () => {
  it('provisions role servers additively with ${ENV} references intact, and reports no permissions', async () => {
    const result = await opencode.provision({
      servers: [
        {
          name: 'roletool',
          command: 'node',
          args: ['role.js'],
          env: { ROLE_TOKEN: '${ROLE_TOKEN}' },
        },
      ],
      permissions: { allow: [], ask: [], deny: [] },
    });
    expect(result.servers).toEqual(['roletool']);
    expect(result.permissions).toEqual({ allow: [], ask: [], deny: [] });
    const cfg = JSON.parse(readFileSync(cfgPath(), 'utf8')) as {
      mcp: Record<string, { environment?: Record<string, string> }>;
    };
    expect(cfg.mcp['roletool']?.environment?.ROLE_TOKEN).toBe('${ROLE_TOKEN}');
  });

  it('unprovisions exactly the named servers and drops the empty mcp map', async () => {
    await opencode.provision({
      servers: [{ name: 'a', command: 'a', args: [], env: {} }],
      permissions: { allow: [], ask: [], deny: [] },
    });
    await opencode.unprovision({
      servers: ['a'],
      permissions: { allow: [], ask: [], deny: [] },
    });
    const cfg = JSON.parse(readFileSync(cfgPath(), 'utf8')) as { mcp?: unknown };
    expect(cfg.mcp).toBeUndefined();
  });

  it('unprovision is a no-op when there is no config file', async () => {
    await expect(
      opencode.unprovision({ servers: ['a'], permissions: { allow: [], ask: [], deny: [] } }),
    ).resolves.toBeUndefined();
  });
});

describe('opencode detect reads its own entry back', () => {
  it('surfaces baked legacy env as registered* fields', async () => {
    mkdirSync(join(cwd, '.opencode'), { recursive: true });
    writeFileSync(
      cfgPath(),
      JSON.stringify({
        mcp: {
          // Near-miss keys are the user's own servers — never ours.
          musterdish: { type: 'local', command: ['x'] },
          musterd: {
            type: 'local',
            command: ['node', 'adapter.js'],
            environment: { MUSTERD_SURFACE: 'opencode' },
          },
        },
      }),
    );
    const d = await opencode.detect();
    expect(d.configured).toBe(true);
    expect(d.registeredSurface).toBe('opencode');
  });

  it('reports not configured when the folder has no opencode entry at all', async () => {
    const d = await opencode.detect();
    expect(d.configured).toBe(false);
  });
});
