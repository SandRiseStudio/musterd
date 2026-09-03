# Codex live-doorbell evaluation

Observed 2026-09-03 on this machine with `codex-cli 0.152.1`. This is an
environment evaluation, not a wire contract or implementation plan.

## Question

Can a Codex seat receive a directed Act while it is working, continue after a
turn ends, or be injected while idle?

## Findings

| Need | Verdict | Evidence |
| --- | --- | --- |
| Peer inject into a running session | No external push seam found | Codex's hook lifecycle is local to the session. `queue` can target an existing session, but it is an explicit Codex CLI operation, not an in-transcript peer-delivery interface. |
| Mid-turn interrupt at a tool boundary | Yes | `PostToolUse` runs after supported local tools. Plain stdout is ignored; JSON `hookSpecificOutput.additionalContext` is added as developer context. A hook can return `continue: false` to replace the original tool result with its feedback. |
| Prompt-bound context | Yes | `UserPromptSubmit` plain stdout is added as developer context; JSON `additionalContext` is equivalent. Current musterd wiring already uses this event for `musterd session orient-nudge`. |
| Turn-end continuation | Yes | A `Stop` hook returning `decision: "block"` with a reason causes Codex to create a new continuation prompt using that reason. This is the direct native analogue of a turn-end doorbell, rather than a `followup_message` field. |
| Idle-at-prompt delivery | No (observed 2026-09-03) | A completed background hook waits for the next user turn when no turn is active; it does not begin a new turn (2026-09-03). `Interrupt` likewise does not run for idle threads. Falsifier: a hook completion begins a new Codex turn without a user prompt or an explicit wake. |

## Current musterd gap

`packages/cli/src/onboard/harnesses/codexHooks.ts` installs
SessionStart, SessionEnd, PostToolUse, and UserPromptSubmit. Its PostToolUse
handler records model observation only and emits no output, so musterd has no
mid-turn interrupt delivery today even though Codex provides the seam. It
installs no Stop handler, so it has no native turn-end continuation either.

## Recommendation

Treat Codex as capable of both a structured PostToolUse interrupt and a Stop
continuation. A future change should add marker-owned handlers only after an
ADR specifies: bounded urgent/acceptance selection, the JSON output shape for
PostToolUse, the Stop continuation reason, loop suppression, and a live
falsifier. Do not claim idle push capability.

## Sources

- Local command: `codex --version` reported `codex-cli 0.152.1`; `codex features list` reported hooks stable.
- [Codex Hooks documentation](https://developers.openai.com/codex/hooks), consulted 2026-09-03: lifecycle events, PostToolUse output, UserPromptSubmit context, Stop continuation, and idle background-hook behavior.
- ADR 333: existing SessionStart and UserPromptSubmit orientation wiring.
- `packages/cli/src/onboard/harnesses/codexHooks.ts` and `packages/cli/src/commands/codexHook.ts`: installed handlers and current no-output PostToolUse implementation.
