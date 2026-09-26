# 455 — A quiet slot is not the current session

- Status: accepted
- Date: 2026-09-26
- Lane: `01M3AM5YMHGAX9EC0R9J1BADYF`
- Relates to: [ADR 158](158-model-attestation-truth.md), [ADR 166](166-session-liveness-by-enumeration.md), [ADR 268](268-clear-model-observed-on-session-change.md)

## Context

Measured 2026-09-24 about 14:15 on the izzo seat (claude-code). The session running was `2a842f1c-3984-4f5c-8822-d1219881917d`. Its transcript's newest assistant turn said `claude-fable-5-1`. `binding.session` still named `957b211e-5d8d-4eaa-abac-6514b408aaa4`, whose transcript was last written at 13:01 and whose newest model was `claude-opus-5-5`. `model_observed` was refreshed at 13:46, so the refresh path did run, and it wrote opus. The roster then showed opus for a session that ran fable.

`binding.session` is written by `musterd session start` (`captureSession`), before the daemon attestation push. A daemon timeout does not skip that write by itself. Two other gates do:

- The interloper gate returns without writing when the occupant still looks live and the new transcript has no turn yet. That write is not retried.
- The tool-boundary heal replaced the slot only when `ended_at` was set, or the harness was cursor. An unended predecessor whose transcript had gone quiet stayed in the slot, and the refresh kept reading it.

A daemon wedge at SessionStart (`CONNECT_TIMEOUT`, the outage behind #1688) is one way the hook never finishes. It is not required. The gate plus an unended quiet slot produce the same binding with the daemon healthy.

## Problem

`refreshModelObservation` trusts `binding.session.transcript_path`. When that path is a previous session, the refresh stamps that session's model as a fresh observation. The roster, and every ADR 101/158 attestation, then records the wrong model. A missing observation falls back to the declaration and says so. A wrong one does not.

The 2026-07-29 constraint still holds: a slot whose own transcript was touched moments ago must not be overridden by whichever neighbour happens to be warm.

## Decision

On the tool-boundary refresh, a slot whose transcript has not been touched within `LOCAL_SESSION_LIVE_MS` (10 minutes), and that enumeration contradicts with a different live session, is healed onto the newest such session. The model is read from that transcript.

A slot whose own transcript is still inside the window is left alone.

When the heal moves the slot and the new transcript has no model yet, `model_observed` is dropped. A re-read of the same session that finds nothing still keeps the prior observation.

An idle session with no other live file is still read from its own transcript.

## Consequences

- For up to 10 minutes after the old transcript goes quiet, the roster can still show the old model. That clock is the one every other liveness read already uses.
- Two sessions both writing inside that window are unchanged. Co-tenancy stays with the wake guard.
- A heal onto a transcript that has no assistant turn yet clears the previous observation instead of carrying it onto the new session.

## Observability & Evaluation

**Traces.** No new span. The instrument is the model already attested on claim and heartbeat. This change is about which file that attestation is read from.

**Eval.** The izzo binding above is the baseline: refresh wrote `claude-opus-5-5` from a transcript 45 minutes quiet while another session was live. `refreshModelObservation` with that shape now writes the live session's model and replaces `binding.session.id`. Pinned in `session.test.ts`.

**Experiment.** In a seat workspace, leave a quiet unended `binding.session` pointing at transcript A and start a claude-code session whose transcript B names a different model. After one tool boundary, `binding.session.id` is B's and `model_observed.model` is B's. If the id is still A's, the heal did not see B as live.
