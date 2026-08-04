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
- 2026-08-03 rollout: shipped **off**. `residency.exact_match_resume` defaults false, so the daemon
  marks nothing eligible and every wake stays on ADR 209's portable/fresh path. No numeric bound was
  tuned; the binding horizon reuses the existing `RESUME_GC_HORIZON_MS`, past which a resume would
  fail anyway. **The Eval comparison below has not run** — it needs an ADR 209 fresh-path baseline
  that does not exist yet, since that path merged the same day. No cost or byte figures are recorded
  here because none have been measured.
- **The all-harnesses precondition, restated 2026-08-04.** The original blocker recorded here — that
  no Codex hook path existed, so a Codex seat could never hold a binding — **is resolved**, but not
  the way it was written. ADR 216 landed a Codex CLI residency backend that is _its own harness
  authority_ and writes `binding.session` directly rather than through a hook, so a Codex seat does
  now produce the capture the registry fills from. The lane that named the hook gap is still open and
  is about a narrower thing (Codex model/surface attestation); it is no longer what gates this ADR.
- **The precondition is still unmet, for a different and sharper reason.** `codex.ts` resumes on its
  slot capture unconditionally: it consults neither `intended_delivery` nor `resume_eligible`. While
  `residency.exact_match_resume` is off this is inert, because nothing is ever marked eligible. But
  flipping that switch on today would hand a Codex seat an eligible threaded wake and have it resume
  a session with **no proof that session holds that thread** — precisely the causal guess this ADR
  exists to forbid, reintroduced on the one harness that does not implement the gate. Therefore:
  **`exact_match_resume` must not be enabled until the Codex backend routes eligible wakes through
  the same exact-match rung** (`packages/cli/src/host/backends/**` is another seat's surface, so this
  is recorded and raised rather than patched here). Claude Code implements the gate as of this
  increment; Codex does not; resume capability stays unadvertised until it does.
- Thread resolution is daemon knowledge, so the host prunes resolved threads only when a caller
  supplies them. The two conditions the host can check itself — missing transcript, past horizon —
  are checked against the real filesystem on every bind and on session end.

## Observability & Evaluation

**Traces.** `residency.wake_leased` carries the daemon's `resume_eligible` mark;
`residency.woke` and `residency.wake_cost` carry the host's exact-match result
(`bound` / `missing` / `mismatched` / `stale`), the resulting `delivery_outcome`, and non-content
byte/age measurements. No local session ID, transcript path, or workspace path crosses the host
boundary into audit, telemetry, the workspace manifest, or a prompt.

_Landed 2026-08-04._ The exact-match result was specified here from the start but **not emitted** by
the increment that shipped the rung: `WakeReportBody` carried only `delivery_outcome`
(`fresh` / `resumed` / `fresh_fallback`), which says what happened and never why — so an eligible
wake that spawned fresh was indistinguishable from one that was never eligible, and the Eval below
could not be run at all. `exact_match` now rides every outcome the wake produces and both audit
rows. It is absent exactly when the order was not `resume_eligible`, so absence is meaningful rather
than missing data. The four values partition the rung: `bound` is the only one implying a resume was
attempted; the unusable-hit cases collapse into `stale` on purpose, because the distinction that
matters to the Eval is bound-vs-not and splitting it four ways would invite tuning the bounds on
noise (the precise cause still reaches the operator in the host log).

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
