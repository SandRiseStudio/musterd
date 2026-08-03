import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CCD_SEND_MESSAGE_TOOL, FEATURE_EPOCH } from '@musterd/protocol';
import { hasRunnable as has, resolveClaudeBin } from '../../claudeBin.js';
import { readModelFromTranscript } from '../../session/transcript-model.js';
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
function settingsLocalPath(dir: string = process.cwd()): string {
  return join(dir, '.claude', 'settings.local.json');
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
 * - `SessionStart` capture + `SessionEnd` (ADR 131 §5, increment 4) — **project-local**. Session
 *   capture: pipe the hook's stdin JSON (`{session_id, transcript_path, cwd}` — which musterd used
 *   to discard) into `musterd session start|end --stdin`, which records it in the workspace's
 *   gitignored `binding.json` so a wake can `--resume` the seat's transcript instead of starting
 *   cold. Project-local (unlike the orientation SessionStart): capture is a per-seat-workspace
 *   fact, drift-checkable per folder, and a wake spawn runs with cwd = the workspace so the local
 *   hook fires and captures the minted session — capture is self-maintaining. Both are `>/dev/null`
 *   silent: SessionStart hook stdout is injected into model context, and capture must add zero.
 */
export const NOTIFICATION_HOOK_MARKER = 'musterd-notify-hook';
export const SESSIONSTART_HOOK_MARKER = 'musterd-sessionstart-hook';
export const PROMPTSUBMIT_HOOK_MARKER = 'musterd-promptsubmit-hook';
export const POSTTOOLUSE_HOOK_MARKER = 'musterd-interrupt-hook';
export const PRETOOLUSE_HOOK_MARKER = 'musterd-gate-hook';
export const SESSIONMSG_HOOK_MARKER = 'musterd-sessionmsg-hook';
export const SESSION_CAPTURE_HOOK_MARKER = 'musterd-session-capture-hook';
export const SESSION_END_HOOK_MARKER = 'musterd-session-end-hook';

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

function preToolUseHookCommand(): string {
  // The PreToolUse enforcement gate (ADR 150). BEFORE an Edit/Write/Bash, pipe the hook's stdin JSON
  // ({tool_name, tool_input}) through to `musterd gate check --stdin`, which matches it against the
  // team's declared enforcement class table client-side and (only on a match) adjudicates server-side.
  // Unlike the interrupt probe this HAS a matcher (Edit|Write|MultiEdit|NotebookEdit|Bash) — reads and
  // everything else never reach the gate. `cd` + `command -v` consume no stdin so the JSON flows
  // through untouched. Fail-open + never-failing: the CLI itself exits 0 on any error and the `|| true`
  // is belt-and-braces, so a gate can never break a tool call (the ADR guard metric). The common case
  // (an undeclared call) returns after one cheap loopback GET with no deny — zero friction.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd gate check --stdin 2>/dev/null || true ' +
    `# ${PRETOOLUSE_HOOK_MARKER}`
  );
}

function sessionMsgHookCommand(): string {
  // The session-messaging observer (ADR 167). Same command as the ADR 150 gate — `gate check`
  // recognizes the tool name and emits an emit-only attestation instead of matching the class table —
  // but a SEPARATE entry with its own marker and matcher, so the gate entry's meaning ("the
  // enforcement gate over write-shaped tools") stays truthful and each concern installs/uninstalls/
  // drift-checks alone. Observe-only by construction: the CLI path for this tool never emits a deny.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd gate check --stdin 2>/dev/null || true ' +
    `# ${SESSIONMSG_HOOK_MARKER}`
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
    "are not joined.'; fi; " +
    // ADR 135 freshness probe: one line when this checkout's CLI dist differs from the daemon, so a
    // stale worktree learns at minute 0 instead of after an hour of "but I merged it". Guarded (only
    // when `musterd` resolves), read-only, ≤2s, and never failing — the hook contract stays intact.
    // The label-sweep nudge rides the same guard: due-gated (silent once any seat swept in the last
    // 4h), replacing the old always-on "run the label-sessions skill" clause that agents measurably
    // skipped — the per-turn UserPromptSubmit repeat below is what actually gets it run.
    'command -v musterd >/dev/null 2>&1 && { musterd init --check-build 2>/dev/null; ' +
    'musterd session label-nudge 2>/dev/null; } || true ' +
    // ADR 168: the epoch stamp. This hook is ONE machine-wide entry, so whichever checkout runs
    // `init` last writes it for every folder — and until this stamp, an older checkout's rewrite was
    // indistinguishable from the current text. The stamp makes the generation readable, so a writer
    // can refuse to downgrade and the doctor can tell "stale hook" from "behind checkout".
    `# ${SESSIONSTART_HOOK_MARKER} ${epochTag(FEATURE_EPOCH)}`
  );
}

