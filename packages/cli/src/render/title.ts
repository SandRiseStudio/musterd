import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  WORKSPACE_SPEC_FILE,
  renderTerminalTitle,
} from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { findBinding, findWorkspaceSpec } from '../config.js';

/**
 * Terminal-tab seat titles (ADR 160). After a command runs, retitle the hosting terminal to
 * `🔶 <seat> · <workspace folder>` so a human juggling several agent terminals can tell which tab
 * is which seat. Harness-neutral by construction: it rides the CLI itself, so any terminal-hosted
 * harness whose agent shells out to `musterd` (Codex CLI, cursor-agent, a plain `claude`, a future
 * musterd harness) gets the label as a side effect — no per-harness driver, no hook requirement.
 *
 * Best-effort and unverifiable by nature: an emulator may ignore OSC titles, a PROMPT_COMMAND shell
 * or the harness may overwrite them. That is fine — the title is re-asserted on every command.
 */

/**
 * Commands where retitling is wrong, not just unnecessary: `serve` is the daemon (launchd, no
 * terminal of its own); `gate` is the sub-50ms PreToolUse budget path (ADR 150) and `session` the
 * SessionStart/End hook path — both run headless under a harness; `host` wakes *other* seats;
 * `help`/`uninstall`/`reset` are teardown/no-identity paths. Everything else — status, inbox, send,
 * lane, claim — is a human-or-agent working in a terminal, exactly where the label belongs.
 */
const TITLE_SKIP_COMMANDS = new Set([
  'serve',
  'service',
  'gate',
  'session',
  'host',
  'notify',
  'nudge',
  'help',
  'uninstall',
  'reset',
]);

/**
 * Decide the title for this invocation, or null to stay silent. Pure — no tty probing, no writes —
 * so the whole decision table is unit-testable; the unverifiable part stays confined to
 * {@link emitTerminalTitle}. Null when: the command is in the skip set, the user opted out
 * (`--no-title` / `MUSTERD_NO_TITLE=1`), the platform has no `/dev/tty` (win32), or the walk-up
 * finds no seat workspace (a plain repo is not a seat — never label it).
 */
export function terminalTitleFor(
  command: string,
  parsed: Parsed,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (TITLE_SKIP_COMMANDS.has(command)) return null;
  if (parsed.flags['no-title'] === true) return null;
  if (env['MUSTERD_NO_TITLE'] === '1') return null;
  if (platform === 'win32') return null; // no /dev/tty; conhost/WT titling is a different mechanism

  const dir = findSeatWorkspace(cwd);
  if (!dir) return null;

  // Seat name: the binding's claim policy first (the live identity), the committed workspace spec
  // as fallback (a fresh clone before first claim still deserves its label).
  const binding = findBinding(dir, env);
  let seat: string | undefined;
  const claim = binding?.claim ?? findWorkspaceSpec(dir)?.claim;
  if (claim?.mode === 'seat') seat = claim.name;
  if (!seat) return null; // role/chat folders have no fixed seat — a wrong label is worse than none

  // Subject = workspace folder name. Deliberately NOT the lane title: lanes live server-side and a
  // network round-trip per CLI command is disqualifying. Lane-aware titles are a flagged follow-up.
  return renderTerminalTitle(seat, basename(dir));
}

/**
 * Walk up to the workspace root, anchored on EITHER `.musterd/binding.json` (a claimed folder) or
 * the committed `.musterd/workspace.json` (a fresh clone before first claim). `findWorkspaceDir`
 * anchors on the binding alone, which would leave a spec-only worktree unlabeled — and the fresh
 * clone is exactly the tab a human most needs to tell apart.
 */
function findSeatWorkspace(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (
      existsSync(join(dir, BINDING_DIR, BINDING_FILE)) ||
      existsSync(join(dir, BINDING_DIR, WORKSPACE_SPEC_FILE))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Write the title to the *controlling terminal* via OSC 0 (`ESC ] 0 ; title BEL`). `/dev/tty` and
 * not stdout/stderr, for two reasons: the SessionStart hook one-liners redirect both streams to
 * /dev/null (hook stdout is injected into model context), and piped/`--json` output must stay
 * byte-clean without every command needing to know titles exist. No controlling terminal (CCD,
 * launchd, CI, MCP stdio) makes the open throw — and that throw IS the guard: swallow and stay
 * silent. Untestable by design, like the inbox bell; keep it too small to be wrong.
 */
export function emitTerminalTitle(title: string): void {
  try {
    const fd = openSync('/dev/tty', 'w');
    try {
      // Escapes, never literal control bytes in source (a literal NUL once made a .ts diff as binary).
      writeSync(fd, `\u001b]0;${title}\u0007`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // No tty here — a daemon, a hook, a pipe. Silence is correct.
  }
}
