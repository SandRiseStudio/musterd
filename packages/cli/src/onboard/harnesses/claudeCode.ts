import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CCD_SEND_MESSAGE_TOOL, FEATURE_EPOCH } from '@musterd/protocol';
import { hasRunnable as has, resolveClaudeBin } from '../../claudeBin.js';
import { readModelFromTranscript } from '../../session/transcript-model.js';
import { isDeclined } from '../declined.js';
import { primaryCheckoutFor } from '../entryGuard.js';
import { applyFileMap, guidanceFileMap, observeFileMap } from '../guidance.js';
import type { Harness, ProvisionPermissions, ProvisionPlan, UnprovisionPlan } from '../harness.js';
import { loadProvisioning } from '../manifest.js';
import {
  launchEntryEnv,
  markerGenerationOfEnv,
  resolveMcpLaunch,
  RETIRED_SURFACE_ENV,
} from '../mcpEntry.js';
import { STANDARD_FLOOR } from '../permissions.js';
import { roleBridgesFor } from '../roleSkills.js';
import { nodeExec, type ExecSeam, type FsSeam, type HarnessContext } from '../reconcile/context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  machineResourceKey,
  repoSharedResourceKey,
  type HarnessAdapter,
} from '../reconcile/fragments.js';
import { BUILTIN_TOOLKITS, parseToolkit, toolkitHomes, type Toolkit } from '../toolkit.js';

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
  /** The seat chip's slot (see {@link installMusterdStatusline}) — one per settings file. */
  statusLine?: { type?: string; command?: string };
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
 *   hook fires and captures the minted session — capture is self-maintaining. SessionEnd stays
 *   `>/dev/null` silent; the capture hook lets stdout through, because SessionStart hook stdout is
 *   injected into model context and that seam now carries the orientation block (spec 2026-08-25):
 *   capture itself still adds zero — the orientation is the one deliberate, bounded emission.
 */
export const NOTIFICATION_HOOK_MARKER = 'musterd-notify-hook';
export const SESSIONSTART_HOOK_MARKER = 'musterd-sessionstart-hook';
export const PROMPTSUBMIT_HOOK_MARKER = 'musterd-promptsubmit-hook';
export const POSTTOOLUSE_HOOK_MARKER = 'musterd-interrupt-hook';
export const PRETOOLUSE_HOOK_MARKER = 'musterd-gate-hook';
export const SESSIONMSG_HOOK_MARKER = 'musterd-sessionmsg-hook';
export const SESSION_CAPTURE_HOOK_MARKER = 'musterd-session-capture-hook';
export const SESSION_END_HOOK_MARKER = 'musterd-session-end-hook';
export const STATUSLINE_MARKER = 'musterd-statusline';

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

/**
 * The model-readable nudge texts, budgeted by the standing-context gate (spec 2026-08-03,
 * `pnpm context:check`). Each is embedded verbatim in exactly one `echo` in the hook commands
 * below — the hooks test pins the embedding, so a reword here is a reword on the wire.
 */
export const HOOK_NUDGE_TEXTS = {
  // Trimmed to a trigger (standing-context spec 2026-08-03): the autojoin rule and the team_join
  // caveat now live in the primer's loop, which is committed and always present. This nudge only
  // has to fire the action at session start.
  orientation_joined:
    'musterd: run team_inbox_check now — it joins your seat and shows what waits.',
  orientation_wire_fix:
    'musterd: this repo has a committed musterd launch spec but the MCP server is NOT ' +
    'registered on this machine — run `musterd wire` in this folder (no prompts), then reload this ' +
    'session to pick up the team_* tools.',
  orientation_init_fix:
    'musterd: this folder has the musterd:start primer but the musterd MCP server is NOT ' +
    'registered here — the team_* tools are unavailable. Run `musterd init` in this folder (or ' +
    '`musterd init --check` to confirm), then reload this session.',
  // Paid every turn — the tightest text that still fires both halves of the ritual. What a
  // status_update buys (the roster flip) is primer material, not per-turn material.
  prompt_submit_ritual:
    'musterd: finished a unit of work? team_send status_update (one line), then team_inbox_check.',
} as const;

