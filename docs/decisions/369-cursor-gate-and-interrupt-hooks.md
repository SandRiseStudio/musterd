# 369 — Cursor PreToolUse gate and PostToolUse interrupt parity

- Status: accepted — 2026-09-03
- Date: 2026-09-03
- Builds on: [ADR 150](150-structural-inducement-pretooluse-gates.md) (PreToolUse write gate), [ADR 088](088-interrupt-line-fast-path.md) / [ADR 225](225-routed-acceptance-is-an-obligation.md) (mid-loop interrupt check), [ADR 198](198-cursor-hooks-observe-model.md) / [ADR 265](265-cursor-agent-hooks.md) / [ADR 333](333-cursor-session-orientation.md) (Cursor hook infrastructure and orientation injection), [ADR 163](163-subagent-gate-inducement.md), [ADR 352](352-grok-first-class-harness.md)
- Lane: `01M1M8NQCZX52RZK9M879TE8AK`

## Context

Musterd relies on two mechanical loops at the tool boundary for multi-agent coordination:
1. **PreToolUse enforcement gate ([ADR 150](150-structural-inducement-pretooluse-gates.md))**: Mechanically blocks file edits, destructive shell commands, and unmanaged subagents outside claimed lanes.
2. **PostToolUse mid-loop interrupt ([ADR 088](088-interrupt-line-fast-path.md), [ADR 225](225-routed-acceptance-is-an-obligation.md))**: Runs `inbox --interrupt-check` at tool boundaries to inject urgent coordination acts and routed acceptance obligations mid-turn into agent context.

Historically, Claude Code has had full support for both loops via its `.claude/settings.local.json` hook interface. Cursor had `sessionStart` (with ADR 333 orientation injection), `postToolUse` (attesting `model_id`), and `sessionEnd`. The support matrix (`docs/wiki/driver-support-matrix.md`) documented Cursor as lacking PreToolUse gates and PostToolUse mid-loop interrupts.

Cursor's Agent Hooks engine (`.cursor/hooks.json`) has full native support for:
- `preToolUse`: receives `tool_name` (`Shell`, `Write`, `Delete`, `StrReplace`, `Task`), `tool_input` (`command`, `path`, etc.), `cwd`, and enforces via stdout JSON `{"permission": "deny", "user_message": "...", "agent_message": "..."}` or exit code 2.
- `postToolUse`: receives tool results and context, and accepts injected context via stdout JSON `{"additional_context": "..."}`.

## Problem

Because Cursor seats lacked PreToolUse gate enforcement, declared ADR 150 enforcement classes failed open under Cursor. A Cursor seat could edit files outside claimed lanes without mechanical intervention. Furthermore, urgent coordination acts (e.g., blocking asks, interrupt-tier requests, routed acceptance obligations) were not injected until the human or agent completed an entire turn and manually ran inbox checks.

## Decision

Bring the Cursor harness to parity with Claude Code by wiring the PreToolUse write gate and PostToolUse mid-loop interrupt into Cursor's native hook lifecycle.

### 1. PreToolUse write gate: vocabulary mapping and dual-format emission

`packages/cli/src/commands/gate.ts` (`musterd gate check --stdin`) is extended to:
- Map Cursor tool names onto the existing class-table vocabulary:
  - `Shell` -> `Bash` (reads `input.command`)
  - `StrReplace` -> `Edit` (reads `input.path`)
  - `Delete` -> `Write` (reads `input.path`)
  - `Task` -> `Agent` (reads `input.subagent_type` as `spawnType` and `input.model` as `spawnModel`)
- Accept `input.path` in addition to `file_path`, `notebook_path`, and `target_file`.
- Support subagent attestation envelopes carrying `subagent_id` and `subagent_type`.
- In `emitDeny(reason)`, emit dual-format control JSON containing both Cursor's `{ permission: 'deny', user_message: reason, agent_message: reason }` and Claude Code's `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }`.
- In `emitWarn(reason)`, emit `{ additional_context: reason, hookSpecificOutput: { ... } }`.

### 2. PostToolUse interrupt check: `--interrupt` flag on `session observe`