function promptSubmitHookCommand(): string {
  // The per-turn boundary nudge (machine-wide, self-gating like the SessionStart orientation): at
  // every prompt in a musterd folder, remind the agent of the status_update/inbox ritual, then run
  // the due-gated label-sweep nudge. The label clause is the load-bearing half: the one-shot
  // SessionStart ask was measured to fail (agents skip it under a busy first prompt — 3 days of
  // unlabeled sidebar, 2026-07-29), and a nudge that REPEATS until `musterd session resolve-labels`
  // stamps the machine-wide sweep file is the difference between "documented" and "happens".
  // Formerly a hand-pasted recipe (docs/harness-hooks.md); managed here so it drift-checks and
  // epoch-guards like every other musterd hook.
  return (
    'f="${CLAUDE_PROJECT_DIR:-.}/AGENTS.md"; test -f "$f" && grep -q musterd:start "$f" || exit 0; ' +
    "echo 'musterd: if you finished a unit of work since your last update, post a one-line " +
    'team_send status_update (flips you to working: on the roster); then team_inbox_check for ' +
    "replies.'; " +
    'command -v musterd >/dev/null 2>&1 && musterd session label-nudge 2>/dev/null || true ' +
    `# ${PROMPTSUBMIT_HOOK_MARKER} ${epochTag(FEATURE_EPOCH)}`
  );
}

/** The `eN` generation tag written into a musterd hook's marker comment (ADR 168). */
function epochTag(epoch: number): string {
  return `e${String(epoch)}`;
}

/**
 * The generation stamped on an installed hook command, or `0` for an unstamped one. Unstamped is
 * legal and means "written before ADR 168" — the oldest possible generation, never an error.
 */
export function hookEpochOf(command: string): number {
  const m = /#\s*musterd-[a-z-]+\s+e(\d+)\b/.exec(command);
  return m?.[1] ? Number(m[1]) : 0;
}

function sessionCaptureHookCommand(): string {
  // Session capture (ADR 131 §5): pipe this hook's stdin JSON through to `musterd session start`,
  // which anchors its write to the payload's cwd (never bare process.cwd() — the ADR 018 clobber).
  // The cd is belt-and-braces with that anchor; `cd`/`command -v` consume no stdin, so the JSON
  // flows through untouched. Fully silent (`>/dev/null`): SessionStart stdout lands in model
  // context, and capture must add zero tokens. Best-effort + never-failing, like every musterd hook.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session start --stdin >/dev/null 2>&1 || true ' +
    `# ${SESSION_CAPTURE_HOOK_MARKER}`
  );
}

