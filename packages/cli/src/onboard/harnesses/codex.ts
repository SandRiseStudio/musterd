import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readModelFromTranscript } from '../../session/transcript-model.js';
import {
  registeredFromEnv,
  type Harness,
  type ProvisionPlan,
  type UnprovisionPlan,
} from '../harness.js';
import type { McpServerEntry } from '../mcpEntry.js';
import { inspectCodexHookDrift, installCodexHooks, removeCodexHooks } from './codexHooks.js';
import {
  hasServer,
  readServerEnv,
  removeServers,
  upsertServer,
  type CodexServer,
} from './codexToml.js';

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

/**
 * Codex's machine-global config. musterd never WRITES it (see above), but Codex merges it with the
 * project file, so a musterd server defined here is live in every folder on the machine — and
 * reading it back is the only way `init --check` can stop reporting "no musterd server" while one is
 * plainly there. Read-only by construction: nothing in this adapter passes this path to `writeToml`.
 */
function globalConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
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
  // `.codex/config.toml` is per-folder — and in-tree, so a secret here is committable (ADR 031).
  entryScope: 'folder',
  // No `guidance` (ADR 085): Codex has no project-level skill/rule or slash-command mechanism, so it
  // relies on the harness-neutral `.musterd/skill/SKILL.md` (always written) that the primer points at.

  // Codex rollout logs are JSONL carrying the same `message.model` shape, so the shared reader
  // handles both. A `musterd host`-spawned Codex seat is authoritative from its spawn arguments and
  // never needs this path; a hand-launched one gets whatever its rollout log reports, or `undefined`.
  observeModel: (payload) =>
    payload.transcript_path ? readModelFromTranscript(payload.transcript_path) : undefined,

  async detect() {
    const installed = existsSync(join(homedir(), '.codex'));
    const projectToml = readToml(projectConfigPath());
    // The project file is what musterd writes, so it is what an entry here MEANS — the global file
    // is the fallback, and only when the folder has none of its own. Getting this order wrong would
    // attribute another seat's baked credential to this folder.
    const inProject = hasServer(projectToml, 'musterd');
    const globalToml = inProject ? '' : readToml(globalConfigPath());
    const inGlobal = !inProject && hasServer(globalToml, 'musterd');
    const configured = inProject || inGlobal;
    const hookDrift = inspectCodexHookDrift(process.cwd());
    return {
      installed,
      configured,
      detail: inGlobal
        ? 'registered in ~/.codex/config.toml (machine-global — musterd writes the project file)'
        : installed
          ? '~/.codex present'
          : '~/.codex not found',
      // Read the entry's env back so the doctor can flag a baked legacy value here too. Before this,
      // only Claude Code's entry was ever inspected, so a per-seat secret or a stale MUSTERD_SURFACE
      // in `.codex/config.toml` was invisible by construction.
      ...(inProject ? registeredFromEnv(readServerEnv(projectToml, 'musterd')) : {}),
      // A global entry's values are just as live — they outrank binding.json in the adapter's ladder
      // exactly the same way — but no repair run in this folder rewrites that file, so it is reported
      // WITH its location rather than with a prescription (ADR 168).
      ...(inGlobal
        ? {
            ...registeredFromEnv(readServerEnv(globalToml, 'musterd')),
            registeredElsewhere: globalConfigPath(),
          }
        : {}),
      ...(hookDrift.length > 0 ? { hookDrift } : {}),
    };
  },

  async configure(entry: McpServerEntry) {
    const path = projectConfigPath();
    writeToml(path, upsertServer(readToml(path), 'musterd', toCodexServer(entry)));
    installCodexHooks(process.cwd());
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
    if (!hasServer(next, 'musterd')) removeCodexHooks(process.cwd());
  },
};
