# 207 — Auto-refresh status distinguishes an active tick from a stalled one

- Status: accepted
- Date: 2026-08-03
- Builds on: [ADR 118](118-service-refresh.md) (daemon refresh), [ADR 130](130-build-attestation.md)
  (runtime build identity), and [ADR 201](201-the-auto-refresher-owns-the-bounce.md) (refresh
  ownership and visible failure).

## Context

The auto-refresher writes its attempted-tip stamp before it begins the sync, build, and restart. This
makes a failed attempt durable enough for the next tick to debounce it, but the status surface used
the matching stamp alone to label the daemon as pinned on an old build.

## Problem

While a one-shot refresh tick is still running, the daemon is necessarily behind and its attempted
stamp already matches `origin/main`. The former status logic therefore showed the same warning for a
normal in-progress build and for a completed failed attempt. The warning was technically hedged but
read as a new failure, creating avoidable false alarms immediately after every merge.

## Decision

Consult the installed auto-refresher's launchd status alongside the attempted-tip stamp. A matching
stamp with a running PID reports a calm `refresh in progress` state. A matching stamp without a PID
remains a stalled warning: the debounce has retained evidence of an attempt but no process is still
working to complete it.

## Consequences

- Operators can distinguish routine merge propagation from a pinned daemon without reading logs.
- The failed-refresh warning remains visible once the one-shot tick has exited.
- Status remains best-effort: if launchd state cannot be read, the existing watch/stall fallback
  continues to avoid inventing certainty.

## Observability & Evaluation

- **Traces.** Existing launchd status and `~/.musterd/autorefresh/refresh.log` remain the evidence;
  no new persistent state is added.
- **Eval.** A regression test uses a matching attempt stamp with an active launchd PID and requires
  the in-progress state without a pinned warning.
- **Experiment.** n/a — this exposes already available lifecycle state rather than changing refresh
  policy.
