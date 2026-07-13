import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { hasRunnable as has, resolveClaudeBin } from '../../claudeBin.js';
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
 * The Claude Code hooks musterd installs. Each carries a trailing marker comment in its command so it
 * is exactly identifiable for idempotent re-install and precise removal, never touching the user's own
 * hooks. They live at two scopes on purpose:
 *
 * - `Notification` (ADR 053) — **project-local** (`.claude/settings.local.json`). It's about *this*
 *   folder's blocked-approval moment: it fires when the agent parks awaiting input and prints the
 *   directed acts waiting for this folder's bound seat into the terminal the human is already at.
 * - `SessionStart` (ADR 060) — **global + self-gating** (`~/.claude/settings.json`). One hook covers
 *   *every* folder but its first act is `grep -q musterd:start AGENTS.md || exit 0`, so it's silent
 *   outside musterd folders. That self-gate is what lets it cover a **fresh clone/worktree never
 *   provisioned here**: the committed primer is present but the MCP server isn't, so it runs
 *   `claude mcp get musterd` and prints the fix (`musterd init`) instead of a false "auto-joined".
 *   A project-local SessionStart could only cover folders `configure` already ran in — and would
 *   double-fire against the global one — so SessionStart is global-only.
 * - `PostToolUse` (ADR 088) — **project-local** (`.claude/settings.local.json`). The interrupt line:
 *   it fires at *every tool boundary*, running `musterd inbox --interrupt-check` — a silent no-op
 *   unless an interrupt-class (urgent) directed act is waiting for this folder's bound seat, in which
 *   case it prints one daemon-composed line the model sees mid-turn. This is what makes a busy agent
 *   reachable in seconds instead of at its next task boundary; it degrades to the ADR 046 per-command
 *   nudge where a harness lacks a tool-boundary hook.
 */
export const NOTIFICATION_HOOK_MARKER = 'musterd-notify-hook';
export const SESSIONSTART_HOOK_MARKER = 'musterd-sessionstart-hook';
export const POSTTOOLUSE_HOOK_MARKER = 'musterd-interrupt-hook';

/** The user's GLOBAL Claude Code settings (read at session start for all folders). Honors
 *  `CLAUDE_CONFIG_DIR` (which Claude Code itself respects) so the config home is overridable + testable. */
function globalSettingsPath(): string {
  const base = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
  return join(base, 'settings.json');
}

function notificationHookCommand(): string {
  // Best-effort, never failing the approval it rides on: cd to the project dir so the bound seat
  // resolves, run `musterd nudge` only if the CLI is on PATH, swallow all output-noise on error.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd nudge 2>/dev/null || true ' +
    `# ${NOTIFICATION_HOOK_MARKER}`
  );
}

function postToolUseHookCommand(): string {
  // The mid-loop interrupt line (ADR 088): after every tool call, cd to the project dir so the bound
  // seat resolves, run `musterd inbox --interrupt-check` only if the CLI is on PATH. It exits silent
  // (no output) unless an interrupt-class act is waiting, so the common path adds zero context and
  // zero tokens. Best-effort + never-failing: swallow all noise on error so a probe can't break a tool
  // call. No matcher, so it runs on every tool. Mirrors the Notification hook's shape.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd inbox --interrupt-check 2>/dev/null || true ' +
    `# ${POSTTOOLUSE_HOOK_MARKER}`
  );
}

