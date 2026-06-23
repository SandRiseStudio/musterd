import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Harness, ProvisionPermissions, ProvisionPlan, UnprovisionPlan } from '../harness.js';

const exec = promisify(execFile);

/**
 * Claude Code's project-local settings (gitignored by Claude Code). The per-user/local home for
 * permission defaults (ADR 027 — `-s local` keeps everything project-scoped, never the user's
 * global setup). Mirrors `claude mcp add -s local`'s scope for the permission half.
 */
interface ClaudeSettings {
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
}
function settingsLocalPath(): string {
  return join(process.cwd(), '.claude', 'settings.local.json');
}
function readSettings(path: string): ClaudeSettings {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClaudeSettings;
  } catch {
    return {};
  }
}
const PERM_LISTS = ['allow', 'ask', 'deny'] as const;

/**
 * Merge role permission defaults into `.claude/settings.local.json` additively (never a clamp —
 * ADR 026 §4 / 028). Returns only the entries *newly* added (so the manifest records exactly what to
 * remove later, never an entry the user already had). No-op lists stay untouched.
 */
function mergePermissions(perms: ProvisionPermissions): ProvisionPermissions {
  const path = settingsLocalPath();
  const settings = readSettings(path);
  settings.permissions ??= {};
  const added: ProvisionPermissions = { allow: [], ask: [], deny: [] };
  let changed = false;
  for (const list of PERM_LISTS) {
    const existing = settings.permissions[list] ?? [];
    const have = new Set(existing);
    for (const entry of perms[list]) {
      if (!have.has(entry)) {
        existing.push(entry);
        have.add(entry);
        added[list].push(entry);
        changed = true;
      }
    }
    if (existing.length > 0) settings.permissions[list] = existing;
  }
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  return added;
}

/** Remove the given permission entries from `.claude/settings.local.json` (exact reversal). */
function removePermissions(perms: ProvisionPermissions): void {
  const path = settingsLocalPath();
  if (!existsSync(path)) return;
  const settings = readSettings(path);
  if (!settings.permissions) return;
  let changed = false;
  for (const list of PERM_LISTS) {
    const drop = new Set(perms[list]);
    if (drop.size === 0) continue;
    const existing = settings.permissions[list];
    if (!existing) continue;
    const kept = existing.filter((e) => !drop.has(e));
    if (kept.length !== existing.length) {
      changed = true;
      if (kept.length > 0) settings.permissions[list] = kept;
      else delete settings.permissions[list];
    }
  }
  if (changed) writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

async function has(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8000 });
    return { ok: true, out: stdout };
    // reason: exec rejection is an untyped error-like with optional stdout/message.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    return { ok: false, out: String(err?.stdout ?? err?.message ?? '') };
  }
}

/**
 * Where the `claude` CLI commonly lives. `execFile` resolves against the *launching terminal's*
 * PATH only, so a venv/conda/non-login shell can hide an installed CLI — init then reports
 * "not installed" while the Claude Code extension runs fine (dogfood finding). Falling back to
 * these absolute paths (and using the resolved one for `configure`) makes detection PATH-robust.
 */
