import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Harness } from '../harness.js';
import type { McpServerEntry } from '../mcpEntry.js';

interface CursorConfig {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

function projectConfigPath(): string {
  return join(process.cwd(), '.cursor', 'mcp.json');
}
function globalConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

function readConfig(path: string): CursorConfig | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CursorConfig;
  } catch {
    return null;
  }
}

function hasMusterd(path: string): boolean {
  const cfg = readConfig(path);
  return Boolean(cfg?.mcpServers?.['musterd']);
}

/** Cursor: configured via .cursor/mcp.json. We write the project-scoped file in cwd. */
export const cursor: Harness = {
  id: 'cursor',
  label: 'Cursor',
  surface: 'cursor',

  async detect() {
    const installed = existsSync(join(homedir(), '.cursor'));
    const configured = hasMusterd(projectConfigPath()) || hasMusterd(globalConfigPath());
    return {
      installed,
      configured,
      detail: installed ? '~/.cursor present' : '~/.cursor not found',
    };
  },

  async configure(entry: McpServerEntry) {
    const path = projectConfigPath();
    const cfg = readConfig(path) ?? {};
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers['musterd'] = { command: entry.command, args: entry.args, env: entry.env };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return {
      target: path,
      activation:
        'open this folder in Cursor (or reload the window) so Cursor starts the musterd MCP server',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
    };
  },
};
