# 418 — Session label capability is this session's tool list

- Status: accepted
- Date: 2026-09-17
- Amends: [ADR 186](186-cross-harness-session-labels.md) (capability was declared per harness at
  provision time), [ADR 326](326-session-orientation.md) (orient ends on a stamp; it did not say
  when to label), [ADR 333](333-orient-skill-every-harness.md) (one orient body on every harness).
  Does not reverse any of them.
- Lane: `01M2SA32PG4Q0TPDYN0N3ZM1GQ`

## Context

ADR 186 split sidebar labeling by **harness capability**: `cross_rename` (Claude Code Desktop
`list_sessions` → `resolve-labels` → `set_session_title`), `self_rename` (Cursor `rename_chat` on
this chat only), `none` (Codex; Cursor when the MCP tool is absent). Terminal OSC (ADR 160 surface
1) stayed the only universal writer. The two labeling skills are provisioned per harness, not per
driver.

Claude Code Desktop and Claude Code terminal **share the same files**:
`.claude/skills/musterd-label-sessions/SKILL.md` and the same UserPromptSubmit hook that runs
`musterd session label-nudge`. Init cannot split them. `label-nudge` keys off unlabeled Desktop
session records on disk (ADR 186 evidence-based due). A Claude Code CLI session therefore gets
asked to run a Desktop-only sweep every turn, tries tools it does not have, and narrates the miss.

`musterd session orient-stamp` (ADR 326) is a different machine. It writes
`.musterd/orient-stamp.json` so the orient nudge goes quiet. It has no MCP verb (ADR 413). It must
run on every harness and every driver. The orient skill ended on that stamp and never mentioned
labeling, so a CLI session had to invent whether a failed sweep also skipped the stamp.

## Problem

Harness-level provision cannot see driver. The agent has to decide from **this session's tool
list**. Without that tree in the orient skill, and with a nudge that still fires on a no-write
driver, the CLI session wastes a turn, narrates a capability gap, and may skip the stamp that
quiets the orient nudge.

## Decision

1. **Capability is this session's tool list**, not the harness the files were provisioned for.
   After the orient status_update:

   - both `list_sessions` and `set_session_title` → peer sweep (existing label-sessions procedure;
     do not hand-craft titles);
   - else `rename_chat` → self-label this chat (shared grammar; a title the user just typed wins);
   - else **skip silently**. Terminal tabs are already OSC-labeled. Do not narrate the skip. Do
     not write Cursor `state.vscdb` or Codex SQLite.

2. **`musterd session orient-stamp` always follows**, whether labeling ran or was skipped. A skip
   does not skip the stamp.

3. **Do not generate per-driver orient files.** Desktop and terminal cannot be provisioned apart.

4. **`label-nudge` is silent on a known no-write driver** even if Desktop session records still
   have unlabeled rows. **Unknown still nudges** (ADR 173: absent ≠ nothing to do — silencing
   Desktop by mistake is the unlabeled-sidebar failure the nudge exists to close).

   The known no-write signal is `TERM_PROGRAM` in the terminal-emulator set (`Apple_Terminal`,
   `iTerm.app`, `ghostty`, `WezTerm`, `kitty`, `Alacritty`/`alacritty`, `tmux`, `screen`).
   Measured 2026-09-17 on `claude` 2.1.276 in Apple Terminal: `TERM_PROGRAM=Apple_Terminal`,
   `TERM=xterm-256color`, `__CFBundleIdentifier=com.apple.Terminal`. Falsify: a Claude Code
   Desktop session-management UserPromptSubmit hook that inherits one of those `TERM_PROGRAM`
   values — if that happens, drop the value from the set; do not guess a wider silence.

   `TERM_PROGRAM=vscode` / `VSCODE_PID` stay in the unknown bucket and still nudge.

## Consequences

- Guidance content version 25 → 26. Seat workspaces are stale until refresh (the standing gap in
  lane `01M2NTZ9WV`, not a new one).
- A Claude Code CLI session orients and stamps without attempting a sidebar sweep or narrating
  why it did not.
- `label-nudge` no longer asks Apple Terminal (and the other named emulators) to run
  `musterd-label-sessions`. Desktop and unknown drivers keep the evidence-based due check.
- ADR 186's harness capability table remains the provision map (`sessionsSkillPath` /
  `selfLabelSkillPath`). This ADR is the runtime gate the shared files could not express.

## Observability & Evaluation

- **Traces.** None added. The orient stamp and the machine-wide label-sweep stamp are unchanged
  local files. The new silence is a skipped stdout line on the UserPromptSubmit hook.
- **Eval.** Unit: `renderOrientSkill` names the three tool-list branches and still ends on
  `musterd session orient-stamp`; both labeling skills contain "skip silently" and forbid SQLite
  writes; `labelNudgeHasNoSidebarWrite` is true for `Apple_Terminal` and false for unset /
  `vscode`; the `label-nudge` command prints on `vscode` when CCD apply is non-empty and prints
  nothing on `Apple_Terminal` with the same CCD rows. Baseline: the 2026-09-17 CLI narration
  ("labeling didn't run — this is the terminal CLI") must not be the instructed outcome.
- **Experiment.** None pre-registered. Open empirical: does Claude Code Desktop's hook ever
  inherit `TERM_PROGRAM=Apple_Terminal`? The Decision's falsifier is that question.
