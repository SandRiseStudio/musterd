import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uninstallCommand } from './uninstall.js';

let cwd: string;
let origCwd: string;
let cfgPath: string;

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-uninstall-'));
  process.chdir(cwd);
  cwd = process.cwd();
  cfgPath = join(cwd, 'config.json');
  process.env['MUSTERD_CONFIG'] = cfgPath;
});
afterEach(() => {
  process.chdir(origCwd);
  delete process.env['MUSTERD_CONFIG'];
});

function parsed(flags: Record<string, string | boolean> = {}) {
  return { positionals: [], flags, metaPairs: [] };
}

describe('uninstallCommand', () => {
  it('reports nothing to do in a clean folder', async () => {
    expect(await uninstallCommand(parsed({ force: true }))).toBe(0);
  });

  it('refuses without --force when not a TTY', async () => {
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(
      join(cwd, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 1,
        role: 'frontend',
        harness: 'cursor',
        mcpServers: ['figma'],
        permissions: { allow: [], ask: [], deny: [] },
        provisionedAt: '2026-06-23T00:00:00.000Z',
      }),
    );
    expect(await uninstallCommand(parsed())).toBe(2); // stdin is not a TTY in vitest
  });

  it('removes provisioned + musterd servers, strips the primer, and clears local state', async () => {
    // a cursor-provisioned folder: musterd + figma + a user server, a manifest, a binding, a primer
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(
      join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          musterd: { command: 'node', args: [] },
          figma: { command: 'npx', args: [] },
          mine: { command: 'x', args: [] },
        },
      }),
    );
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(
      join(cwd, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 1,
        role: 'frontend',
        harness: 'cursor',
        mcpServers: ['figma'],
        permissions: { allow: [], ask: [], deny: [] },
        provisionedAt: '2026-06-23T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(cwd, '.musterd', 'binding.json'),
      JSON.stringify({
        server: 'http://localhost:4849',
        team: 'dawn',
        member: 'Ada',
        token: 'mskd_x',
        surface: 'cursor',
      }),
    );
    writeFileSync(
      join(cwd, 'AGENTS.md'),
      '# My project\n\nhello\n\n<!-- musterd:start (managed) -->\nprimer\n<!-- musterd:end -->\n',
    );

    expect(await uninstallCommand(parsed({ force: true }))).toBe(0);

    const cursorCfg = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorCfg.mcpServers.figma).toBeUndefined(); // provisioned → removed
    expect(cursorCfg.mcpServers.musterd).toBeUndefined(); // musterd server → removed
    expect(cursorCfg.mcpServers.mine).toBeTruthy(); // user's own → kept

    const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# My project'); // user prose kept
    expect(agents).not.toContain('musterd:start'); // primer block stripped

    expect(existsSync(join(cwd, '.musterd', 'provisioned.json'))).toBe(false);
    expect(existsSync(join(cwd, '.musterd', 'binding.json'))).toBe(false);
  });

  it('resolves the harness by the binding surface when there is no manifest', async () => {
    // a configure-only folder (no role provisioned): just the musterd server + a binding
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(
      join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { musterd: { command: 'node', args: [] } } }),
    );
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(
      join(cwd, '.musterd', 'binding.json'),
      JSON.stringify({
        server: 'http://localhost:4849',
        team: 'dawn',
        member: 'Ada',
        token: 'mskd_x',
        surface: 'cursor',
      }),
    );

    expect(await uninstallCommand(parsed({ force: true }))).toBe(0);
    const cursorCfg = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorCfg.mcpServers.musterd).toBeUndefined();
  });
});