function sessionStartHookCommand(): string {
  // Global self-gating verify-then-orient (ADR 060): exit silently unless this folder carries the
  // committed `musterd:start` primer; else cd in, and if `claude` is on PATH and `mcp get musterd`
  // fails, the server isn't wired here → print the fix; otherwise print the orientation. The
  // `command -v claude` guard avoids crying wolf when it can't verify. When the server is missing, the
  // fix depends on whether the repo carries a committed launch spec (`.musterd/workspace.json`): if it
  // does, this is a fresh clone that can **self-wire** headlessly → point at `musterd wire` (no
  // prompts, no seat claim); otherwise point at the interactive `musterd init`. The hook itself never
  // runs a mutating command — it only tells the agent what to run, then to reload (registering an MCP
  // server doesn't make it live until reload).
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; test -f "$d/AGENTS.md" && grep -q musterd:start "$d/AGENTS.md" || exit 0; ' +
    'cd "$d" 2>/dev/null; ' +
    'if command -v claude >/dev/null 2>&1 && ! claude mcp get musterd >/dev/null 2>&1; then ' +
    'if [ -f "$d/.musterd/workspace.json" ]; then ' +
    "echo 'musterd: this repo has a committed musterd launch spec but the MCP server is NOT " +
    'registered on this machine — run `musterd wire` in this folder (no prompts), then reload this ' +
    "session to pick up the team_* tools.'; else " +
    "echo 'musterd: this folder has the musterd:start primer but the musterd MCP server is NOT " +
    'registered here — the team_* tools are unavailable. Run `musterd init` in this folder (or ' +
    "`musterd init --check` to confirm), then reload this session.'; fi; else " +
    "echo 'You are on a musterd team (your seat auto-claims on your first team_* tool call). Run " +
    'team_inbox_check now to join and see anything waiting. Only call team_join if a tool says you ' +
    "are not joined.'; fi " +
    `# ${SESSIONSTART_HOOK_MARKER}`
  );
}

/** True if a hook entry carries the given marker in its command. */
function isMusterdHookFor(m: ClaudeHookMatcher, marker: string): boolean {
  return m.hooks.some((h) => h.command.includes(marker));
}

/**
 * True if a hook entry is musterd's SessionStart — by our marker OR by the hand-pasted recipe's
 * signature (a `musterd:start` gate + a `team_inbox_check` orient). Matching the signature lets the
 * auto-install **absorb** a manually-pasted global recipe instead of stacking a second hook beside it.
 */
function isMusterdSessionStart(m: ClaudeHookMatcher): boolean {
  return m.hooks.some(
    (h) =>
      h.command.includes(SESSIONSTART_HOOK_MARKER) ||
      (h.command.includes('musterd:start') && h.command.includes('team_inbox_check')),
  );
}

/** Read Claude settings from `path`: `{}` if absent, or `null` if present-but-unparseable — so a
 *  caller never overwrites a real config (e.g. the user's global settings.json) it couldn't parse. */
function readSettingsSafe(path: string): ClaudeSettings | null {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClaudeSettings;
  } catch {
    return null;
  }
}

/**
 * Install/replace musterd's hook entry for `event` in the settings file at `path`, idempotently: drop
 * every entry `matches` selects (our prior install and/or an absorbed recipe) and append `command`,
 * leaving all other hooks untouched. Best-effort + non-clobbering: silently skips if the file exists
 * but won't parse. Preserves every other key in the settings object.
 */
