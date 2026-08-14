import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  registeredFromEnv,
  type Harness,
  type ProvisionPlan,
  type UnprovisionPlan,
} from '../harness.js';
import type { McpServerEntry } from '../mcpEntry.js';

interface CursorConfig {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

/** Cursor's project hooks file (ADR 198) — versioned map of event → command hooks. */
interface CursorHooksFile {
  version: number;
  hooks?: Record<string, CursorHookDef[]>;
}

interface CursorHookDef {
  command: string;
  matcher?: string;
  timeout?: number;
}

function projectConfigPath(dir: string = process.cwd()): string {
  return join(dir, '.cursor', 'mcp.json');
}
function projectHooksPath(dir: string = process.cwd()): string {
  return join(dir, '.cursor', 'hooks.json');
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

/** Our own registered entry from a Cursor config, or null when this file does not carry one. */
function musterdEntry(path: string): NonNullable<CursorConfig['mcpServers']>[string] | null {
  return readConfig(path)?.mcpServers?.['musterd'] ?? null;
}

function readHooksSafe(path: string): CursorHooksFile | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CursorHooksFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hooks: {} };
    return null; // unparseable — never clobber
  }
}

/** Markers so upsert/drop target our entries without absorbing the user's other hooks. */
export const CURSOR_OBSERVE_HOOK_MARKER = 'musterd-cursor-observe';
export const CURSOR_END_HOOK_MARKER = 'musterd-cursor-end';

function observeHookCommand(): string {
  // ADR 198: pipe Cursor's common-schema stdin (conversation_id, model_id, …) into session observe.
  // cd to the project so binding resolves; never-fail; silent so Agent context stays clean.
  return (
    'cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session observe --stdin >/dev/null 2>&1 || true ' +
    `# ${CURSOR_OBSERVE_HOOK_MARKER}`
  );
}

function sessionEndHookCommand(): string {
  return (
    'cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session end --stdin >/dev/null 2>&1 || true ' +
    `# ${CURSOR_END_HOOK_MARKER}`
  );
}

function isMusterdCursorHook(h: CursorHookDef, marker: string): boolean {
  return h.command.includes(marker);
}

/**
 * Idempotent upsert of a Cursor hook command under `event`. Replaces a prior musterd entry with the
 * same marker; leaves every other hook alone. Returns a warning when the file is unreadable.
 */
function upsertCursorHook(
  path: string,
  event: string,
  marker: string,
  command: string,
): string | undefined {
  const file = readHooksSafe(path);
  if (!file) {
    return `could not parse ${path} — left untouched (fix or remove it, then re-run init)`;
  }
  file.version = file.version || 1;
  file.hooks = file.hooks ?? {};
  const list = file.hooks[event] ?? [];
  const kept = list.filter((h) => !isMusterdCursorHook(h, marker));
  kept.push({ command });
  file.hooks[event] = kept;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf8');
  return undefined;
}

