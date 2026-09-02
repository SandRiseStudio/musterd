import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntry } from '../mcpEntry.js';
import { STANDARD_FLOOR } from '../permissions.js';
import { GATE_MARKER, INTERRUPT_MARKER, grok, inspectGrokHookDrift } from './grok.js';

const binding = {
  server: 'http://localhost:4849',
  team: 'dawn',
  agent_key: 'mskey_secret',
  surface: 'grok' as const,
  claim: { mode: 'seat' as const, name: 'Ada' },
};

let cwd: string;
let origCwd: string;
const cfgPath = () => join(cwd, '.grok', 'config.toml');
const hooksPath = () => join(cwd, '.grok', 'hooks', 'musterd.json');

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-grok-'));
  process.chdir(cwd);
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe('grok.configure', () => {
  it('writes the musterd MCP server into project-local .grok/config.toml and detects it', async () => {
    const result = await grok.configure(buildEntry(binding), binding);
    expect(result.target).toContain('.grok/config.toml');
    expect(result.secretPath).toBe(cfgPath());
    const toml = readFileSync(cfgPath(), 'utf8');
    expect(toml).toContain('[mcp_servers.musterd]');
    expect(toml).not.toContain('MUSTERD_AGENT_KEY');
    expect(toml).not.toContain('MUSTERD_CLAIM');
    expect(toml).not.toContain('MUSTERD_MODEL');
    // Launch marker is the fragment reconciler's (ADR 286), same as OpenCode/Cursor configure.
    expect(toml).not.toContain('MUSTERD_LAUNCH_SURFACE');
    expect(toml).toMatch(/\[compat\.cursor\][\s\S]*hooks\s*=\s*false/);
    expect(toml).toContain('musterd-grok-statusline');
    const after = await grok.detect();
    expect(after.configured).toBe(true);
  });

  it('preserves a hand-written [ui] table', async () => {
    mkdirSync(join(cwd, '.grok'), { recursive: true });
    writeFileSync(cfgPath(), '[ui]\ncompact_mode = true\n');
    await grok.configure(buildEntry(binding), binding);
    const toml = readFileSync(cfgPath(), 'utf8');
    expect(toml).toContain('compact_mode = true');
    expect(toml).toContain('[mcp_servers.musterd]');
  });

  it('does not treat a Cursor-only mcp.json as Grok configured', async () => {
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(
      join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { musterd: { command: 'node', args: ['x'] } } }),
    );
    const d = await grok.detect();
    expect(d.configured).toBe(false);
  });

  it('does not overwrite a foreign statusline', async () => {
    mkdirSync(join(cwd, '.grok'), { recursive: true });
    writeFileSync(cfgPath(), '[ui.status_line]\ntype = "builtin"\nitems = ["cwd"]\n');
    const result = await grok.configure(buildEntry(binding), binding);
    const toml = readFileSync(cfgPath(), 'utf8');
    expect(toml).toContain('type = "builtin"');
    expect(toml).not.toContain('musterd-grok-statusline');
    expect(result.warnings?.some((w) => /status_line/.test(w))).toBe(true);
  });

  it('installs the standard permission floor when [permission] is absent', async () => {
    await grok.configure(buildEntry(binding), binding);
    const toml = readFileSync(cfgPath(), 'utf8');
    expect(toml).toContain('[permission]');
    for (const entry of STANDARD_FLOOR.allow) {
      expect(toml).toContain(JSON.stringify(entry));
    }
  });

  it('does not overwrite an existing [permission] table', async () => {
    mkdirSync(join(cwd, '.grok'), { recursive: true });
    writeFileSync(cfgPath(), '[permission]\nallow = ["Read"]\n');
    await grok.configure(buildEntry(binding), binding);
    const toml = readFileSync(cfgPath(), 'utf8');
    expect(toml).toMatch(/\[permission\]\s*allow = \["Read"\]/);
    expect(toml).not.toContain(JSON.stringify('Bash(git status *)'));
  });
});

describe('grok hooks (Claude-parity set)', () => {
  it('installs Notification, interrupt, gate, capture, and end hooks', async () => {
    await grok.configure(buildEntry(binding), binding);
    expect(existsSync(hooksPath())).toBe(true);
    const file = JSON.parse(readFileSync(hooksPath(), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(file.hooks['Notification']?.[0]?.hooks[0]?.command).toContain('musterd nudge');
    expect(file.hooks['PostToolUse']?.[0]?.hooks[0]?.command).toContain(INTERRUPT_MARKER);
    expect(file.hooks['PostToolUse']?.[0]?.hooks[0]?.command).toContain('interrupt-check');
    expect(file.hooks['PreToolUse']?.[0]?.hooks[0]?.command).toContain(GATE_MARKER);
    expect(file.hooks['SessionStart']?.[0]?.hooks[0]?.command).toContain('session start');
    expect(file.hooks['SessionEnd']?.[0]?.hooks[0]?.command).toContain('session end');
  });

  it('reports drift when the gate hook is missing', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = JSON.parse(readFileSync(hooksPath(), 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    delete file.hooks['PreToolUse'];
    writeFileSync(hooksPath(), JSON.stringify(file));
    const drift = inspectGrokHookDrift(cwd);
    expect(drift.some((d) => d.includes('PreToolUse'))).toBe(true);
  });
});

describe('grok.refreshHooks', () => {
  it('installs hooks, statusline, and the permission floor without rewriting MCP', () => {
    mkdirSync(join(cwd, '.grok'), { recursive: true });
    writeFileSync(
      cfgPath(),
      [
        '[mcp_servers.musterd]',
        'command = "/keep/node"',
        'args = ["/keep/adapter.js"]',
        '',
        '[mcp_servers.musterd.env]',
        'MUSTERD_LAUNCH_SURFACE = "grok"',
        '',
      ].join('\n'),
    );
    const res = grok.refreshHooks!.run(cwd);
    expect(res.files).toContain(hooksPath());
    expect(existsSync(hooksPath())).toBe(true);
    const toml = readFileSync(cfgPath(), 'utf8');
    expect(toml).toContain('command = "/keep/node"');
    expect(toml).toContain('MUSTERD_LAUNCH_SURFACE = "grok"');
    expect(toml).toContain('musterd-grok-statusline');
    expect(toml).toContain('[permission]');
    expect(toml).toMatch(/\[compat\.cursor\][\s\S]*hooks\s*=\s*false/);
  });
});
