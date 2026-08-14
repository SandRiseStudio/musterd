# 270 — MCP heartbeat reconciles Cursor capture when observe hooks never fire

- Status: accepted
- Date: 2026-08-14
- Lane: `01M015EHP27D8EE89V6D91NQ02`
- Builds on: [ADR 268](268-clear-model-observed-on-session-change.md), [ADR 265](265-cursor-cli-capture.md), [ADR 158](158-model-attestation-truth.md), [ADR 131](131-harness-residency-wake-ledger-host.md) §5, [ADR 164](164-session-attested-presence.md)
- PR: #846

## Context

ADR 268 gave CLI capture writers a way to drop `model_observed` when a Cursor `conversation_id`
changes and there is no new model. That closes the lie when *any* observe hook fires — even an
empty `afterMCPExecution`. It named its leftover in Consequences:

> If this CLI binary dispatches **no** observe events, the stale observation survives until
> something else calls `refreshModelObservation` (CLI inbox interrupt-check) or a future hook fires.
> This ADR does not add an MCP import of CLI session code (package boundary).

That leftover is the measured path for `cursor-agent` in this harness: MCP `team_*` tools run, the
15s heartbeat re-reads attestation (ADR 158 §7), and `session show` already reads `live` from the
`.txt` (ADR 265). Nothing on the MCP side *writes* capture, so the roster model stays the desktop
leftover (`grok-4.6`, `observed_at` from the morning session) for the whole occupancy.

ADR 268 forbade weakening MCP's merge-guard because MCP had no capture writer that needed `drop`.
This lane is that writer. gptbot asked the follow-up off `session.ts`; it lives here.

## Problem

`refreshAttestation` only re-reads `binding.model_observed`. When no hook updates the file, the
heartbeat has nothing new to say. The adapter cannot import `refreshModelObservation` — only
`@musterd/protocol` crosses package boundaries. Extracting a shared session package is a new runtime
surface this leftover does not need.

MCP `saveBinding` still treats omit as preserve. Without `drop`, a heartbeat that learned "this
session has no observation" cannot say so (ADR 247 / ADR 268).

Writing `binding.session` from the adapter was kept out of ADR 131 to avoid a hook-vs-adapter boot
race. That race needs a competing SessionStart hook. Hookless `cursor-agent` never fires one, so the
adapter is the only writer who can learn the live `.txt`.

## Decision

1. **The heartbeat (and the claim frame that already re-reads attestation) reconciles Cursor
   capture before it re-reads.** `reconcileCursorCapture(bindingDir)` runs, then `refreshAttestation`.
   The tool-call path is unchanged: once occupied, the 15s tick is the boundary that always happens.
2. **Reconcile is Cursor-only.** A `claude-code` or `codex` slot is never stolen, even if a Cursor
   `.txt` exists in the same workspace. Those harnesses have hooks; this leftover is the hookless
   Cursor CLI.
3. **Newest live `.txt` / `.jsonl` wins.** Enumeration uses Cursor's `.workspace-trusted`
   `workspacePath`, walked up with the same binding-file rule as the CLI (never the folder name —
   ADR 166). Among transcripts touched inside 10 minutes (the CLI `LOCAL_SESSION_LIVE_MS` clock,
   copied because the package boundary forbids the import), pick the newest. Heal the slot to that
   id and path when it differs; no-op when the slot already names it. Do not hop to a quieter
   sibling.
4. **A healed-to-new-id Cursor slot drops `model_observed`.** Cursor transcripts have no model to
   parse (ADR 265). Same id still keeps (never-erase within a session). MCP `saveBinding` gains the
   same `{ drop: { model_observed: true } }` option as the CLI; omit still preserves.
   `persistBinding` / autojoin never pass `drop`.
5. **Fail open. Never throw.** An unreadable binding, a missing projects tree (`undefined`, not
   `[]`), or a stat failure leaves the file exactly as it stands. Do not scrape `cursor-agent` argv,
   `clientInfo`, or `state.vscdb`. Do not map CLI model ids. Do not change `@musterd/protocol`. Do
   not import CLI `session.ts`.

The Cursor scan in MCP is a copy of the CLI enumerator, not a shared package. Reconcile tests inject
the enumerator so the heal does not depend on the copy; the copy has its own attribution tests.

## Consequences

- A hookless `cursor-agent` occupancy whose MCP adapter is joined no longer attests the previous
  desktop session's model. The roster may show `unknown` or a declaration until a later hook carries
  `model_id`; that is honest (ADR 158).
- MCP is now a capture writer for Cursor. ADR 268's "MCP has no capture writer that needs `drop`"
  is closed by this Decision; omit-means-preserve is unchanged for every other caller.
- Claude / Codex boot-race protection is unchanged: reconcile returns before enumeration when the
  slot is those harnesses.
- The 10-minute live clock is duplicated in MCP. Drift against `LOCAL_SESSION_LIVE_MS` is a bug;
  do not "fix" it by importing the CLI.
- Extracting `@musterd/session` stays available if a third consumer appears. This leftover does not
  pay that cost.

## Observability & Evaluation

**Traces.** n/a — local binding write; no new wire fields. The heartbeat still re-affirms `model`
when attestation changes (ADR 101); a drop that falls back to declaration or `unknown` is that
existing path.

**Eval.** Falsifier: after the fix, `reconcileCursorCapture` on an unended Cursor slot whose newest
live enumerated id differs leaves `binding.model_observed` undefined and the slot naming the live
`.txt`; a `claude-code` slot in the same fixture is untouched. Baseline: wanderer's #843 leftover
(hookless `cursor-agent`, `session show` live, roster `model` still `grok-4.6`).

**Experiment.** n/a — closes a measured lie mode; no A/B.
