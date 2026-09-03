# 370 — Grok interrupt injection is PreToolUse additionalContext + Stop, not PostToolUse stdout

- Status: accepted — 2026-09-03
- Date: 2026-09-03
- Builds on: [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the interrupt line), [ADR 352](352-grok-first-class-harness.md) (Grok first-class harness, whose Decision 8 wired PostToolUse → `inbox --interrupt-check` at Claude parity)
- Lane: `01M1MC0M6M8RWV6RQFRPASNVQD`
- Does not change the protocol. Does not invent a peer-session inject rail (ADR 167 stays an honest omission on Grok).

## Context

ADR 088's interrupt line is one daemon-composed stdout line from `musterd inbox --interrupt-check`, injected at a tool boundary so a busy agent sees urgent steering in seconds. Claude Code injects PostToolUse stdout into the model. ADR 352 Decision 8 wired the same command as a Grok `PostToolUse` hook, discarding stdout (`>/dev/null`) because the adapter treated Grok like a passive event.

Grok 1.0.13 documents the opposite of Claude's PostToolUse injection: "For events like SessionStart or PostToolUse, stdout is ignored." PreToolUse `hookSpecificOutput.additionalContext` is documented as reaching the model after the tool, wrapped in a `<system-reminder>`. A `Stop` hook may `{"decision":"block","reason":"..."}` and that reason is fed back as a user message that continues the turn (cap 8; `stopHookActive` is true on continuations). `UserPromptSubmit` additionalContext is discarded (already an ADR 352 honest omission).

## Problem

The Grok PostToolUse interrupt hook ran the probe (so the daemon was asked) and threw the line away. Even if stdout had been kept, Grok would have ignored it. Wanderer — the only live Grok seat — was unreachable by the ADR 088 rail: the wiki's 2026-08-14 interrupt census (0 interrupts raised of 38 asks) predates the harness, and the 2026-09-02 wiring did not close the gap.

Need a doorbell the *model* sees, without inventing peer inject (no `list_sessions` + `send_message` on Grok 1.0.13; ACP `session/prompt` is the parent client, not a teammate).

## Decision

Measure first, then wire the seams Grok actually injects. Measured 2026-09-03 against Grok 1.0.13 (`5e9a58528b76`) with a disposable `grok -p` and canary hooks (session `01a068ff-3fae-7661-a3a6-ba3ec780efeb`):

| Seam | Hook ran? | Reached the model? |
| --- | --- | --- |
| PostToolUse `additionalContext` JSON | yes (`post_tool_use` dispatcher) | **no** — absent from `chat_history.jsonl` |
| PreToolUse `hookSpecificOutput.additionalContext` | yes (`additional_context=true`) | **yes** — `<system-reminder>` / `synthetic_reason: system_reminder` |
| Stop `{"decision":"block","reason":…}` | yes (`block=true`) | **yes** — `Stop hook feedback:` / `synthetic_reason: stop_hook_feedback`; turn continued; second fire had `stopHookActive: true` |

### 1. Mid-loop: PreToolUse additionalContext

Move `musterd inbox --interrupt-check` off PostToolUse onto a **second** PreToolUse hook (no matcher — every tool). Wrap a non-empty line as:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"<line>"}}
```

Empty output (the common path) adds no context. Do not mix this with the ADR 150 gate (separate process, separate marker). Timing matches Claude PostToolUse: the reminder arrives with the tool results, before the next model step.

Refresh drops a leftover PostToolUse interrupt hook so the probe is not run twice.

### 2. Idle-at-turn-end: Stop, once

A `Stop` hook reads the event, exits 0 unless `reason == "end_turn"` and `stopHookActive` is not true, then runs the same probe. A non-empty line prints `{"decision":"block","reason":"<line>"}`. One continuation per turn. Session-end `reason: "shutdown"` is not blocked. Timeout 10s (not Grok's 600s Stop default).

The injected text is still the daemon-composed interrupt line — never the act body (ADR 088 §4).

### 3. Still not a 167 rail

No `list_sessions`, no `send_message`, no writing `updates.jsonl` or TTY stdin. Notification → `musterd inbox --waiting` stays the frozen-on-approval rung (ADR 053; `nudge` is the hidden alias).

## Consequences

- A busy Grok seat sees an urgent act at the next tool, as a system-reminder naming the hook. An idle-at-prompt Grok seat that just finished a turn is continued once with Stop-hook feedback.
- ADR 352 Decision 8's PostToolUse wiring is marked in place; this ADR is the replacement. The Decision there is not rewritten.
- `docs/wiki/driver-support-matrix.md` Grok hook-capture row is the observation, dated, with a falsifier.
- Fail-open unchanged: missing `musterd`/`node`, a dead daemon, or a parse error prints nothing and exits 0.

## Observability & Evaluation

- **Traces:** `inbox.interrupt_check` still records the probe (unchanged endpoint). Dispatcher lines `additional_context=true` (PreToolUse) and `block=true` (Stop) are Grok-side, not musterd traces.
- **Eval:** `packages/cli/src/onboard/harnesses/grok.hooks.test.ts` — PreToolUse wrap, Stop guards, drift, leftover PostToolUse dropped. Baseline is the 2026-09-03 canary session.
- **Experiment / falsifier:** a Grok 1.0.13 `grok -p` whose PreToolUse additionalContext canary is absent from `chat_history.jsonl`, or whose Stop `decision:block` reason does not appear as `synthetic_reason: stop_hook_feedback`, falsifies this ADR. A later Grok release that injects PostToolUse stdout would not reverse this wiring; it would be a new ADR to move back.