/**
 * The shell clause that lets a MACHINE-WIDE hook honour a per-folder refusal (ADR 332).
 *
 * The two hooks below live in one global `settings.json` and fire in every folder, so `decline`
 * cannot enforce itself by removal the way it does for a project-local surface — and a tombstone
 * whose surface keeps firing is the lie decision (5) forbids. Suppression is the enforcement
 * instead, and it belongs in the hook because the hook is the only thing that runs per folder.
 *
 * A grep, not a `musterd` call: this is on the per-turn path, so it must not spawn a CLI process,
 * and it must work before `musterd` is on PATH. FAILS OPEN by construction — a missing, unreadable
 * or malformed `declined.json` makes grep exit non-zero and the hook proceeds, which is the same
 * bias `readDeclined` takes: never invent a refusal.
 */
function declinedGate(surface: string): string {
  return `grep -q '"${surface}"' "$d/.musterd/declined.json" 2>/dev/null && exit 0; `;
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
    declinedGate(SURFACE_MACHINE_SESSION_START) +
    'cd "$d" 2>/dev/null; ' +
    'if command -v claude >/dev/null 2>&1 && ! claude mcp get musterd >/dev/null 2>&1; then ' +
    'if [ -f "$d/.musterd/workspace.json" ]; then ' +
    `echo '${HOOK_NUDGE_TEXTS.orientation_wire_fix}'; else ` +
    `echo '${HOOK_NUDGE_TEXTS.orientation_init_fix}'; fi; else ` +
    `echo '${HOOK_NUDGE_TEXTS.orientation_joined}'; fi; ` +
    // ADR 135 freshness probe: one line when this checkout's CLI dist differs from the daemon, so a
    // stale worktree learns at minute 0 instead of after an hour of "but I merged it". Guarded (only
    // when `musterd` resolves), read-only, ≤2s, and never failing — the hook contract stays intact.
    // The label-sweep nudge rides the same guard: due-gated (silent once any seat swept in the last
    // 4h), replacing the old always-on "run the label-sessions skill" clause that agents measurably
    // skipped — the per-turn UserPromptSubmit repeat below is what actually gets it run.
    // The orient nudge rides here too (session-orientation spec 2026-08-25 §B): due-gated per
    // session (quiet once `musterd session orient-stamp` names the captured session), so a seat
    // session that starts un-oriented is told to run the musterd-orient skill from minute 0.
    'command -v musterd >/dev/null 2>&1 && { musterd init --check-build 2>/dev/null; ' +
    'musterd session label-nudge 2>/dev/null; musterd session orient-nudge 2>/dev/null; } || true ' +
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
    'd="${CLAUDE_PROJECT_DIR:-.}"; test -f "$d/AGENTS.md" && grep -q musterd:start "$d/AGENTS.md" || exit 0; ' +
    declinedGate(SURFACE_MACHINE_PROMPT_SUBMIT) +
    `echo '${HOOK_NUDGE_TEXTS.prompt_submit_ritual}'; ` +
    // orient-nudge repeats per turn on the same measured grounds as the label clause above —
    // one-shot session-start asks get skipped; a repeat that a stamp quiets actually lands.
    'command -v musterd >/dev/null 2>&1 && { musterd session label-nudge 2>/dev/null; ' +
    'musterd session orient-nudge 2>/dev/null; } || true ' +
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
  // flows through untouched. Stdout is deliberately NOT redirected: SessionStart hook stdout lands
  // in model context, and `session start` uses exactly that seam for the orientation block
  // (spec 2026-08-25-session-orientation-design.md §A) — capture itself still prints zero tokens,
  // and the orientation is bounded, wake-suppressed, and silent on any failure. Stderr stays
  // silenced; best-effort + never-failing, like every musterd hook.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session start --stdin 2>/dev/null || true ' +
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
  // The seat chip rides the same install: it is the human-facing half of what the SessionStart
  // orientation above does for the agent, and shipping one without the other is what left the
  // terminal blank in the first place.
  const statuslineWarning = installMusterdStatusline(dir);
  if (statuslineWarning) warnings.push(statuslineWarning);
  return warnings;
}

/**
 * The seat statusline chip (`musterd session statusline`) — the user-facing half of the session
 * orientation, and the reason it exists is worth stating where the wiring lives:
 *
 * ADR 326 put the orientation block on `SessionStart` and promised it would greet the human on
 * open. It cannot. That event has no user-facing seam at exit 0 — its stdout and `additionalContext`
 * both land in MODEL context, and `systemMessage`, the field that surfaces a line to the human
 * everywhere else, is explicitly discarded for it. The block was always addressed to the agent; the
 * statusline is the seam for the other reader, visible with zero typing and persistent for the
 * session. See `commands/sessionStatusline.ts` for the spec quote.
 *
 * PROJECT-LOCAL, unlike the machine-wide SessionStart hooks: a chip names ONE seat, so a shared
 * machine-level slot would stamp this seat's name onto every terminal on the laptop.
 */