function dropCursorHook(path: string, event: string, marker: string): void {
  const file = readHooksSafe(path);
  if (!file?.hooks?.[event]) return;
  const kept = file.hooks[event]!.filter((h) => !isMusterdCursorHook(h, marker));
  if (kept.length === file.hooks[event]!.length) return;
  if (kept.length > 0) file.hooks[event] = kept;
  else delete file.hooks[event];
  if (file.hooks && Object.keys(file.hooks).length === 0) delete file.hooks;
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

/**
 * Install musterd's Cursor Agent hooks (ADR 198 / 265): sessionStart + postToolUse +
 * afterShellExecution + afterMCPExecution observe the live `model_id`; sessionEnd stamps
 * ended_at. Project-local `.cursor/hooks.json` only. The extra observe events exist because
 * cursor-agent does not dispatch the IDE set.
 */
export function installMusterdCursorHooks(dir: string = process.cwd()): string[] {
  const path = projectHooksPath(dir);
  const warnings: string[] = [];
  for (const [event, marker, command] of [
    ['sessionStart', CURSOR_OBSERVE_HOOK_MARKER, observeHookCommand()] as const,
    ['postToolUse', CURSOR_OBSERVE_HOOK_MARKER, observeHookCommand()] as const,
    // ADR 265: cursor-agent's event surface is a subset of the IDE's. Older CLIs (measured:
    // 2026.01.23) never dispatch sessionStart/postToolUse/sessionEnd; they do dispatch
    // afterShellExecution. afterMCPExecution covers a CLI session that is almost entirely MCP.
    ['afterShellExecution', CURSOR_OBSERVE_HOOK_MARKER, observeHookCommand()] as const,
    ['afterMCPExecution', CURSOR_OBSERVE_HOOK_MARKER, observeHookCommand()] as const,
    ['sessionEnd', CURSOR_END_HOOK_MARKER, sessionEndHookCommand()] as const,
  ]) {
    const w = upsertCursorHook(path, event, marker, command);
    if (w) warnings.push(w);
  }
  return warnings;
}

export function removeMusterdCursorHooks(dir: string = process.cwd()): void {
  const path = projectHooksPath(dir);
  if (!existsSync(path)) return;
  dropCursorHook(path, 'sessionStart', CURSOR_OBSERVE_HOOK_MARKER);
  dropCursorHook(path, 'postToolUse', CURSOR_OBSERVE_HOOK_MARKER);
  dropCursorHook(path, 'afterShellExecution', CURSOR_OBSERVE_HOOK_MARKER);
  dropCursorHook(path, 'afterMCPExecution', CURSOR_OBSERVE_HOOK_MARKER);
  dropCursorHook(path, 'sessionEnd', CURSOR_END_HOOK_MARKER);
}

/** Cursor: configured via .cursor/mcp.json. We write the project-scoped file in cwd. */
export const cursor: Harness = {
  id: 'cursor',
  label: 'Cursor',
  surface: 'cursor',
  // `.cursor/mcp.json` is per-folder — and lives in the working tree, so a secret here is committable.
  entryScope: 'folder',
  // ADR 085: Cursor's closest skill equivalent is a description-gated ("Agent Requested") rule; slash
  // commands land as project commands. Same body as the canonical skill, different frontmatter shell.
  guidance: {
    skillPath: '.cursor/rules/musterd.mdc',
    frontmatter: 'cursor',
    commandsDir: '.cursor/commands',
    // ADR 186: Cursor can rename the *current* chat via `rename_chat` (when cursor-app-control is
    // present) — not a peer sweep. Self-label guidance is a separate unit from Claude's cross-rename.
    selfLabelSkillPath: '.cursor/rules/musterd-label-session.mdc',
  },

  // ADR 198: Cursor Agent hooks carry `model_id` / `model` on the common schema. Prefer the
  // structured id; ignore transcript_path — Cursor JSONL still has no message.model (Claude/Codex
  // pattern does not apply). Empty payload → undefined (honest degradation).
  observeModel: (payload) => {
    const id = payload.model_id?.trim() || payload.model?.trim();
    return id || undefined;
  },

  async detect() {
    const installed = existsSync(join(homedir(), '.cursor'));
    // The project entry is the one musterd writes, so it is the one to inspect; fall back to the
    // global entry only when this folder has none, mirroring `configured` below.
    const projectEntry = musterdEntry(projectConfigPath());
    const fromGlobal = projectEntry === null && hasMusterd(globalConfigPath());
    const entry = projectEntry ?? (fromGlobal ? musterdEntry(globalConfigPath()) : null);
    const configured = hasMusterd(projectConfigPath()) || hasMusterd(globalConfigPath());
    return {
      installed,
      configured,
      detail: fromGlobal
        ? 'registered in ~/.cursor/mcp.json (machine-global — musterd writes the project file)'
        : installed
          ? '~/.cursor present'
          : '~/.cursor not found',
      // Everything below describes the GLOBAL file when the fallback fired, and `configure` writes
      // the project one — so say which file it is, or the doctor prescribes a repair that rewrites
      // something else and reports success (ADR 168).
      ...(fromGlobal ? { registeredElsewhere: globalConfigPath() } : {}),
      // Read our own entry back so the doctor can flag a baked legacy value here too. This is where
      // the gap was measured (2026-08-03): a pre-ADR-165 `.cursor/mcp.json` carrying a per-seat
      // AGENT KEY and GRANT plus a stale MUSTERD_SURFACE, none of it reportable because nothing
      // outside Claude Code's `claude mcp get` was ever parsed.
      ...registeredFromEnv(entry?.env),
      ...(entry?.args ? { registeredArgs: entry.args } : {}),
    };
  },

  async configure(entry: McpServerEntry) {
    const path = projectConfigPath();
    const cfg = readConfig(path) ?? {};
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers['musterd'] = { command: entry.command, args: entry.args, env: entry.env };
    writeConfig(path, cfg);
    let hookWarnings: string[] = [];
    try {
      hookWarnings = installMusterdCursorHooks();
    } catch {
      /* non-fatal — MCP wiring is what matters; hooks are the observation seam */
    }
    return {
      target: path,
      activation:
        'open this folder in Cursor (or reload the window) so Cursor starts the musterd MCP server',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
      ...(hookWarnings.length > 0 ? { warnings: hookWarnings } : {}),
    };
  },

  refreshHooks: {
    applies: (dir) => existsSync(projectConfigPath(dir)) || existsSync(projectHooksPath(dir)),
    run: (dir) => {
      const warnings = installMusterdCursorHooks(dir);
      return { files: [projectHooksPath(dir)], warnings };
    },
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
    try {
      removeMusterdCursorHooks();
    } catch {
      /* best-effort */
    }
  },
};