function claudeCandidates(): string[] {
  const home = homedir();
  return [
    join(home, '.npmglobal/bin/claude'),
    join(home, '.npm-global/bin/claude'),
    join(home, '.claude/local/claude'),
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

let claudeBinCache: string | null | undefined;
/** Resolve a runnable `claude`: PATH first, then known install locations. Cached per process. */
async function resolveClaudeBin(): Promise<string | null> {
  if (claudeBinCache !== undefined) return claudeBinCache;
  if ((await has('claude', ['--version'])).ok) return (claudeBinCache = 'claude');
  for (const c of claudeCandidates()) {
    if (existsSync(c) && (await has(c, ['--version'])).ok) return (claudeBinCache = c);
  }
  return (claudeBinCache = null);
}

/** Claude Code: configured through the official `claude mcp` CLI (no hand-editing JSON). */
export const claudeCode: Harness = {
  id: 'claude-code',
  label: 'Claude Code',
  surface: 'claude-code',

  async detect() {
    const bin = await resolveClaudeBin();
    if (!bin) {
      return {
        installed: false,
        configured: false,
        detail: 'claude CLI not found on PATH or common install locations',
      };
    }
    const ver = await has(bin, ['--version']);
    const got = await has(bin, ['mcp', 'get', 'musterd']);
    const where = bin === 'claude' ? '' : ` (${bin})`;
    return {
      installed: true,
      configured: got.ok,
      detail: `claude ${ver.out.trim().split(' ')[0] ?? ''}${where}`.trim(),
    };
  },

  async configure(entry) {
    // claude mcp add musterd -s local -e K=V ... -- <command> <args...>
    const bin = (await resolveClaudeBin()) ?? 'claude';
    const envArgs = Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const args = [
      'mcp',
      'add',
      'musterd',
      '-s',
      'local',
      ...envArgs,
      '--',
      entry.command,
      ...entry.args,
    ];
    // Replace any prior definition so re-running init is idempotent.
    await exec(bin, ['mcp', 'remove', 'musterd', '-s', 'local']).catch(() => undefined);
    await exec(bin, args, { timeout: 10000 });
    return {
      target: 'claude mcp (scope: local)',
      activation: activationHint(),
      scope: `wired into this folder only (${process.cwd()}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
    };
  },

  // Provision a role's MCP servers + permission defaults (ADR 026 Universe-2). Each server is
  // `claude mcp add <name> -s local`, additive and per-user/local (ADR 027). Per-server idempotency:
  // remove+re-add *only that name*, never touching the user's other servers. `${ENV}` secrets are
  // passed through verbatim: execFile runs no shell, so the literal `${VAR}` string lands in the
  // config as a *reference* — Claude Code expands `${VAR}` / `${VAR:-default}` from the environment
  // at server-launch time (never resolved/baked by musterd). Permissions merge into
  // `.claude/settings.local.json` additively (not a clamp). Tokens are never logged — only names.
  async provision(plan: ProvisionPlan) {
    const bin = (await resolveClaudeBin()) ?? 'claude';
    const servers: string[] = [];
    for (const s of plan.servers) {
      const envArgs = Object.entries(s.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const args = ['mcp', 'add', s.name, '-s', 'local', ...envArgs, '--', s.command, ...s.args];
      // Per-server idempotency: re-running replaces only this server's prior definition.
      await exec(bin, ['mcp', 'remove', s.name, '-s', 'local']).catch(() => undefined);
      await exec(bin, args, { timeout: 10000 });
      servers.push(s.name);
    }
    const permissions = mergePermissions(plan.permissions);
    return {
      servers,
      permissions,
      target: 'claude mcp (scope: local)',
      activation: activationHint(),
    };
  },

  // Reverse a provision (ADR 027): remove exactly the named servers and the listed permissions.
  async unprovision(plan: UnprovisionPlan) {
    const bin = (await resolveClaudeBin()) ?? 'claude';
    for (const name of plan.servers) {
      await exec(bin, ['mcp', 'remove', name, '-s', 'local']).catch(() => undefined);
    }
    removePermissions(plan.permissions);
  },
};

/**
 * The MCP server is registered at Claude Code's project-local scope (keyed by this
 * folder). Both the terminal CLI and the Claude Code editor extension read it — they
 * just need this folder open. Lead with whichever path fits where init is running.
 */
function activationHint(): string {
  const inEditor = process.env['TERM_PROGRAM'] === 'vscode' || Boolean(process.env['VSCODE_PID']);
  const ext =
    'in the Claude Code extension, open this folder and start a new chat (reload the window if it was already open)';
  const term = 'in a terminal here, run `claude`';
  const lead = inEditor ? `${ext}; or ${term}` : `${term}; or ${ext}`;
  return `${lead} — then verify the musterd tools are present with /mcp inside the session`;
}