function statuslineCommandText(): string {
  // Same self-gating, never-failing shape as the hooks: no musterd on PATH, no binding, or a dead
  // daemon all end as silence. A statusline that prints an error sits there all session printing it.
  return (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session statusline --stdin 2>/dev/null || true ' +
    `# ${STATUSLINE_MARKER}`
  );
}

/** True if a statusLine slot is one musterd wrote (vs. the user's own). */
function isMusterdStatusline(s: ClaudeSettings): boolean {
  return s.statusLine?.command?.includes(STATUSLINE_MARKER) === true;
}

/**
 * Install the seat chip into `.claude/settings.local.json`.
 *
 * Returns a warning string (and writes NOTHING) when the slot already holds a statusline that is
 * not ours. There is exactly one `statusLine` per settings file, so installing over a foreign one
 * is an unrecoverable overwrite of something the user chose — the asymmetry with hooks, which
 * coexist as a list, is deliberate. A warning is the whole remedy.
 */
export function installMusterdStatusline(dir: string = process.cwd()): string | undefined {
  const path = settingsLocalPath(dir);
  const settings = readSettingsSafe(path);
  if (!settings) return undefined; // unparseable — never rewrite a file we cannot read
  if (settings.statusLine && !isMusterdStatusline(settings)) {
    return (
      `.claude/settings.local.json already has a \`statusLine\` that musterd did not write, so the ` +
      `seat chip was NOT installed (it would have overwritten your own). To use it, replace that ` +
      `command with: ${statuslineCommandText()}`
    );
  }
  settings.statusLine = { type: 'command', command: statuslineCommandText() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return undefined;
}

/** Remove the seat chip — ours only; a foreign statusline is left exactly as it was. */
export function removeMusterdStatusline(dir: string = process.cwd()): void {
  const path = settingsLocalPath(dir);
  const settings = readSettingsSafe(path);
  if (!settings || !isMusterdStatusline(settings)) return;
  delete settings.statusLine;
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/**
 * Drift for the seat chip, on the same ADR 168 terms as the hooks: presence was never the question,
 * because a slot written by an older build is present and wrong. Silent about a FOREIGN statusline —
 * that is the user's choice, and reporting a choice as drift trains people to ignore drift.
 */
/**
 * The refusable surfaces this harness owns, named `<harness>:<slot>` (ADR 332). The harness prefix
 * is load-bearing: `statusLine` and `PostToolUse` are unique only inside one harness, and a folder
 * can be provisioned for several. Exported so the `surface` command offers real names rather than
 * asking the user to guess a string that only these inspectors would ever match.
 */
export const CLAUDE_SURFACE_PREFIX = 'claude-code';
export const SURFACE_STATUSLINE = `${CLAUDE_SURFACE_PREFIX}:statusLine`;

/**
 * The two MACHINE-WIDE hooks, named apart from their project-local namesakes (ryder's round-2
 * REQUIRED on #1089). `claude-code:SessionStart` used to mean both the local session-capture hook
 * and the global orientation hook, which share that event name across two different files — so
 * declining it removed the local half and left the global one firing under a tombstone that said
 * otherwise. One name cannot answer for two surfaces with two lifetimes; these get their own.
 *
 * They are refusable but not REMOVABLE: one entry serves every folder on the machine, so deleting
 * it to satisfy one folder would silently de-provision all the others. `declinedGate` is how the
 * refusal is honoured instead.
 */
export const SURFACE_MACHINE_SESSION_START = `${CLAUDE_SURFACE_PREFIX}:machine:SessionStart`;
export const SURFACE_MACHINE_PROMPT_SUBMIT = `${CLAUDE_SURFACE_PREFIX}:machine:UserPromptSubmit`;
const MACHINE_SURFACES = [SURFACE_MACHINE_SESSION_START, SURFACE_MACHINE_PROMPT_SUBMIT];

/** The surface name for one of this harness's project-local hooks. */
export function surfaceName(event: string): string {
  return `${CLAUDE_SURFACE_PREFIX}:${event}`;
}

/**
 * Every surface a user may refuse here, for `musterd surface list`.
 *
 * De-duplicated because a surface is a SLOT, not an entry: two of our `LOCAL_HOOKS` share the
 * `PreToolUse` event (the ADR 150 lane gate and the ADR 167 session-message observer), and listing
 * `claude-code:PreToolUse` twice would offer a name whose two rows a user cannot tell apart or
 * address separately. Declining that one name removes both, which is what `removeClaudeSurface`
 * does — the slot is the unit the user can actually refuse.
 */
export function claudeRefusableSurfaces(): string[] {
  return [
    ...new Set([
      SURFACE_STATUSLINE,
      ...LOCAL_HOOKS.map((s) => surfaceName(s.event)),
      ...MACHINE_SURFACES,
    ]),
  ];
}

/** How a refusal of `name` is enforced — see `removeClaudeSurface`. */
export type SurfaceRefusal = 'removed' | 'suppressed' | 'unknown';

/**
 * Remove a refusable surface by name — the other half of ADR 332's `decline`, which promises "one
 * command, one outcome". Returns false for a name this harness does not own, so the caller can
 * refuse to record a tombstone for it.
 *
 * A tombstone that claims a refusal while the surface sits installed and firing is exactly the lie
 * the ADR forbids, and that is what shipped: `decline` removed only the statusline while accepting
 * all six hook names. Every surface `claudeRefusableSurfaces()` offers is removable here.
 */
export function removeClaudeSurface(dir: string, name: string): SurfaceRefusal {
  if (name === SURFACE_STATUSLINE) {
    removeMusterdStatusline(dir);
    return 'removed';
  }
  // A machine-wide hook cannot be removed for ONE folder — its single entry serves every folder on
  // the machine, so deleting it here would de-provision all of them. The refusal is real and is
  // enforced at fire time by `declinedGate`, which reads this folder's tombstone. Saying
  // 'suppressed' rather than 'removed' keeps the caller's message honest about which happened.
  if (MACHINE_SURFACES.includes(name)) return 'suppressed';
  // The slot is the unit: drop every musterd entry under this event, which is both PreToolUse hooks
  // when that is the name. A foreign entry on the same event is never matched — `isMusterdHookFor`
  // keys on our own markers.
  const specs = LOCAL_HOOKS.filter((s) => surfaceName(s.event) === name);
  if (specs.length === 0) return 'unknown';
  dropHook(settingsLocalPath(dir), specs[0]!.event, (m) =>
    specs.some((s) => isMusterdHookFor(m, s.marker)),
  );
  return 'removed';
}

export function inspectClaudeStatuslineDrift(cwd: string): string[] {
  const path = join(cwd, '.claude', 'settings.local.json');
  if (!existsSync(path)) return [];
  const settings = readSettingsSafe(path);
  if (!settings) return [];
  if (!settings.statusLine) {
    // ADR 332: absence that was CHOSEN is not drift. Silence, not a softer line — a check that still
    // speaks after a refusal is the nag this vocabulary exists to end.
    if (isDeclined(cwd, SURFACE_STATUSLINE)) return [];
    return [
      'the Claude Code `statusLine` seat chip is missing from .claude/settings.local.json — this ' +
        'session has no user-facing seat indicator, so the human sees an unlabelled terminal while ' +
        'the SessionStart orientation reaches the agent only. Run `musterd init --refresh-hooks` here.',
    ];
  }
  if (!isMusterdStatusline(settings)) return []; // the user's own statusline — a choice, not drift
  if (settings.statusLine.command !== statuslineCommandText()) {
    return [
      'the Claude Code `statusLine` seat chip in .claude/settings.local.json was written by a ' +
        'different musterd build and no longer matches this one — it is present but STALE, which no ' +
        'presence check can see (ADR 168). Run `musterd init --refresh-hooks` here to rewrite it.',
    ];
  }
  return [];
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
      // ADR 332, same rule as the chip: a refused hook is absent on purpose. Only the MISSING branch
      // consults the tombstone — a STALE hook is still installed, and refusing a surface was never a
      // licence to leave a wrong one in place.
      if (spec.missing && !isDeclined(cwd, surfaceName(spec.event))) drift.push(spec.missing);
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
  drift.push(...inspectClaudeStatuslineDrift(cwd));
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
  removeMusterdStatusline(); // marker-exact, like every drop above — a user's own chip survives
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
    // ADR 333: Claude Code's native skill catalog. Other harnesses get their own shell or the
    // canonical `.musterd/skill/orient.md`; this path is no longer "the only copy".
    orientSkillPath: '.claude/skills/musterd-orient/SKILL.md',
    // ADR 334: a seat whose roster role has a committed skill gets a bridge here.
    roleSkillPattern: '.claude/skills/<role>/SKILL.md',
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

// ── The fragment adapter (ADR 281/282/286, Task 5) ───────────────────────────────────────────────
// Claude Code as MANAGED FRAGMENTS: the repo-shared `claude mcp` registration, the folder-scoped
// local hooks, the machine-scoped global hooks, the folder permission entries, and the folder
// guidance files — each independently fingerprinted, locked, journaled, and patched by the
// reconciler. All filesystem access rides the injected FsSeam; the `claude` CLI rides the exec
// seam. The lifecycle `claudeCode` Harness above keeps serving the pre-282 command paths until
// they are retired onto the reconciler.

/** Parse `claude mcp get musterd` output into the entry it registers, or null when unreadable. */
export function parseClaudeMcpGet(
  out: string,
): { command: string; args: string[]; env: Record<string, string> } | null {
  const commandMatch = /^\s*Command:\s*(.+)$/m.exec(out);
  if (!commandMatch) return null;
  const argsMatch = /^\s*Args:\s*(.+)$/m.exec(out);
  const env: Record<string, string> = {};
  for (const m of out.matchAll(/^\s*(MUSTERD_[A-Z_]+)=(\S+)\s*$/gm)) {
    env[m[1]!] = m[2]!;
  }
  return {
    command: commandMatch[1]!.trim(),
    args: argsMatch?.[1] ? argsMatch[1].trim().split(/\s+/) : [],
    env,
  };
}

/** One canonical hook form, shared by desire and observation, so equal state hashes equal —
 *  including for a payload-less RELEASE intent rebuilt from ledger evidence (ADR 282). */
function sortHookEntries<T extends { event: string; command: string }>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    a.event === b.event ? (a.command < b.command ? -1 : 1) : a.event < b.event ? -1 : 1,
  );
}

/** The desired hook payloads, from the same one table the installer and doctor share (ADR 168). */
function localHooksPayload(): { event: string; matcher?: string; command: string }[] {
  return sortHookEntries(
    LOCAL_HOOKS.map((spec) => ({
      event: spec.event,
      ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
      command: spec.command(),
    })),
  );
}

function globalHooksPayload(): { event: string; command: string }[] {
  return sortHookEntries([
    { event: 'SessionStart', command: sessionStartHookCommand() },
    { event: 'UserPromptSubmit', command: promptSubmitHookCommand() },
  ]);
}

/** Every musterd-marked hook in a settings object, in the canonical form — the observation. */
function observedMusterdHooks(
  settings: ClaudeSettings,
): { event: string; matcher?: string; command: string }[] {
  const out: { event: string; matcher?: string; command: string }[] = [];
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    for (const m of matchers) {
      for (const h of m.hooks) {
        if (/#\s*musterd-[a-z-]+/.test(h.command)) {
          out.push({
            event,
            ...(m.matcher !== undefined ? { matcher: m.matcher } : {}),
            command: h.command,
          });
        }
      }
    }
  }
  return sortHookEntries(out);
}