function upsertHook(
  path: string,
  event: string,
  matches: (m: ClaudeHookMatcher) => boolean,
  command: string,
): void {
  const settings = readSettingsSafe(path);
  if (settings === null) return; // present but unparseable — never clobber
  settings.hooks ??= {};
  const existing = (settings.hooks[event] ?? []).filter((m) => !matches(m));
  existing.push({ hooks: [{ type: 'command', command }] });
  settings.hooks[event] = existing;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/** Remove musterd's hook entry for `event` from the settings file at `path` (exact, non-clobbering). */
function dropHook(path: string, event: string, matches: (m: ClaudeHookMatcher) => boolean): void {
  const settings = readSettingsSafe(path);
  if (!settings) return; // absent (nothing to do) or unparseable (never clobber)
  const list = settings.hooks?.[event];
  if (!list) return;
  const kept = list.filter((m) => !matches(m));
  if (kept.length === list.length) return; // nothing of ours
  if (kept.length > 0) settings.hooks![event] = kept;
  else delete settings.hooks![event];
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/**
 * Install musterd's Claude Code hooks: the project-local `Notification` hook, and the global
 * self-gating `SessionStart` verify hook (absorbing any hand-pasted recipe). Best-effort per hook.
 */
export function installMusterdHooks(): void {
  upsertHook(
    settingsLocalPath(),
    'Notification',
    (m) => isMusterdHookFor(m, NOTIFICATION_HOOK_MARKER),
    notificationHookCommand(),
  );
  upsertHook(
    settingsLocalPath(),
    'PostToolUse',
    (m) => isMusterdHookFor(m, POSTTOOLUSE_HOOK_MARKER),
    postToolUseHookCommand(),
  );
  upsertHook(
    globalSettingsPath(),
    'SessionStart',
    isMusterdSessionStart,
    sessionStartHookCommand(),
  );
}

/**
 * Drift lines for musterd's **project-local** Claude Code hooks that should be present once the server
 * is wired here but aren't — a `musterd init --check` guard so a renamed flag or a hand-deleted entry
 * can't silently kill reachability (ADR 088). The reachability-critical one is `PostToolUse` (the
 * interrupt line): without it, a busy agent won't see urgent steering mid-loop. Returns [] when the
 * settings file is absent/unparseable (the "no server registered" drift already covers a bare folder)
 * or when the hook is present. The global self-gating SessionStart is machine-shared, so it is not
 * checked per-folder.
 */
export function inspectClaudeHookDrift(cwd: string): string[] {
  const path = join(cwd, '.claude', 'settings.local.json');
  if (!existsSync(path)) return []; // no local settings yet — the bare-folder drift already covers it
  const settings = readSettingsSafe(path);
  if (!settings) return []; // present but unparseable — never invent drift from a file we can't read
  const present = (settings.hooks?.['PostToolUse'] ?? []).some((m) =>
    isMusterdHookFor(m, POSTTOOLUSE_HOOK_MARKER),
  );
  if (present) return [];
  return [
    'the Claude Code PostToolUse interrupt hook is missing from .claude/settings.local.json — a busy ' +
      'agent will not see urgent steering mid-loop (ADR 088). Run `musterd init` to wire it.',
  ];
}

/**
 * Remove musterd's Claude Code hooks. Reverses the project-local `Notification` hook, plus any
 * project-local `SessionStart` left by a pre-consolidation install. The **global** SessionStart hook
 * is machine-shared across all musterd folders and self-gates to silence once a folder's primer is
 * gone, so uninstalling one folder does NOT remove it (manage it via Claude Code's `/hooks`).
 */
export function removeMusterdHooks(): void {
  dropHook(settingsLocalPath(), 'Notification', (m) =>
    isMusterdHookFor(m, NOTIFICATION_HOOK_MARKER),
  );
  dropHook(settingsLocalPath(), 'PostToolUse', (m) => isMusterdHookFor(m, POSTTOOLUSE_HOOK_MARKER));
  dropHook(settingsLocalPath(), 'SessionStart', (m) =>
    isMusterdHookFor(m, SESSIONSTART_HOOK_MARKER),
  );
}

// `has`/`resolveClaudeBin` moved to the shared `claudeBin.ts` (ADR 131 inc 3): the wake actuator
// (`musterd host`) needs the same PATH-robust resolution under launchd's minimal PATH.

/** Claude Code: configured through the official `claude mcp` CLI (no hand-editing JSON). */
export const claudeCode: Harness = {
  id: 'claude-code',
  label: 'Claude Code',
  surface: 'claude-code',
  // ADR 085: the skill lands as a native Claude Code skill; slash commands as project commands.
  guidance: {
    skillPath: '.claude/skills/musterd/SKILL.md',
    frontmatter: 'claude-code',
    commandsDir: '.claude/commands',
  },

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
    // Read back a legacy baked `MUSTERD_CLAIM` (older provisioning materialized it) so the doctor can
    // catch it drifting from binding.json. `claude mcp get` prints env as `    MUSTERD_CLAIM=<value>`.
    const claimMatch = got.ok ? /MUSTERD_CLAIM=(\S+)/.exec(got.out) : null;
    return {
      installed: true,
      configured: got.ok,
      detail: `claude ${ver.out.trim().split(' ')[0] ?? ''}${where}`.trim(),
      ...(claimMatch ? { registeredClaim: claimMatch[1] } : {}),
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
