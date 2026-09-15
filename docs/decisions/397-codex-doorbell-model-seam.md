# 397 — Codex PostToolUse carries the doorbell into model context

- Status: proposed — 2026-09-15
- Date: 2026-09-15
- Builds on: [ADR 249](249-codex-model-observation-causal-session-evidence.md),
  [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md), and
  [ADR 168](168-repairable-harness-drift.md)
- Evidence: [Codex live-doorbell evaluation](../wiki/codex-live-doorbell-eval.md)
- Lane: `01M2GNZP8NX5X80JSGV7XB1N4V`

## Context

ADR 249 says Codex `PostToolUse` runs the existing low-cost interrupt check. Its shipped handler
does not: `musterd codex-hook post-tool-use --stdin` records `model_observed` and exits without
checking the Inbox or writing model context. The doorbell contract consequently records Codex as
failing its model-reaching seam, while ADR 249 describes that seam as installed.

The measured Codex hook surface accepts one structured `hookSpecificOutput` object whose
`hookEventName` is `PostToolUse` and whose `additionalContext` reaches the active model. Bare
stdout does not. The same evaluation found no idle-prompt delivery; a `Stop` continuation exists,
but has different suppression and turn-ownership properties which have not been designed here.

Codex hook drift is also incomplete. The doctor checks only marker/subcommand substrings, so an
old marker-owned command can pass even when it discards the delivery behavior this decision needs.

## Problem

musterd cannot honestly claim Codex doorbell support while its configured boundary stores local
model evidence but never delivers a raised Act to model context. The doctor also cannot distinguish
that outdated configuration from the supported one.

## Decision

### 1. PostToolUse is the Codex model-reaching seam

After a valid Codex `PostToolUse` event writes its causal `model_observed` value, the same
`musterd codex-hook post-tool-use --stdin` invocation performs the existing authenticated interrupt
read using the bound Member's current Presence lease. When the daemon returns a raised line, stdout
is exactly:

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<daemon-composed line>"}}
```

No raised line, malformed input, absent binding, muted nudge, refused lease, or unreachable daemon
emits output or fails the Codex tool call. The helper is shared with Cursor's hook probe so the two
paths use the same credential, lease, and fail-open rules. It never manufactures a line locally.

This decision does not add `Stop`, `Interrupt`, or an idle rail. Codex remains explicitly deaf while
idle at the prompt. It does not change which Acts the daemon considers interrupt-class, and it does
not create a new protocol field, network endpoint, enforcement path, or wake bypass.

### 2. Codex hook commands become exact, generation-aware doctor evidence

Every marker-owned Codex hook command carries the current `FEATURE_EPOCH` in its marker comment.
The desired hook set is the exact event/type/command tuple rendered by this build. Install and
refresh replace only musterd-owned handlers whose tuple is stale; user handlers remain unchanged.

`inspectCodexHookDrift` compares the installed owned tuple with the current exact tuple. A missing
or older/different tuple directs `musterd init --refresh-hooks`; a tuple stamped with a newer epoch
directs the reader to update this checkout and explicitly forbids a downgrade rewrite. The same
rule applies to the git-common-dir copy that Codex actually reads.

`FEATURE_EPOCH` advances from 19 to 20 for this observable hook capability.

### 3. Evidence remains scoped and honest

Hermetic tests prove quiet output, raised structured output, malformed-input silence, and both
directions of doctor drift. The live evaluation records whether a real Codex run has a callable
musterd tool Surface without a prior discovery step and whether a reconnect changes that result.
It must name its Codex version and may remain `unmeasured` when no authorized real run exists.

## Consequences

- **2026-09-15 — implemented.** `codex-hook post-tool-use` now writes causal model evidence before
  the shared hook interrupt probe and renders only a raised line as Codex `hookSpecificOutput`.
  The desired hook set is exact and epoch-20-stamped; focused tests cover raised/quiet/error output,
  stale/duplicate commands, both epoch directions, user-handler preservation, and git-common-dir
  inspection. The authorized Codex Surface evaluation remains unavailable, not a delivery claim.

- ADR 249's PostToolUse interrupt-check claim becomes true only after the new hook tuple is
  installed; existing installs report drift rather than silently passing.
- A raised interrupt can reach a busy Codex model at its next supported local tool boundary.
- The silent common path remains one local model-observation write plus one bounded read, with no
  model-context tokens.
- Codex remains without idle-prompt delivery, so the doorbell contract must not report a broader
  claim.

## Observability & Evaluation

- **Traces.** Existing `interrupt.raised` / `interrupt.refused` audit evidence remains the source
  of the daemon decision. The hook emits no new telemetry and never logs a lease, Member credential,
  session id, or transcript path.
- **Eval.** The unit control is a quiet probe: stdout must be empty. The treatment is a raised
  daemon line: stdout must be one valid `hookSpecificOutput` object and its context must equal the
  daemon line. Mutation tests that restore substring-only health or remove the Codex formatter make
  the focused tests fail.
- **Experiment.** An authorized disposable real Codex run records version, first-call tool
  callability, and reconnect behavior. It is not a release gate for the hermetic correction; it is
  the live falsifier for the clause-8 row.