function sessionEndHookCommand(): string {
  // The advisory end-of-session annotation (ADR 131 §5): stamps `ended_at` on the capture so the
  // local-session guard can tell "cleanly ended" from "live". SessionEnd never fires on a crash —
  // resumability never depends on this hook. Same silent/best-effort shape as the capture hook.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session end --stdin >/dev/null 2>&1 || true ' +
    `# ${SESSION_END_HOOK_MARKER}`
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

/**
 * True if a hook entry is musterd's UserPromptSubmit — by marker OR by the hand-pasted recipe's
 * signature (a `musterd:start` gate + the status_update nudge), so the auto-install absorbs the
 * recipe from docs/harness-hooks.md instead of stacking beside it.
 */
function isMusterdPromptSubmit(m: ClaudeHookMatcher): boolean {
  return m.hooks.some(
    (h) =>
      h.command.includes(PROMPTSUBMIT_HOOK_MARKER) ||
      (h.command.includes('musterd:start') && h.command.includes('status_update')),
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
 *
 * **The downgrade guard (ADR 168).** If an entry we are about to replace carries a HIGHER epoch stamp
 * than `command` does, a newer build wrote it and this one would be silently reverting it — for every
 * folder at once, when the file is the machine-wide one. So leave it alone and return a warning
 * instead. Deliberately asymmetric: the newer generation wins regardless of which checkout runs last.
 * Equal or lower epochs overwrite exactly as before, so the common path is untouched.
 *
 * Returns a warning line when it refused, else `undefined`.
 */
function upsertHook(
  path: string,
  event: string,
  matches: (m: ClaudeHookMatcher) => boolean,
  command: string,
  matcher?: string,
): string | undefined {
  const settings = readSettingsSafe(path);
  if (settings === null) return; // present but unparseable — never clobber
  settings.hooks ??= {};
  const present = (settings.hooks[event] ?? []).filter(matches);
  const installedEpoch = Math.max(
    0,
    ...present.flatMap((m) => m.hooks.map((h) => hookEpochOf(h.command))),
  );
  const ours = hookEpochOf(command);
  if (installedEpoch > ours) {
    return (
      `refused to rewrite the Claude Code ${event} hook in ${path}: it was written by a NEWER musterd ` +
      `(epoch ${String(installedEpoch)}), and this build is epoch ${String(ours)} — installing it here ` +
      'would downgrade every folder on this machine (ADR 168). The hook was left untouched. Update ' +
      'this checkout (`git pull` + `pnpm build`, or `musterd service refresh`) and re-run.'
    );
  }
  // True no-op when the exact entry is already installed: don't touch the file at all. Matters for
  // the machine-wide settings, where a per-folder refresh would otherwise rewrite (and reformat) the
  // shared file on every run even with nothing to say.
  if (
    present.length === 1 &&
    present[0]!.hooks.length === 1 &&
    present[0]!.hooks[0]!.command === command &&
    present[0]!.matcher === matcher
  ) {
    return undefined;
  }
  const existing = (settings.hooks[event] ?? []).filter((m) => !matches(m));
  existing.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
  settings.hooks[event] = existing;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return undefined;
}

/**
 * One musterd-authored **project-local** hook: everything both the installer and the doctor need to
 * know about it.
 *
 * This table is the single source for both (ADR 168). The doctor used to carry a hand-written check
 * per hook, so a hook added later was covered only when someone remembered to extend it — and a hook
 * whose *text* changed was never covered at all. Driving both off one table means a new entry is
 * installed and health-checked by the same act of adding it here.
 */
interface LocalHookSpec {
  marker: string;
  event: string;
  command: () => string;
  matcher?: string;
  /**
   * What the seat loses while this hook is missing — the drift line's "so what". Optional: a hook
   * without one is still **content**-checked, it just isn't reported when absent. Only `Notification`
   * omits it, preserving the pre-ADR-168 absence-drift set exactly; widening that set is a separate
   * question from this one, and bundling it here would have quietly changed what `init --check` says.
   */
  missing?: string;
}

const LOCAL_HOOKS: readonly LocalHookSpec[] = [
  {
    marker: NOTIFICATION_HOOK_MARKER,
    event: 'Notification',
    command: notificationHookCommand,
  },
  {
    marker: POSTTOOLUSE_HOOK_MARKER,
    event: 'PostToolUse',
    command: postToolUseHookCommand,
    missing:
      'the Claude Code PostToolUse interrupt hook is missing from .claude/settings.local.json — a busy ' +
      'agent will not see urgent steering mid-loop (ADR 088). Run `musterd init --refresh-hooks` to wire it.',
  },
  {
    marker: PRETOOLUSE_HOOK_MARKER,
    event: 'PreToolUse',
    command: preToolUseHookCommand,
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
    missing:
      'the Claude Code PreToolUse enforcement-gate hook is missing from .claude/settings.local.json — ' +
      "any enforcement class this team declares (ADR 150) won't be gated for this seat (it fails open, " +
      'so nothing breaks, but a declared block is silently a no-op here). Run `musterd init --refresh-hooks` to wire it.',
  },
  {
    marker: SESSIONMSG_HOOK_MARKER,
    event: 'PreToolUse',
    command: sessionMsgHookCommand,
    matcher: CCD_SEND_MESSAGE_TOOL,
    missing:
      'the Claude Code PreToolUse session-messaging observer hook is missing from ' +
      ".claude/settings.local.json — this seat's use of the harness's session-to-session messaging " +
      "won't be logged (ADR 167; observe-only, nothing breaks). Run `musterd init --refresh-hooks` to wire it.",
  },
  {
    marker: SESSION_CAPTURE_HOOK_MARKER,
    event: 'SessionStart',
    command: sessionCaptureHookCommand,
    missing:
      'the Claude Code SessionStart session-capture hook is missing from .claude/settings.local.json — ' +
      'wakes will run fresh-only, never resuming this seat’s transcript (ADR 131 §5). Run `musterd ' +
      'init --refresh-hooks` to wire it.',
  },
  {
    marker: SESSION_END_HOOK_MARKER,
    event: 'SessionEnd',
    command: sessionEndHookCommand,
    missing:
      'the Claude Code SessionEnd hook is missing from .claude/settings.local.json — captured sessions ' +
      'will never be marked ended, so the local-session guard leans on transcript staleness alone ' +
      '(ADR 131 §5). Run `musterd init --refresh-hooks` to wire it.',
  },
];

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
export function installMusterdHooks(dir: string = process.cwd()): string[] {
  const warnings: string[] = [];
  // Every project-local hook comes off the one table (ADR 168), so adding an entry there installs it
  // AND health-checks it. Each carries its own marker, so entries sharing an event coexist rather
  // than absorbing each other: the two PreToolUse hooks (ADR 150 gate + ADR 167 observer) and the
  // two SessionStart hooks (local capture + the global orientation below) each live side by side.
  for (const spec of LOCAL_HOOKS) {
    const warning = upsertHook(
      settingsLocalPath(dir),
      spec.event,
      (m) => isMusterdHookFor(m, spec.marker),
      spec.command(),
      spec.matcher,
    );
    if (warning) warnings.push(warning);
  }
  // The machine-wide hooks — the ones an older checkout could silently downgrade for every folder
  // at once, and so the ones carrying an epoch stamp and a refusal (ADR 168): the SessionStart
  // orientation, and the per-turn UserPromptSubmit boundary/label nudge it hands off to.
  for (const [event, matches, command] of [
    ['SessionStart', isMusterdSessionStart, sessionStartHookCommand()],
    ['UserPromptSubmit', isMusterdPromptSubmit, promptSubmitHookCommand()],
  ] as const) {
    const globalWarning = upsertHook(globalSettingsPath(), event, matches, command);
    if (globalWarning) warnings.push(globalWarning);
  }
  return warnings;
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
  const drift: string[] = [];
  const installedFor = (spec: LocalHookSpec): string | undefined =>
    (settings.hooks?.[spec.event] ?? [])
      .filter((m) => isMusterdHookFor(m, spec.marker))
      .flatMap((m) => m.hooks.map((h) => h.command))
      .find((c) => c.includes(spec.marker));
  for (const spec of LOCAL_HOOKS) {
    const installed = installedFor(spec);
    if (installed === undefined) {
      if (spec.missing) drift.push(spec.missing);
      continue;
    }
    // Present — but presence was never the question (ADR 168). A hook's value is entirely in its
    // text, so compare against what THIS build would write.
    if (installed !== spec.command()) {
      drift.push(
        `the Claude Code ${spec.event} hook \`${spec.marker}\` in .claude/settings.local.json was ` +
          'written by a different musterd build and no longer matches this one — it is present but ' +
          'STALE, which no presence check can see (ADR 168). Run `musterd init --refresh-hooks` ' +
          'here to rewrite it.',
      );
    }
  }
  drift.push(...inspectGlobalSessionStartDrift());
  return drift;
}

/**
 * Drift for the **machine-wide** orientation `SessionStart` hook (ADR 168).
 *
 * Deliberately reported from every folder: there is no machine-level surface to report it on, and one
 * true line repeated beats a missing one. The two outcomes prescribe *opposite* repairs, which is the
 * whole reason presence checking was insufficient — a stale hook wants `init` run here, a hook from a
 * newer build wants this checkout updated and `init` NOT run, because running it is what would
 * re-bake the shared slot.
 */
function inspectGlobalSessionStartDrift(): string[] {
  return [
    ...inspectGlobalHookDrift(
      'SessionStart',
      isMusterdSessionStart,
      SESSIONSTART_HOOK_MARKER,
      sessionStartHookCommand(),
      'orientation',
    ),
    ...inspectGlobalHookDrift(
      'UserPromptSubmit',
      isMusterdPromptSubmit,
      PROMPTSUBMIT_HOOK_MARKER,
      promptSubmitHookCommand(),
      'boundary/label-nudge',
    ),
  ];
}

/** One machine-wide hook's drift verdict — the SessionStart logic above, parametrized when the
 *  UserPromptSubmit nudge became the second epoch-stamped global hook. */
function inspectGlobalHookDrift(
  event: string,
  matches: (m: ClaudeHookMatcher) => boolean,
  marker: string,
  command: string,
  label: string,
): string[] {
  const settings = readSettingsSafe(globalSettingsPath());
  if (!settings) return []; // absent or unparseable — say nothing rather than invent drift
  const installed = (settings.hooks?.[event] ?? [])
    .filter(matches)
    .flatMap((m) => m.hooks.map((h) => h.command))
    .find((c) => c.includes(marker));
  if (installed === undefined) return []; // never installed here — not this check's business
  if (installed === command) return [];
  const theirs = hookEpochOf(installed);
  if (theirs > FEATURE_EPOCH) {
    return [
      `the machine-wide Claude Code ${event} ${label} hook (~/.claude/settings.json) was written ` +
        `by a NEWER musterd (epoch ${String(theirs)}) than this checkout (epoch ${String(FEATURE_EPOCH)}). ` +
        'The hook is fine — this checkout is behind. Update it (`git pull` + `pnpm build`); do NOT run ' +
        '`musterd init` here, which would downgrade the hook for every folder on this machine (ADR 168).',
    ];
  }
  return [
    `the machine-wide Claude Code ${event} ${label} hook (~/.claude/settings.json) does not match ` +
      `what this build would write (installed epoch ${String(theirs)}, this build ${String(FEATURE_EPOCH)}) ` +
      `— it is present but STALE, so every folder on this machine is running older ${label} text ` +
      '(ADR 168). Run `musterd init --refresh-hooks` to rewrite it.',
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
  dropHook(settingsLocalPath(), 'PreToolUse', (m) => isMusterdHookFor(m, PRETOOLUSE_HOOK_MARKER));
  dropHook(settingsLocalPath(), 'PreToolUse', (m) => isMusterdHookFor(m, SESSIONMSG_HOOK_MARKER));
  dropHook(settingsLocalPath(), 'SessionStart', (m) =>
    isMusterdHookFor(m, SESSIONSTART_HOOK_MARKER),
  );
  // Session capture (ADR 131 §5): both project-local, both marker-exact — the capture drop must not
  // touch the legacy pre-consolidation SessionStart above, nor any user hook.
  dropHook(settingsLocalPath(), 'SessionStart', (m) =>
    isMusterdHookFor(m, SESSION_CAPTURE_HOOK_MARKER),
  );
  dropHook(settingsLocalPath(), 'SessionEnd', (m) => isMusterdHookFor(m, SESSION_END_HOOK_MARKER));
}

// `has`/`resolveClaudeBin` moved to the shared `claudeBin.ts` (ADR 131 inc 3): the wake actuator
// (`musterd host`) needs the same PATH-robust resolution under launchd's minimal PATH.

/** Claude Code: configured through the official `claude mcp` CLI (no hand-editing JSON). */
export const claudeCode: Harness = {
  id: 'claude-code',
  label: 'Claude Code',
  surface: 'claude-code',
  // Local-scope MCP config is keyed by repo ROOT, so every worktree of one repo shares this entry.
  entryScope: 'repo-shared',
  // ADR 085: the skill lands as a native Claude Code skill; slash commands as project commands.
  guidance: {
    skillPath: '.claude/skills/musterd/SKILL.md',
    frontmatter: 'claude-code',
    commandsDir: '.claude/commands',
    // ADR 160: only Claude Code sessions can list + rename each other (the desktop app's
    // session-management tools), so only this harness carries the label-sessions skill.
    sessionsSkillPath: '.claude/skills/musterd-label-sessions/SKILL.md',
    nudgeSkillPath: '.claude/skills/musterd-nudge-relay/SKILL.md',
  },

  // Claude Code hands its hooks a `transcript_path`, and the newest assistant turn in that file
  // carries the real model id — the highest-fidelity probe of the three harnesses.
  observeModel: (payload) =>
    payload.transcript_path ? readModelFromTranscript(payload.transcript_path) : undefined,

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
    // Same read-back, for the entry fields that can now disagree with this workspace: a legacy baked
    // model, a grant from another provisioning run, and the adapter path (`  Args: <path>`).
    const modelMatch = got.ok ? /MUSTERD_MODEL=(\S+)/.exec(got.out) : null;
    const grantMatch = got.ok ? /MUSTERD_GRANT=(\S+)/.exec(got.out) : null;
    const agentKeyMatch = got.ok ? /MUSTERD_AGENT_KEY=(\S+)/.exec(got.out) : null;
    const autojoinMatch = got.ok ? /MUSTERD_AUTOJOIN=(\S+)/.exec(got.out) : null;
    const driverMatch = got.ok ? /MUSTERD_DRIVER=(\S+)/.exec(got.out) : null;
    const surfaceMatch = got.ok ? /MUSTERD_SURFACE=(\S+)/.exec(got.out) : null;
    const argsMatch = got.ok ? /^\s*Args:\s*(.+)$/m.exec(got.out) : null;
    return {
      installed: true,
      configured: got.ok,
      detail: `claude ${ver.out.trim().split(' ')[0] ?? ''}${where}`.trim(),
      ...(claimMatch ? { registeredClaim: claimMatch[1] } : {}),
      ...(modelMatch ? { registeredModel: modelMatch[1] } : {}),
      ...(grantMatch ? { registeredGrant: grantMatch[1] } : {}),
      ...(agentKeyMatch ? { registeredAgentKey: agentKeyMatch[1] } : {}),
      ...(autojoinMatch ? { registeredAutojoin: autojoinMatch[1] } : {}),
      ...(driverMatch ? { registeredDriver: driverMatch[1] } : {}),
      ...(surfaceMatch ? { registeredSurface: surfaceMatch[1] } : {}),
      ...(argsMatch?.[1] ? { registeredArgs: argsMatch[1].trim().split(/\s+/) } : {}),
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
    let hookWarnings: string[] = [];
    try {
      hookWarnings = installMusterdHooks();
    } catch {
      /* non-fatal — the server is what matters; the hooks are additive reachability/orientation aids */
    }
    return {
      target: 'claude mcp (scope: local)',
      activation: activationHint(),
      ...(hookWarnings.length > 0 ? { warnings: hookWarnings } : {}),
      scope: `wired for this repo (${process.cwd()}) — Claude Code keys local scope by repo ROOT, so every git worktree of this repo shares this one entry; it carries no per-seat state (ADR 165), so that sharing is harmless. Another project needs its own \`musterd init\`, and a second agent needs its own folder.`,
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

  // Hook-only refresh (ADR 168): rewrite the hook entries and nothing else. Safe in a live seat for
  // the same reasons --refresh-guidance is — it touches no identity and no MCP entry.
  refreshHooks: {
    // Already provisioned for Claude Code here? A refresh updates what exists; creating a first
    // install is `init`'s job. Same rule --refresh-guidance follows for a folder with no guidance.
    applies: (dir) => existsSync(settingsLocalPath(dir)),
    run: (dir) => ({
      files: [settingsLocalPath(dir), globalSettingsPath()],
      warnings: installMusterdHooks(dir),
    }),
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
