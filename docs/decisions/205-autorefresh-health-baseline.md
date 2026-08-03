# 205 — Auto-refresh reuses its healthy health baseline

- Status: accepted
- Date: 2026-08-03
- Builds on: [ADR 118](118-service-refresh.md) (daemon refresh), [ADR 130](130-build-attestation.md)
  (runtime build identity), and [ADR 192](192-outcome-acceptance.md) (landed outcome acceptance).

## Context

The auto-refresher probes `/health` before deciding whether the daemon is behind `origin/main`. Once
it decides to refresh, the refresh path restarts the daemon and confirms that it answers `/health`
again. The confirmation helper also performed a new pre-bounce health probe to decide whether a short
or long retry budget was appropriate.

## Problem

That redundant pre-bounce probe can transiently miss even though the auto-refresh tick already has a
valid healthy baseline. The verifier then selects its short no-baseline retry budget and can report a
warning while the daemon is still booting normally. This creates false failed-refresh notices and
parks the auto-refresher's evidence in an inaccurate state.

## Decision

Pass the auto-refresh tick's existing `/health` result into the refresh confirmation path. A supplied
baseline establishes that the daemon was up before the bounce, so confirmation uses the full boot
retry budget without probing the daemon a second time. Manual install, restart, and refresh commands
continue to obtain their own baseline and retain their existing fail-open warning when no baseline is
available.

## Consequences

- Auto-refresh no longer converts a transient post-bounce probe miss into a false no-baseline warning.
- A daemon that answered the tick's initial health probe is still treated as down if it fails the full
  post-bounce confirmation budget.
- Manual lifecycle commands retain their distinct behavior when the CLI cannot see the daemon before
  the operation.

## Observability & Evaluation

- **Traces.** Existing refresh output remains the source of truth; successful confirmation reports the
  returned `/health` build as before.
- **Eval.** A regression test simulates a healthy baseline, five transient post-bounce failures, and
  a successful health response; the refresh must complete successfully.
- **Experiment.** n/a — this removes a redundant probe rather than changing a tunable policy.
