# 286 — Launcher surface convergence

- Status: accepted
- Date: 2026-08-19
- Supersedes in part: ADR 282 §4 (writer boundary) and §6 (runtime Surface launch marker)
- Relates to: ADR 026 (harness tool environment), ADR 027 (non-invasive coexistence), ADR 116
  (agent harness selection), ADR 143 (workspace-anchored identity), ADR 281 (multi-harness
  selection), ADR 282 (crash-safe reconciliation)
- Lane: `01M0B1DP6Z4GD249S026VB0368`
- Detailed design:
  [multi-harness worktree selection](../superpowers/specs/2026-08-18-multi-harness-worktree-selection-design.md)

## Context

ADR 282 correctly separated runtime Presence Surface from worktree and provisioning state, but its
launch-marker transition was incomplete. Existing Claude Code, Codex, and Cursor registrations
already inject `MUSTERD_SURFACE`. Giving that variable highest precedence would preserve a stored
registration value as the runtime answer on every already configured machine. The decision would
therefore claim launcher-derived Surface while continuing to derive it from historical provisioning.

The same review found two gaps in the otherwise crash-safe reconciler: recovery is ordered behind
an unspecified lock whose crash behavior is unknown, and strict local schemas constrain readers but
not writers. A strict reader following an unvalidated writer can turn a corrupted local write into a
hard operational failure.

## Problem

Make the new launcher contract real for existing local registrations without reviving legacy runtime
behavior; ensure a stopped reconciler never permanently blocks journal recovery; and make every
persisted local-state write obey the schema that its reader enforces.

## Decision

### 1. `MUSTERD_LAUNCH_SURFACE` is the sole registration marker

External adapter fragments write only `MUSTERD_LAUNCH_SURFACE`. `MUSTERD_SURFACE` is retired as a
registration marker and is never consulted for ordinary launch resolution. A distinct
`MUSTERD_TEST_SURFACE` is the sole deliberate headless/testing override; it is not written by any
adapter. CLI and the native host retain their intrinsic Surfaces. A manually launched external MCP
adapter without `MUSTERD_LAUNCH_SURFACE` or `MUSTERD_TEST_SURFACE` refuses Presence attachment.

This is a runtime compatibility break, not a dual-read path. A registration carrying the retired
marker is reported as `legacy-launch-marker` by `harness status`, never silently used.

Only `musterd harness configure`, after the human confirms the complete desired harness set, may
repair a recognized legacy musterd registration. The repair replaces the retired marker with the
new marker as one fragment-scoped, journaled adapter operation. It preserves unrelated entries and
does not adopt or remove arbitrary equivalent user configuration. `wire` remains non-interactive:
it repairs only version-2 owned fragments and reports an unconverted legacy marker with the
configure command as its next action.

### 2. A container lock is crash-recoverable

`HarnessLocks.acquire(containerKey)` is an inter-process lease, not an in-memory mutex. A lock
record carries an opaque holder id, PID, process-start identity, acquisition time, expiry, and
renewal time. The holder renews before expiry. Acquisition reclaims an expired lease only after
confirming that the recorded PID/process-start identity is no longer live; PID reuse never confers
ownership. Where the platform supplies a crash-releasing advisory file lock, it is held in addition
to the lease record.

Recovery first acquires this recoverable lock. A live, unexpired holder yields `busy` without
mutation; a stopped holder is reclaimed and its journal recovery proceeds. Lock release is best
effort only: expiry and process-liveness validation, not an in-process finally block, guarantee
that a crash cannot permanently strand a journal.

### 3. Writers validate before every local persist

Every write of workspace identity, binding, provisioning manifest, ledger, journal, or lock record
first parses its complete intended object through that object's strict current schema. Only the
parsed value is canonically serialized, fsynced, and atomically published. A validation failure
leaves the previous file and any prepared journal intact and reports the schema issues. Adapter
container writers likewise validate their adapter-owned configuration representation before scoped
replacement.

## Consequences

- Old registrations cannot impersonate a launcher. They are visible, unusable until explicitly
  repaired, and never a silent fallback.
- A one-time confirmed local repair brings a selected existing harness onto the new launcher
  contract; subsequent `wire` and launches remain non-interactive.
- **Rollout.** When this runtime break ships, every existing external registration using the retired
  marker refuses Presence attachment until its worktree's human runs `musterd harness configure` and
  confirms the selected harnesses. Roll out after that explicit per-worktree repair is available;
  do not rely on musterd messaging from an already affected registration to coordinate it.
- A process crash during reconciliation leaves a reclaimable lock and a recoverable journal rather
  than a permanent local deadlock.
- Local writer defects fail before publication, so strict readers receive either the prior valid
  file or a deliberate repair state.

## Observability & Evaluation

**Traces.** `harness status` reports `legacy-launch-marker`, `busy`, reclaimed-lock recovery, and
writer-schema failures with a resource key and repair action but no path, configuration body, or
credential. Provisioning spans record marker generation (`launch`, `test-override`, or `none`) and
lock recovery outcome.

**Eval.** The dataset is every external adapter with a former `MUSTERD_SURFACE` registration, plus
fixtures for a crashed lock holder, a live holder, PID reuse, every local writer schema failure, and
a stop at each lease/journal phase. Baseline ADR 282 treats the former marker as a rank-one override,
leaves lock crash semantics unspecified, and does not require writer validation. Target: a former
marker never attaches a Presence, status names the repair, confirmed configure produces exactly one
`MUSTERD_LAUNCH_SURFACE`, the subsequent launch attaches the adapter Surface, no stranded lock
prevents recovery, and no invalid local object is published.

**Experiment.** n/a — this is a deterministic safety correction, decided by the fixture matrix and
live launcher falsifier rather than user-preference measurement.
