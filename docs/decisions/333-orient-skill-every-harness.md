# 333 — musterd-orient on every supported harness

- Status: accepted
- Date: 2026-08-27
- Builds on: [ADR 326](326-session-orientation.md) (the ritual, the block, Claude Code first),
  [ADR 085](085-layered-guidance-surface.md) (generated guidance shells),
  [ADR 198](198-cursor-hooks-observe-model.md) (Cursor `sessionStart`),
  [ADR 249](249-codex-observational-hooks.md) (Codex hook table),
  [ADR 321](321-opencode-first-class-harness.md) (OpenCode has no hook table)
- Supersedes: ADR 326 Decision (4) — the distribution clause only ("Claude Code first;
  Codex/OpenCode keep the primer"). The ritual, the composable-only block, and the scoped-wake
  rule in 326 stand.
- Lane: 01M10EZ9KB0C4KA4YJQHP1SSEV

## Context

ADR 326 shipped `musterd-orient` and the SessionStart orientation block on Claude Code, because
that harness already had the hook seams. Cursor, Codex, OpenCode, and the native host never got
the skill file. A Cursor seat that opened with "lets continue" had no `musterd-orient` in its
catalog, treated a wrap note as a mandate, and claimed an unowned lane — the exact autoresume
the ritual forbids.

The 326 distribution clause also said Codex had no SessionStart injection point. That was a
measurement of *our* wiring, not of the hosts. Cursor `sessionStart` accepts JSON
`additional_context` into the conversation's initial system context. Codex `SessionStart` treats
stdout / `additionalContext` as developer context, and `UserPromptSubmit` can repeat a line.
We currently discard Cursor `sessionStart` stdout (`>/dev/null`) because that hook only observed
the model.

OpenCode still has no hook table (ADR 321 §8). Cursor `beforeSubmitPrompt` can allow or block a
prompt; it cannot inject context, so there is no repeating-nudge seam on Cursor today.

## Problem

1. How does a seat on Cursor, Codex, OpenCode, or the native host *find* `musterd-orient`?
2. Where the host already has a session-start injection seam we currently silence, how does the
   orientation block reach the model without inventing a new ritual?
3. What do we *not* wire, so this lane does not pretend Cursor has Claude's per-turn nudge?

## Decision

1. **Catalog on every supported harness, generated and stamped (ADR 085).** Same body
   (`renderOrientSkill`). Placement:
   - Claude Code: unchanged (`.claude/skills/musterd-orient/SKILL.md`).
   - Cursor: `.cursor/rules/musterd-orient.mdc` (`alwaysApply: false`, same shell as self-label).
   - Codex, OpenCode, native: canonical `.musterd/skill/orient.md` (alongside the team skill).
   No primer edit in this ADR — that file is izzo's `#1087` / ADR 326 amendment. Codex learns
   the skill name from the injected block; OpenCode gets the file only.

2. **Cursor sessionStart injects the block once.** Replace the observe-and-discard one-liner
   with `musterd session observe --stdin --orient`: still observes (ADR 198), then prints
   `{"additional_context":"<block>"}` when `emitSessionOrientation` returns a block. Stderr
   stays discarded; stdout is the seam. Other Cursor observe events stay silent. No
   `beforeSubmitPrompt` wiring — that event is a gate, not an injector. No `stop.followup_message`
   auto-prompt. A Cursor session that skips the one-shot is a recorded residual, not a bug in
   this ADR.

3. **Codex SessionStart emits the same block as plain stdout** (the host's additional-context
   path) from `codex-hook start` after capture. **Codex UserPromptSubmit** runs
   `musterd session orient-nudge` until the workspace stamp names this session — Claude's
   repeating-nudge pattern, on the Codex event that actually injects.

4. **OpenCode and the native host stay catalog-only** until they grow a hook table / host
   injector. Heartbeat-side capture (ADR 270) is not an injection seam.

## Consequences

- A Cursor or Codex seat that `musterd init` (or `--refresh-guidance` / `--refresh-hooks`) has
  run in gets the skill and, on those two hosts, the block. Existing workspaces need that refresh;
  the doctor reports the missing files and the missing UserPromptSubmit hook as drift.
- ADR 326 Decision (4)'s "Claude Code first" sentence is no longer the distribution rule. Read
  this ADR for where the skill and the block land. 326's ritual, bar, and wake-suppression stand.
- Cursor still has no repeating nudge. If a Cursor agent ignores the injected block under a busy
  first prompt, the human still has to type — the 326 falsifier ("type nothing") is Claude- and
  Codex-shaped, not Cursor-shaped, until Cursor grows an inject-on-prompt seam.
- `packages/protocol/src/guidance.ts` is unchanged here (izzo's `#1087` owns the skill body /
  tier wording). Cursor's `alwaysApply: false` frontmatter is assembled in the CLI writer.

## Observability & Evaluation

**Traces.** Same as ADR 326: three read-only GETs per session start under the seat identity,
hook-local stdout, no new daemon traffic. Cursor `--orient` adds no extra fetch beyond
`emitSessionOrientation`. Codex UserPromptSubmit is the existing `orient-nudge` one-liner.

**Eval.** Unit: Cursor `sessionStart` command contains `--orient` and does not redirect stdout
to `/dev/null`; `formatCursorOrientation` wraps a block as `additional_context` JSON and is
silent on null. Codex hooks file gains a marker-owned UserPromptSubmit running `orient-nudge`.
`writeGuidance` writes `.cursor/rules/musterd-orient.mdc` and `.musterd/skill/orient.md`.
Baseline: before this ADR, those paths were absent and Cursor `sessionStart` discarded stdout.

**Experiment.** Open a Cursor seat session after `musterd init --refresh-hooks --refresh-guidance`
and type nothing: the agent should see the orientation block in opening context and run
`musterd-orient`. If the human still has to type "continue", the Cursor one-shot failed the same
way Claude's one-shot SessionStart ask did — that is the residual this ADR records, not a
gate that blocks the catalog.
