import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Harness, ProvisionPlan, UnprovisionPlan } from '../harness.js';
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

function writeConfig(path: string, cfg: CursorConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
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
    writeConfig(path, cfg);
    return {
      target: path,
      activation:
        'open this folder in Cursor (or reload the window) so Cursor starts the musterd MCP server',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
    };
  },

  // Provision a role's MCP servers into the project-local `.cursor/mcp.json` map, additively
  // (ADR 027 — never clobber the user's other servers). `${ENV}` secrets are written as references;
  // Cursor expands them at launch (it is never resolved/baked here). Cursor has no managed
  // allow/ask/deny permission model, so permissions are *not* provisioned — they degrade to the
  // role's declared intent (charter); `provision` reports none added.
  async provision(plan: ProvisionPlan) {
    const path = projectConfigPath();
    const cfg = readConfig(path) ?? {};
    cfg.mcpServers = cfg.mcpServers ?? {};
    const servers: string[] = [];
    for (const s of plan.servers) {
      cfg.mcpServers[s.name] = { command: s.command, args: s.args, env: s.env };
      servers.push(s.name);
    }
    if (servers.length > 0) writeConfig(path, cfg);
    return {
      servers,
      permissions: { allow: [], ask: [], deny: [] },
      target: path,
      activation: 'reload Cursor (or reopen this folder) to pick up the new MCP servers',
    };
  },

  // Reverse a provision (ADR 027): remove exactly the named servers from `.cursor/mcp.json`.
  async unprovision(plan: UnprovisionPlan) {
    const path = projectConfigPath();
    const cfg = readConfig(path);
    if (!cfg?.mcpServers) return;
    let changed = false;
    for (const name of plan.servers) {
      if (name in cfg.mcpServers) {
        delete cfg.mcpServers[name];
        changed = true;
      }
    }
    if (changed) writeConfig(path, cfg);
  },
};