`packages/cli/src/commands/session.ts` adds `--interrupt` to `musterd session observe --stdin`:
- After completing `observeCursorSession(payload)` (attesting model, updating session binding, refreshing live liveness), `checkCursorInterrupt(captureDir)` queries the daemon (`http.interruptCheck(team)`).
- When an interrupt is raised (`res.raised && res.line`), stdout emits JSON: `{"additional_context": res.line}`.
- If no interrupt is raised, stdout remains silent (empty string, exit 0).
- Honors `MUSTERD_NO_NUDGE=1` for test isolation and human opt-out.

### 3. Cursor hook lifecycle and fragment management

`packages/cli/src/onboard/harnesses/cursor.ts` updates `.cursor/hooks.json` provisioning:
- Installs `preToolUse` hook with matcher `'Shell|Write|Delete|Edit|Task'` tagged `# musterd-cursor-gate`. Command:
  `cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; command -v musterd >/dev/null 2>&1 && musterd gate check --stdin 2>/dev/null || true # musterd-cursor-gate`
- Updates `postToolUse` hook to pass `--interrupt` and retain stdout (discarding stderr only):
  `cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; command -v musterd >/dev/null 2>&1 && musterd session observe --stdin --interrupt 2>/dev/null || true # musterd-cursor-observe`
- Updates `installMusterdCursorHooks`, `removeMusterdCursorHooks`, and `cursorAdapter` fragment observation and apply logic to manage `preToolUse` and updated `postToolUse` hooks idempotently alongside user hooks.

## Consequences

- Cursor seats now enforce ADR 150 PreToolUse gates mechanically: unowned writes, unpermitted shell commands, and unmanaged subagents are blocked before execution with helpful repair instructions.
- Cursor seats now receive mid-turn interrupts when teammates send urgent directed acts or routed acceptance obligations.
- Cursor harness reaches parity with Claude Code on tool-boundary enforcement and interrupt injection. The only remaining gaps are environment limitations (no persistent TUI statusline slot in Cursor IDE, and no cross-session rename API for peer session discovery).
- All changes are fail-open and best-effort; unreachable daemons or parsing failures never wedge a tool call.

**2026-09-05 — the probe existed and no workspace ran it; the doctor could not see why (lane
01M1T42CDP).** The bell check found schmidt's Cursor seat heard nothing at any boundary. His
`.cursor/hooks.json` carried every musterd marker, and its `postToolUse` command was the build before
this ADR: `session observe --stdin` with stdout discarded and no `--interrupt`. The adapter writes
`--interrupt` (this ADR's Decision 2) and `upsertCursorHook` replaces a marker-matched entry in place,
so `musterd init --refresh-hooks` was the whole repair — but nothing asked for it, because Cursor
populated no `hookDrift` (driver-support-matrix: "not populated"), and a marker-presence check cannot
see a stale command (ADR 168). `inspectCursorHookDrift` now compares each marker-owned hook's text
against what this build writes and names the missing or STALE event with the refresh as the repair;
`detect()` carries it as `hookDrift`, which the doctor already renders. The six hook specs are one list
shared by install, remove and inspect, so the three cannot drift from each other. Falsifier: a
workspace whose `postToolUse` hook lacks `--interrupt` and whose `musterd init --check` says nothing.

## Observability & Evaluation

- **Traces:** `gate.adjudicate` records shapes-only decision rows for Cursor `preToolUse` calls matching declared enforcement classes; `inbox.interrupt_check` records fast-path interrupt queries from Cursor `postToolUse` hooks.
- **Eval:** dataset is the CLI test suite (`packages/cli/src/commands/gate.test.ts`, `session.test.ts`, `cursor.hooks.test.ts`); baseline is Claude Code PreToolUse denial and PostToolUse interrupt lines. Cursor payloads (`Shell`, `Write`, `Delete`, `StrReplace`, `Task`) match and deny identically to their Claude Code counterparts.
- **Experiment:** verified in local test suite with synthesized Cursor hook stdin and simulated daemon gate/interrupt responses.
