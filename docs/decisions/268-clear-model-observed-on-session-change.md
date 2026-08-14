# 268 — Clear `model_observed` on session-id change

- Status: accepted
- Date: 2026-08-14
- Lane: `01M0145GYB0QQR65CCN8FF5TER`
- Builds on: [ADR 265](265-cursor-cli-capture.md), [ADR 131](131-harness-residency-wake-ledger-host.md) §5, [ADR 158](158-model-attestation-truth.md), [ADR 247](247-documented-discard-is-a-precondition.md)

## Context

ADR 265 made a live `cursor-agent` session visible to the local-session guard by enumerating CLI
`.txt` transcripts. Miley accepted it (#826) after exercising `musterd session show` as `live`. The
residual they refused to leave as a footnote: the roster `model` was still a stopped clock
(`observed_at` from the morning desktop session) because `saveBinding`'s merge-guard treats omit as
preserve, and ADR 265 explicitly did not clear `model_observed` on session-id change.

The capture writers that *can* learn the session changed — `observeCursorSession` (a new
`conversation_id`, or a hook payload that omits it entirely) and `refreshModelObservation` (Cursor
enumeration disagrees with the slot) — had no way to say "there is no observation about *this*
session." Omit is the claim/agent/autojoin shape; the guard restores the on-disk field, which is
correct for those callers and the wrong tool for this one (ADR 247).

A wrong observation remains worse than an absent one (ADR 158, ADR 265). Falling back to declaration
or `unknown` is honest; attesting `grok-4.6` from a desktop session while `cursor-agent` runs
`cursor-grok-4.6-high` is not.

## Problem

`saveBinding` has two intents collapsed onto one encoding:

| Caller | `model_observed` on the argument | Wanted on disk |
| --- | --- | --- |
| `musterd claim` / `musterd agent` / autojoin | omitted (they never read it) | keep the hook's observation |
| capture writer, new session, no new model | omitted (there isn't one) | **clear** the previous session's observation |
| capture writer, new or same session, new model | explicit object | replace (already works) |

The second row is indistinguishable from the first. Cursor CLI is the measured case: hooks often
carry `conversation_id` without `model_id`, or fire `afterMCPExecution` with neither, while
enumeration already knows the live `.txt`. The slot can move and the observation still names the
desktop leftover.

Widening the merge-guard so every omit clears would re-open the ADR 131 claim/agent clobber. Putting
`null` on the protocol schema would be a protocol change this lane does not need.

## Decision

1. **Omit still means preserve.** `saveBinding`'s merge-guard on `model_observed` is unchanged for
   callers that pass nothing. Claim, agent, autojoin, and MCP persist keep working.
2. **Drop is a different intent, at the call site.** `saveBinding(dir, binding, { drop: { model_observed: true } })`
   writes the binding *without* `model_observed`, and does not restore it from disk. Only capture
   writers pass `drop`. The option is not a protocol field; it does not appear in `binding.json`.
3. **`observeCursorSession` drops on conversation-id change without a new model.** A new
   `session_id`/`conversation_id` with no `model_id`/`model` clears the leftover. The same
   conversation without a model still keeps (never-erase *within* a session). A new id *with* a
   model still replaces, unmapped, as ADR 265 already required.
4. **An observe payload with no conversation_id still reconciles.** Returning at `if (!session_id)`
   was the measured no-op that left `observed_at` unmoved. `refreshModelObservation` runs instead,
   using the injected or harness enumerator.
5. **`refreshModelObservation` heals an unended Cursor slot** when enumeration shows a live session
   the slot does not name — the ADR 265 specimen (desktop id, no `ended_at`, live CLI `.txt`). Claude
   stays gated on `ended_at` (live-beside-live co-tenancy is still the wake guard). After that heal,
   if Cursor has no model to parse from the `.txt`, drop the leftover observation. Claude still
   never-erases an unreadable transcript.

Do not scrape `cursor-agent` argv, `clientInfo`, or `state.vscdb`. Do not map CLI model ids. Do not
make `session show` write the slot. Do not change `@musterd/protocol`. Do not weaken MCP's
merge-guard: it has no capture writer that needs `drop`.

## Consequences

- A `cursor-agent` session whose hooks fire *at all* — even without `model_id`, even without
  `conversation_id` — no longer inherits the previous conversation's observation. The roster may
  show `unknown` or a declaration until a later payload carries `model_id`; that is honest.
- If this CLI binary dispatches **no** observe events, the stale observation survives until
  something else calls `refreshModelObservation` (CLI inbox interrupt-check) or a future hook fires.
  Enumeration already makes `session show` read `live`; attestation is a separate writer. This ADR
  does not add an MCP import of CLI session code (package boundary).
- Claim/agent/autojoin continue to omit `model_observed` and continue to preserve it.
- ADR 265's Decision is unchanged; this is the writer-intent change its Consequences named.

## Observability & Evaluation

**Traces.** n/a — local binding write; no new wire fields.

**Eval.** Falsifier: after the fix, `observeCursorSession` with a new `conversation_id` and no
`model_id` leaves `binding.model_observed` undefined; `refreshModelObservation` on an unended
Cursor slot whose enumerated live id differs does the same. Baseline: miley's #826 exercise
(`session show` live, roster `model` still `grok-4.6` / `observed_at` ~11:45).

**Experiment.** n/a — closes a measured lie mode; no A/B.
