# Cursor-agent live-doorbell eval

Evaluating live-doorbell delivery into a live `cursor-agent` transcript in seconds without identityless injects — measured 2026-09-03 on `cursor-agent` 2026.09.02-c22c1a3 against wanderer's request (lane `01M1MFD7PW9TM5JNHWW2J1PC9J`).

## Why this page exists

Wanderer asked schmidt (request_help `01M1MC25KRF0077NT630JHTQ3V`) to evaluate how to get a doorbell into a LIVE `cursor-agent` CLI transcript in seconds (model sees it), mirroring Grok lane `01M1MC0M6M8RWV6RQFRPASNVQD`.

The inquiry spans four checks:
1. Documented peer inject (analogous to Claude Code Desktop's `ccd_session_mgmt` `send_message`).
2. Reach of `PostToolUse` vs `afterShellExecution` / `afterMCPExecution` interrupt stdout (does it reach the model or only the terminal?).
3. Stop-hook or equivalent that can feed a composed line and continue the turn with loop guards.
4. Idle-at-prompt coverage without writing transcripts or TTY stdin.

## Findings summary (2026-09-03)

| Check | Capability / Seam | Measured verdict | Model reach |
| --- | --- | --- | --- |
| 1. Peer inject | `send_message` / session push | **none** — no peer session injection API exists | n/a |
| 2a. PostToolUse | `additional_context` stdout | **yes — measured live** | **yes** (reaches model prompt context) |
| 2b. afterShellExecution | stdout injection | **no** — stdout discarded (fire-and-forget) | **no** (silent drop) |
| 3. Stop-hook continuation | `stop` hook `followup_message` | **yes** — continues turn; default `loop_limit: 5` | **yes** (submits next user turn) |
| 4. Idle at prompt | no active turn, waiting for input | **none in-transcript** (honest boundary) | needs OS notify or human prompt |

---

## Check 1 — Documented peer inject: none

Claude Code Desktop provides `mcp__ccd_session_mgmt__send_message` ([ADR 167](../decisions/167-harness-native-session-messaging.md)), enabling an active desktop session to push a message into another session on the same machine.

Across Cursor Desktop and `cursor-agent` CLI:
- **No peer session messaging tool or API exists.** Neither Cursor IDE nor `cursor-agent` CLI exposes an MCP tool or CLI command to send a message into another running session.
- `cursor-agent create-chat` creates an empty chat and returns its ID; `cursor-agent resume [id]` or `agent --continue` resumes a chat on startup; neither pushes into a running session.
- Headless Agent Client Protocol (`cursor-agent acp`) exposes `session/prompt` over stdio JSON-RPC, but this is a parent-controller protocol for external harnesses, not an inter-session peer rail.
- Subagents (`Task` tool) execute in a child context and report back to their parent; they do not provide peer-to-peer messaging between independent seats.

> Cursor provides no documented peer-injection API (2026-09-03; falsify: discover an MCP tool, CLI command, or local RPC endpoint that allows one Cursor session to push text into another active session's conversation).

---

## Check 2 — Interrupt reach: PostToolUse reaches model; afterShellExecution does not

We measured both hooks live under `cursor-agent -p` (version 2026.09.02-c22c1a3) on macOS:

### 2a. `postToolUse` — reaches model prompt context

When a `postToolUse` hook exits 0 and emits JSON:
```json
{"additional_context": "Doorbell notification: ZEBRA is ready"}
```
- **Live measurement:** Prompted `cursor-agent` to execute a shell tool call, then report whether the keyword `ZEBRA` appeared in context. Result: the model immediately reported `FOUND IT`.
- **Mechanism:** Cursor's hook engine parses stdout from `postToolUse` and appends `additional_context` into the model's working prompt context for subsequent turns.
- **Status in musterd:** [ADR 369](../decisions/369-cursor-gate-and-interrupt-hooks.md) already wired this seam: `packages/cli/src/onboard/harnesses/cursor.ts` installs `postToolUse` with `musterd session observe --stdin --interrupt`, which outputs `{"additional_context": res.line}` when an interrupt is raised.

### 2b. `afterShellExecution` and `afterMCPExecution` — discarded by Cursor

When an `afterShellExecution` hook emits JSON:
```json
{"additional_context": "Doorbell notification: ELEPHANT is ready"}
```
- **Live measurement:** Prompted `cursor-agent` with the exact same test for `ELEPHANT` via `afterShellExecution`. Result: the model reported `NO ELEPHANT`.
- **Mechanism:** In Cursor's architecture, `afterShellExecution` and `afterMCPExecution` are purely observational fire-and-forget hooks. Cursor reads the exit code for errors but discards stdout entirely.
- **Clarification on ADR 268:** [ADR 268](../decisions/268-clear-model-observed-on-session-change.md) addressed clearing `model_observed` in `binding.json` when session IDs change without a new model; it was not a harness-level transcript drop.

> `postToolUse` stdout `additional_context` enters the model prompt; `afterShellExecution` stdout is dropped (2026-09-03; falsify: an `afterShellExecution` stdout injection witnessed inside model context).

---

## Check 3 — Stop-hook continuation: native `stop` hook with loop limit

Cursor includes a native `stop` hook (and `subagentStop` for child tasks) that fires when an agent turn ends (`status`: `"completed" | "aborted" | "error"`).

### Capabilities
- **Stdin:** Receives `{ status, loop_count, conversation_id, ... }`.
- **Stdout:** Emitting JSON:
  ```json
  {"followup_message": "musterd doorbell: ask 01M1... waits. Run team_inbox_check."}
  ```
  causes Cursor to submit the message as a new user turn, continuing execution autonomously.
- **Loop guards:**
  - Cursor tracks `loop_count` (0-indexed count of consecutive follow-ups).
  - Built-in safety cap: `loop_limit` in `.cursor/hooks.json` defaults to **5** (can be configured or set to `null`).
  - The hook script can also check `inbox --interrupt-check` and emit `{}` (silent exit 0) when no interrupt waits, halting the turn cleanly.

### Proposed doorbell role
If an urgent act arrives during a turn and the agent does not invoke another tool before completing, the `stop` hook intercepts completion at turn-end and injects a continuation turn before the agent can go idle.

> Cursor's `stop` hook can block turn-completion and continue execution via `followup_message` under a `loop_limit` guard (2026-09-03; falsify: verify whether `stop` with `followup_message` fails to trigger a follow-up turn in interactive `cursor-agent`).

---

## Check 4 — Idle-at-prompt coverage: honest boundary

When an interactive `cursor-agent` session has finished all turns and sits idle waiting for the human to type:
- There is no `onIdle` hook in Cursor.
- Writing directly to `.txt` transcripts or injecting into TTY stdin is rejected (identityless, fragile, unattributed, violates musterd design rules).
- Because there is no peer inject (Check 1), in-transcript peer delivery to a session already resting idle at the prompt is unsupported without an external trigger.
- Coverage at idle relies on:
  1. **OS / desktop notification:** `musterd notify` alerting the human driver.
  2. **Next human interaction:** As soon as the user enters a prompt, `beforeSubmitPrompt` / `sessionStart` / `postToolUse` observe and interrupt.
  3. **Headless / unattended wake:** The host loop waking an unattended seat via session resume / launch (ADR 131).

This matches the honest boundary documented for Grok CLI in ADR 352 / lane `01M1MC0M6M8RWV6RQFRPASNVQD`.

## Related

- [Driver support matrix](driver-support-matrix.md) — observed feature matrix across harnesses and drivers.
- [Harness statusline seams](harness-statusline-seams.md) — survey of UI slots across harnesses.
- [ADR 369](../decisions/369-cursor-gate-and-interrupt-hooks.md) — Cursor PreToolUse gate and PostToolUse interrupt parity.
- [ADR 167](../decisions/167-harness-native-session-messaging.md) — Claude Code Desktop `ccd_session_mgmt` peer messaging.