function readSettingsSeam(fs: FsSeam, path: string): ClaudeSettings | null {
  const raw = fs.readFile(path);
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return null;
  }
}

function writeSettingsSeam(fs: FsSeam, path: string, settings: ClaudeSettings): void {
  fs.mkdirp(dirname(path));
  fs.writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 0o644);
}

/** Upsert/drop the musterd hook entries for a payload in a settings object, preserving every other
 *  hook and key. Marker-scoped exactly like the lifecycle installer above. */
function patchHooks(
  settings: ClaudeSettings,
  payload: { event: string; matcher?: string; command: string }[],
  kind: 'write' | 'remove',
): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const events = new Set(payload.map((p) => p.event));
  for (const event of events) {
    const keep = (next.hooks![event] ?? []).filter(
      (m) => !m.hooks.some((h) => /#\s*musterd-[a-z-]+/.test(h.command)),
    );
    const added =
      kind === 'write'
        ? payload
            .filter((p) => p.event === event)
            .map((p) => ({
              ...(p.matcher !== undefined ? { matcher: p.matcher } : {}),
              hooks: [{ type: 'command' as const, command: p.command }],
            }))
        : [];
    const merged = [...keep, ...added];
    if (merged.length > 0) next.hooks![event] = merged;
    else delete next.hooks![event];
  }
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

/** The desired permission entries: the ADR 261 floor plus the provisioned toolkit's permissions. */
function permissionsPayload(ctx: HarnessContext): ProvisionPermissions {
  let toolkit: Toolkit | undefined;
  const provisioning = loadProvisioning(ctx.worktreeRoot, ctx.fs);
  const toolkitName = provisioning.kind === 'valid' ? provisioning.value.toolkit : '';
  if (toolkitName !== '') {
    for (const dir of toolkitHomes(ctx.worktreeRoot)) {
      const raw = ctx.fs.readFile(join(dir, `${toolkitName}.json`));
      if (raw === null) continue;
      try {
        toolkit = parseToolkit(JSON.parse(raw));
        break;
      } catch {
        toolkit = undefined; // an unreadable toolkit never blocks the floor
      }
    }
    toolkit ??= BUILTIN_TOOLKITS[toolkitName];
  }
  return {
    allow: [
      ...new Set([...STANDARD_FLOOR.allow, ...(toolkit?.tools.permissions.allow ?? [])]),
    ].sort(),
    ask: [...new Set([...STANDARD_FLOOR.ask, ...(toolkit?.tools.permissions.ask ?? [])])].sort(),
    deny: [...new Set([...STANDARD_FLOOR.deny, ...(toolkit?.tools.permissions.deny ?? [])])].sort(),
  };
}

const CLAUDE_SURFACE = 'claude-code';

function localSettingsRel(): string {
  return join('.claude', 'settings.local.json');
}

function globalSettingsPathFor(env: NodeJS.ProcessEnv): string {
  const base = env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
  return join(base, 'settings.json');
}

/** Resolve the real `claude` binary only for the REAL exec seam — a scripted seam names its own
 *  target, and the PATH probe is real subprocess work a hermetic test must never pay for. */
async function claudeBinFor(exec: ExecSeam): Promise<string> {
  if (exec !== nodeExec) return 'claude';
  return (await resolveClaudeBin()) ?? 'claude';
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: 'claude-code',
  surface: 'claude-code',
  adapterVersion: 2,

  async availability(ctx) {
    const exec = ctx.exec ?? nodeExec;
    const bin = await claudeBinFor(exec);
    const ver = await exec.run(bin, ['--version']);
    return ver.ok
      ? { available: true, detail: `claude ${ver.out.trim().split(' ')[0] ?? ''}`.trim() }
      : { available: false, detail: 'claude CLI not found on PATH or common install locations' };
  },

  async target(ctx) {
    const repoRoot = primaryCheckoutFor(ctx.worktreeRoot) ?? ctx.worktreeRoot;
    return {
      containers: [
        // Claude Code keys local-scope MCP config by repo ROOT — one registration for every
        // sibling worktree (ADR 143); each worktree contributes ownership, none owns it alone.
        {
          containerKey: `repo-shared ${repoRoot} claude-mcp-local`,
          scope: 'repo-shared',
          handle: repoRoot,
        },
        {
          containerKey: `folder ${ctx.worktreeRoot} ${localSettingsRel()}`,
          scope: 'folder',
          handle: localSettingsRel(),
        },
        {
          containerKey: `machine claude-code global-settings`,
          scope: 'machine',
          handle: globalSettingsPathFor(ctx.env),
        },
      ],
    };
  },

  async desiredFragments(ctx) {
    const repoRoot = primaryCheckoutFor(ctx.worktreeRoot) ?? ctx.worktreeRoot;
    const launch = resolveMcpLaunch();
    const mcpPayload = {
      command: launch.command,
      args: launch.args,
      env: launchEntryEnv(CLAUDE_SURFACE),
    };
    const hooks = localHooksPayload();
    const globals = globalHooksPayload();
    const permissions = permissionsPayload(ctx);
    const guidancePayload = guidanceFileMap(
      claudeCode.guidance!,
      ctx.team ?? '',
      roleBridgesFor(ctx.worktreeRoot, [claudeCode]),
    );
    const localContainer = `folder ${ctx.worktreeRoot} ${localSettingsRel()}`;
    return [
      {
        harness: 'claude-code',
        resourceKey: repoSharedResourceKey(repoRoot, 'musterd', 'claude-code', 'mcp.musterd'),
        containerKey: `repo-shared ${repoRoot} claude-mcp-local`,
        fragmentKey: 'mcp.musterd',
        scope: 'repo-shared',
        fingerprint: canonicalFingerprint(mcpPayload),
        payload: mcpPayload,
      },
      {
        harness: 'claude-code',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'claude-code', 'hooks.local'),
        containerKey: localContainer,
        fragmentKey: 'hooks.local',
        scope: 'folder',
        fingerprint: canonicalFingerprint(hooks),
        payload: hooks,
      },
      {
        harness: 'claude-code',
        resourceKey: machineResourceKey('claude-code', 'hooks.global'),
        containerKey: 'machine claude-code global-settings',
        fragmentKey: 'hooks.global',
        scope: 'machine',
        fingerprint: canonicalFingerprint(globals),
        payload: globals,
      },
      {
        harness: 'claude-code',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'claude-code', 'permissions'),
        containerKey: localContainer,
        fragmentKey: 'permissions',
        scope: 'folder',
        fingerprint: canonicalFingerprint(permissions),
        payload: permissions,
      },
      {
        harness: 'claude-code',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'claude-code', 'guidance'),
        containerKey: `folder ${ctx.worktreeRoot} claude-guidance`,
        fragmentKey: 'guidance',
        scope: 'folder',
        fingerprint: canonicalFingerprint(guidancePayload),
        payload: guidancePayload,
      },
    ];
  },

  async observe(ctx, intent) {
    switch (intent.fragmentKey) {
      case 'mcp.musterd': {
        const exec = ctx.exec ?? nodeExec;
        const bin = await claudeBinFor(exec);
        const got = await exec.run(bin, ['mcp', 'get', 'musterd']);
        if (!got.ok) return { state: 'absent' };
        const entry = parseClaudeMcpGet(got.out);
        if (!entry) {
          return {
            state: 'invalid-container',
            issues: [{ path: '<claude mcp get>', message: 'unparseable registration' }],
          };
        }
        const fingerprint = canonicalFingerprint(entry);
        // 'legacy' (the retired MUSTERD_SURFACE) and 'none' (the ADR 165 marker-less shape — the
        // COMMON pre-286 fleet registration) are both the pre-ADR-286 class: neither can attach,
        // and confirmed configure's marker-only repair converts both while preserving the entry.
        return markerGenerationOfEnv(entry.env) !== 'launch'
          ? { state: 'legacy-launch-marker', fingerprint }
          : { state: 'present', fingerprint };
      }
      case 'hooks.local':
      case 'hooks.global': {
        const path =
          intent.fragmentKey === 'hooks.local'
            ? join(ctx.worktreeRoot, localSettingsRel())
            : globalSettingsPathFor(ctx.env);
        const settings = readSettingsSeam(ctx.fs, path);
        if (settings === null) {
          return {
            state: 'invalid-container',
            issues: [{ path: '<settings>', message: 'not valid JSON' }],
          };
        }
        // Fingerprint the canonical PHYSICAL form — payload-independent, so a release intent
        // rebuilt from ledger evidence observes the fingerprint the write recorded.
        const observed = observedMusterdHooks(settings);
        if (observed.length === 0) return { state: 'absent' };
        return { state: 'present', fingerprint: canonicalFingerprint(observed) };
      }
      case 'permissions': {
        const settings = readSettingsSeam(ctx.fs, join(ctx.worktreeRoot, localSettingsRel()));
        if (settings === null) {
          return {
            state: 'invalid-container',
            issues: [{ path: '<settings>', message: 'not valid JSON' }],
          };
        }
        const desired =
          (intent.payload as ProvisionPermissions | undefined) ?? permissionsPayload(ctx);
        const present: ProvisionPermissions = { allow: [], ask: [], deny: [] };
        let any = false;
        for (const list of PERM_LISTS) {
          const have = new Set(settings.permissions?.[list] ?? []);
          present[list] = desired[list].filter((e) => have.has(e));
          if (present[list].length > 0) any = true;
        }
        if (!any) return { state: 'absent' };
        const complete = PERM_LISTS.every((l) => present[l].length === desired[l].length);
        return {
          state: 'present',
          fingerprint: complete ? intent.fingerprint : canonicalFingerprint(present),
        };
      }
      case 'guidance':
        return observeFileMap(
          ctx.fs,
          ctx.worktreeRoot,
          (intent.payload as Record<string, string> | undefined) ??
            guidanceFileMap(
              claudeCode.guidance!,
              ctx.team ?? '',
              roleBridgesFor(ctx.worktreeRoot, [claudeCode]),
            ),
        );
      default:
        return { state: 'absent' };
    }
  },

  async apply(ctx, mutation) {
    const { intent } = mutation;
    switch (intent.fragmentKey) {
      case 'mcp.musterd': {
        const exec = ctx.exec ?? nodeExec;
        const bin = await claudeBinFor(exec);
        if (mutation.kind === 'remove') {
          await exec.run(bin, ['mcp', 'remove', 'musterd', '-s', 'local']);
          return;
        }
        let entry = intent.payload as {
          command: string;
          args: string[];
          env: Record<string, string>;
        };
        if (mutation.kind === 'repair-launch-marker') {
          // Replace ONLY the retired marker; preserve the observed command/args and unrelated env.
          const got = await exec.run(bin, ['mcp', 'get', 'musterd']);
          const observed = got.ok ? parseClaudeMcpGet(got.out) : null;
          if (observed) {
            const { [RETIRED_SURFACE_ENV]: _retired, ...rest } = observed.env;
            entry = {
              command: observed.command,
              args: observed.args,
              env: { ...rest, ...launchEntryEnv(CLAUDE_SURFACE) },
            };
          }
        }
        const envArgs = Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
        await exec.run(bin, ['mcp', 'remove', 'musterd', '-s', 'local']);
        const added = await exec.run(bin, [
          'mcp',
          'add',
          'musterd',
          '-s',
          'local',
          ...envArgs,
          '--',
          entry.command,
          ...entry.args,
        ]);
        if (!added.ok) throw new Error('claude mcp add failed');
        return;
      }
      case 'hooks.local':
      case 'hooks.global': {
        const path =
          intent.fragmentKey === 'hooks.local'
            ? join(ctx.worktreeRoot, localSettingsRel())
            : globalSettingsPathFor(ctx.env);
        const settings = readSettingsSeam(ctx.fs, path);
        if (settings === null) throw new Error('settings container invalid at apply time');
        const payload =
          (intent.payload as { event: string; matcher?: string; command: string }[] | undefined) ??
          (intent.fragmentKey === 'hooks.local' ? localHooksPayload() : globalHooksPayload());
        writeSettingsSeam(
          ctx.fs,
          path,
          patchHooks(settings, payload, mutation.kind === 'remove' ? 'remove' : 'write'),
        );
        return;
      }
      case 'permissions': {
        const path = join(ctx.worktreeRoot, localSettingsRel());
        const settings = readSettingsSeam(ctx.fs, path);
        if (settings === null) throw new Error('settings container invalid at apply time');
        const desired =
          (intent.payload as ProvisionPermissions | undefined) ?? permissionsPayload(ctx);
        const next: ClaudeSettings = {
          ...settings,
          permissions: { ...(settings.permissions ?? {}) },
        };
        for (const list of PERM_LISTS) {
          const have = next.permissions![list] ?? [];
          if (mutation.kind === 'remove') {
            const drop = new Set(desired[list]);
            const kept = have.filter((e) => !drop.has(e));
            if (kept.length > 0) next.permissions![list] = kept;
            else delete next.permissions![list];
          } else {
            const set = new Set(have);
            for (const e of desired[list]) set.add(e);
            if (set.size > 0) next.permissions![list] = [...set];
          }
        }
        if (next.permissions && Object.keys(next.permissions).length === 0) delete next.permissions;
        writeSettingsSeam(ctx.fs, path, next);
        return;
      }
      case 'guidance':
        applyFileMap(
          ctx.fs,
          ctx.worktreeRoot,
          (intent.payload as Record<string, string> | undefined) ??
            guidanceFileMap(
              claudeCode.guidance!,
              ctx.team ?? '',
              roleBridgesFor(ctx.worktreeRoot, [claudeCode]),
            ),
          mutation.kind === 'remove' ? 'remove' : 'write',
        );
        return;
      default:
        throw new Error(`unknown claude-code fragment ${intent.fragmentKey}`);
    }
  },
};
