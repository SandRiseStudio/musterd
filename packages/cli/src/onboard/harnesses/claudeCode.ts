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
interface ClaudeHookCommand {
  type: 'command';
  command: string;
}
interface ClaudeHookMatcher {
  matcher?: string;
  hooks: ClaudeHookCommand[];
}
interface ClaudeSettings {
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  hooks?: Record<string, ClaudeHookMatcher[]>;
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

/**
 * The Claude Code hooks musterd installs into `.claude/settings.local.json`. Each carries a trailing
 * marker comment in its command so it is exactly identifiable for idempotent re-install and precise
 * removal (`musterd uninstall`), never touching the user's own hooks.
 *
 * - `Notification` (ADR 053): fires when the agent parks awaiting input/approval — the one moment a
 *   frozen single-threaded loop can't run its own inbox check — and prints the directed acts waiting
 *   for this folder's bound seat into the terminal the human is already at.
 * - `SessionStart` (ADR 060): fires at session launch and **verifies before it orients** — it runs
 *   `claude mcp get musterd` and, if the server isn't registered for this folder, prints the fix
 *   (`musterd init`) instead of a false "you're auto-joined"; otherwise it tells the agent to check
 *   its inbox. Auto-installing it here (was a manual `~/.claude/settings.json` recipe) means every
 *   provisioned folder self-reports drift + orients on launch. NOTE: because it lives in this folder's
 *   local settings, it only covers folders `configure` has run in — it catches a *provisioned* folder
 *   whose server later went missing, not a fresh clone/worktree that was never provisioned here (that
 *   still needs the global self-gating recipe in docs/harness-hooks.md).
 */
export const NOTIFICATION_HOOK_MARKER = 'musterd-notify-hook';
export const SESSIONSTART_HOOK_MARKER = 'musterd-sessionstart-hook';

function notificationHookCommand(): string {
  // Best-effort, never failing the approval it rides on: cd to the project dir so the bound seat
  // resolves, run `musterd nudge` only if the CLI is on PATH, swallow all output-noise on error.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd nudge 2>/dev/null || true ' +
    `# ${NOTIFICATION_HOOK_MARKER}`
  );
}

function sessionStartHookCommand(): string {
  // Verify-then-orient (ADR 060): cd to the project dir so the `-s local` (cwd-keyed) lookup resolves;
  // if `claude` is on PATH and `mcp get musterd` fails, the server isn't wired here → print the fix;
  // else print the orientation. The `command -v claude` guard avoids crying wolf when it can't verify.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'if command -v claude >/dev/null 2>&1 && ! claude mcp get musterd >/dev/null 2>&1; then ' +
    "echo 'musterd: this folder is set up for a musterd team but the musterd MCP server is NOT " +
    'registered here — the team_* tools are unavailable. Run `musterd init` in this folder (or ' +
    "`musterd init --check` to confirm), then reload this session.'; else " +
    "echo 'You are on a musterd team (auto-joined on launch). Run team_inbox_check now to see " +
    "anything waiting. Only call team_join if a tool says you are not joined.'; fi " +
    `# ${SESSIONSTART_HOOK_MARKER}`
  );
}

/** True if a hook entry is one musterd installed under this marker (carries it in its command). */
function isMusterdHookFor(m: ClaudeHookMatcher, marker: string): boolean {
  return m.hooks.some((h) => h.command.includes(marker));
}

/**
 * Install a marker-tagged musterd hook for `event` into `.claude/settings.local.json`, idempotently
 * and additively: drop any prior entry carrying the same marker (re-install replaces in place) and
 * append the current one, leaving the user's own hooks — and musterd's *other* hook — untouched.
 */
function installHook(event: string, marker: string, command: string): void {
  const path = settingsLocalPath();
  const settings = readSettings(path);
  settings.hooks ??= {};
  const existing = (settings.hooks[event] ?? []).filter((m) => !isMusterdHookFor(m, marker));
  existing.push({ hooks: [{ type: 'command', command }] });
  settings.hooks[event] = existing;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/** Remove a marker-tagged musterd hook for `event` from `.claude/settings.local.json` (exact reversal). */
function removeHook(event: string, marker: string): void {
  const path = settingsLocalPath();
  if (!existsSync(path)) return;
  const settings = readSettings(path);
  const list = settings.hooks?.[event];
  if (!list) return;
  const kept = list.filter((m) => !isMusterdHookFor(m, marker));
  if (kept.length === list.length) return; // nothing of ours
  if (kept.length > 0) settings.hooks![event] = kept;
  else delete settings.hooks![event];
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/** Install both musterd Claude Code hooks (Notification + SessionStart) into this folder's settings. */
export function installMusterdHooks(): void {
  installHook('Notification', NOTIFICATION_HOOK_MARKER, notificationHookCommand());
  installHook('SessionStart', SESSIONSTART_HOOK_MARKER, sessionStartHookCommand());
}

/** Remove both musterd Claude Code hooks (exact reversal, marker-matched). */
export function removeMusterdHooks(): void {
  removeHook('Notification', NOTIFICATION_HOOK_MARKER);
  removeHook('SessionStart', SESSIONSTART_HOOK_MARKER);
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
    // Install the musterd hooks alongside the server (best-effort — a hook-write hiccup never fails
    // wiring the server): the ADR 053 Notification hook (a blocked agent's inbox reaches it) and the
    // ADR 060 SessionStart hook (verify-before-orient: a provisioned folder whose server later went
    // missing self-reports the drift instead of claiming a false "auto-joined").
    try {
      installMusterdHooks();
    } catch {
      /* non-fatal — the server is what matters; the hooks are additive reachability/orientation aids */
    }
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

  // Reverse a provision (ADR 027): remove exactly the named servers, permissions, and musterd's
  // hooks (Notification + SessionStart) — marker-matched, so the user's own hooks are kept.
  async unprovision(plan: UnprovisionPlan) {
    const bin = (await resolveClaudeBin()) ?? 'claude';
    for (const name of plan.servers) {
      await exec(bin, ['mcp', 'remove', name, '-s', 'local']).catch(() => undefined);
    }
    removePermissions(plan.permissions);
    removeMusterdHooks();
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
