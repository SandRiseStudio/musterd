# 210 — Exact-match local continuity for wake resume

- Status: accepted
- Date: 2026-08-03
- Supersedes: ADR 209 §2's speculative server-only `transcript_required` classification.

## Context

ADR 209 establishes portable context as the normal, fresh-first wake path. The daemon knows an Act's
thread but intentionally never receives a harness session ID, transcript path, or durable
session-to-thread relation. Therefore recency alone cannot prove that a transcript is the dialogue
that the wake is answering.

## Problem

Resume is costly and consumes inherited context. It must be used only when the host can prove an
exact causal match, without weakening the daemon's custody boundary or conflating a Member with one
session.

## Decision

The daemon continues to issue canonical Act/Lane wake orders and may mark a recent directed threaded
reply `resume_eligible`. That mark is permission to consider resume, not a delivery instruction.
Handoff, review, and work-order wakes remain portable/fresh.

Each workspace keeps a gitignored local continuity registry keyed by `(team, seat, thread_id)` and
holding the local harness session ID, transcript path, harness class, and bound/captured timestamps.
It supports multiple bindings and is never sent to the daemon, telemetry, audit, workspace manifest,
or prompt. A successful threaded send binds the current captured session automatically; `musterd
session bind --thread <id>` repairs missing or inherited captures.

The host resumes only when a wake is `resume_eligible` and an exact local binding passes existing
byte, age, rate, and watchdog checks. Missing, stale, mismatched, or unusable bindings select a
fresh wake. A failed attempted resume retains the same-lease fresh fallback. All harnesses implement
the shared binding contract before any harness advertises resume capability.

## Consequences

- Fresh packet + seat memory remain sufficient for every wake.
- The resume path becomes a measured local optimization instead of a server guess.
- Local registry pruning removes bindings for missing/expired transcripts, resolved threads, and
  workspace/team/seat mismatch.

## Observability & Evaluation

**Traces.** `residency.wake_leased` carries the daemon's `resume_eligible` mark;
`residency.woke` and `residency.wake_cost` carry the host's exact-match result
(`bound` / `missing` / `stale` / `mismatched`), the resulting `delivery_outcome`, and non-content
byte/age measurements. No local session ID, transcript path, or workspace path crosses the host
boundary into audit, telemetry, the workspace manifest, or a prompt.

**Eval.** Dataset: wakes marked `resume_eligible` over one dogfood cohort, split by observed
delivery outcome. Baseline: the ADR 209 portable/fresh reply cohort measured under the same wake
kinds. Exact-match resume must lower p50/p95 allowance-equivalent cost per completed reply without a
material increase in failed or duplicate wakes, incorrect replies, or lane completion latency. Byte,
rate, and freshness bounds stay fixed until this comparison has repeated observations behind it.

**Experiment.** Keep the registry off by default and enable it for one workspace cohort first.
Bindings are compared against the fresh path in the same period rather than against the pre-ADR 209
resume ladder, so the registry is measured as an optimization over fresh, not over the ladder it
already replaced. Tests cover multi-session isolation, privacy, pruning, exact-match resume, and the
same-lease fresh fallback.
