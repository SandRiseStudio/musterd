import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Harness, ProvisionPlan, UnprovisionPlan } from '../harness.js';
import type { McpServerEntry } from '../mcpEntry.js';
import { hasServer, removeServers, upsertServer, type CodexServer } from './codexToml.js';

/**
 * Codex (OpenAI Codex CLI). Codex reads MCP servers from `[mcp_servers.<name>]` tables in a TOML
 * config that can be **global** (`~/.codex/config.toml`) or **project-local** (`.codex/config.toml`,
 * trusted projects). musterd writes the **project-local** file — the same non-invasive posture as
 * Cursor's `.cursor/mcp.json` (ADR 027): one folder, in-tree, gitignorable, cleanly removable, and
 * never touching the user's global Codex setup or polluting their other projects (ADR 031).
 *
 * It edits TOML directly via a minimal `[mcp_servers.*]`-scoped helper rather than the `codex mcp
 * add` CLI: that CLI's write target (global vs. project) isn't a documented, stable flag, and writing
 * the project-local file ourselves is the deterministic, correct-scope choice — and needs no TOML
 * dependency (hard rule #6). See ADR 031.
 */
function projectConfigPath(): string {
  return join(process.cwd(), '.codex', 'config.toml');
}

function readToml(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function writeToml(path: string, toml: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toml.endsWith('\n') ? toml : toml + '\n', 'utf8');
}

function toCodexServer(entry: McpServerEntry): CodexServer {
  return { command: entry.command, args: entry.args, env: entry.env };
}

export const codex: Harness = {
  id: 'codex',
  label: 'Codex',
  surface: 'codex',

  async detect() {
    const installed = existsSync(join(homedir(), '.codex'));
    const configured = hasServer(readToml(projectConfigPath()), 'musterd');
    return {
      installed,
      configured,
      detail: installed ? '~/.codex present' : '~/.codex not found',
    };
  },

  async configure(entry: McpServerEntry) {
    const path = projectConfigPath();
    writeToml(path, upsertServer(readToml(path), 'musterd', toCodexServer(entry)));
    return {
      target: path,
      activation:
        'open this folder in Codex (it must be a trusted project) so Codex starts the musterd MCP server',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
    };
  },

  // Provision a role's MCP servers into the project-local `.codex/config.toml`, additively
  // (ADR 027 — never clobber the user's other `[mcp_servers.*]` tables or their other settings).
  // `${ENV}` secrets are written as references, never resolved/baked here; whether Codex expands them
  // is Codex's concern — musterd writes the template's reference string, never a real secret.
  // Codex has no per-tool allowlist model, so permissions degrade to declared intent (none added).
  async provision(plan: ProvisionPlan) {
    const path = projectConfigPath();
    let toml = readToml(path);
    const servers: string[] = [];
    for (const s of plan.servers) {
      toml = upsertServer(toml, s.name, { command: s.command, args: s.args, env: s.env });
      servers.push(s.name);
    }
    if (servers.length > 0) writeToml(path, toml);
    return {
      servers,
      permissions: { allow: [], ask: [], deny: [] },
      target: path,
      activation: 'reload Codex (or reopen this folder) to pick up the new MCP servers',
    };
  },

  // Reverse a provision (ADR 027): remove exactly the named `[mcp_servers.*]` tables.
  async unprovision(plan: UnprovisionPlan) {
    const path = projectConfigPath();
    const toml = readToml(path);
    if (toml.length === 0) return;
    const next = removeServers(toml, plan.servers);
    if (next !== toml) writeToml(path, next);
  },
};
