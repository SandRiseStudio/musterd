# 424 — The `resumable` badge is withdrawn by the first fresh wake after a capture

- Status: proposed
- Date: 2026-09-19

## Context

ADR 131 §5 gave the roster a `resumable` badge beside `wakeable`: the seat attested a capturable harness session (`residency.resumable_at`, pushed by the SessionStart hook), so a wake can continue the seat's own transcript instead of booting cold. The badge's only input is that timestamp, aged against the harness's ~30d GC horizon in two renderers (`packages/cli/src/render/rows.ts`, `packages/web/src/live/RosterPanel.tsx`).

Whether a wake actually resumes is decided on the host, per wake, by the ADR 131 ladder: the transcript must be under the effective `transcript_max_bytes` (256 KiB since the 2026-07-29 recalibration) and inside the GC horizon, and the wake must not be an ADR 209 portable delivery (work orders and handoffs ship `intended_delivery: fresh`). ADR 210's exact-match rung is shipped off.

## Problem

Measured 2026-09-19 (lane 01M2SB89AR, [wiki](../wiki/resume-bound-is-below-one-wake-life.md)): the last resumed wake on this team was 2026-09-14; 0 of the 42 wakes since resumed. A single wake life now weighs 529–1583 KiB — two to six times the bound — because half of the transcript is harness-injected attachment lines and an eighth is musterd's own tool results. The bound was calibrated on 70–80 KiB per life. So no seat can receive a second life on one transcript, and most wakes never consult the transcript at all.

Throughout, every enrolled seat's roster row read `wakeable · resumable`. The badge is computed from the attestation alone, and the attestation is true: a capturable session exists. What the badge *promises* — "a wake continues the seat's own transcript" (the web tooltip's words) — has been false for every wake in five days, and the roster had no way to say so. A reader planning around continuity (a handoff that assumes the seat still holds the thread, a human deciding whether to steer or re-brief) is misled by a label that is technically accurate about its input and wrong about its meaning.

Raising the bound is not the fix: the 07-29 calibration measured a 450 KiB resume at 2.2× a fresh boot and a 3.4 MiB one at 8×. Shrinking the life is its own lane; this ADR is only about the label telling the truth in the meantime.

Follows-up: 01M2XD2WCE20VSBPN51RJWRZX4

## Decision

1. **The daemon withdraws the badge input when the evidence contradicts it.** In the roster projection (`seatWakeabilityFacts`, `packages/server/src/store/residency.ts`), `resumable_at` is emitted as `null` when the seat's most recent `residency.woke` row is newer than the attestation and its `session` axis is `fresh`. A resumed wake, or no wake since the capture, leaves the timestamp as it is.
2. **The enrollment row is untouched.** `residency.resumable_at` keeps the true attestation time; `residency show` and the SPEC enrollment shape do not change. Only the `MemberSummary.resumable_at` the roster carries is affected, and its documented meaning widens from "never captured, or not enrolled" to also "captured, but the last wake since did not resume".
3. **No renderer changes.** Both renderers already treat `null` as no badge, so the CLI and the web roster stop printing `resumable` the moment the daemon stops asserting it, with no protocol field added.
4. **The badge re-arms on the next capture.** A new `musterd session start` push moves `resumable_at` past the last wake, and the badge shows again until a wake proves otherwise. This is the ADR 236 posture: a fresh capture is evidence, a fresh wake is evidence, and the newer one wins.

The audit row's `session` axis has been present on 313 of 313 `residency.woke` rows on this daemon, and it is written by the daemon itself from the wake report, so the derivation needs nothing new from the host. `transcript_bytes` was considered and rejected as the signal: it reaches only a third of `woke` rows (55 of 177 since 09-01), because portable deliveries never read a transcript and the report only carries a size the slot capture measured.

## Consequences

- On this team, every enrolled seat loses the badge today, because every recent wake was fresh. That is the intended outcome, not a regression: the roster says what the wakes did.
- `resumable` now means "the last wake since this capture resumed, or none has been tried" — a claim about observed behaviour, not about the existence of a file. The web tooltip's sentence becomes true again by construction.
- A portable (work-order / handoff) wake also withdraws the badge, though it never tried to resume. Accepted: such a seat's wakes *are* fresh, and a badge that survives them promises continuity the seat's actual traffic does not deliver. When ADR 210's exact-match rung is enabled and a threaded reply resumes, that wake re-arms the badge.
- The two renderers' 30-day freshness check stays; it is a different question (GC horizon) from this one (contradicted by evidence).
- One extra column in an existing `LIMIT 1` audit read per enrolled seat per roster build — the query already ran for the dead-workspace check.

## Observability & Evaluation

- **Traces:** none new. The inputs are the `residency.woke` rows already audited; `musterd status` and `/live` show the outcome.
- **Eval:** falsifier, runnable by hand on any enrolled seat: read its roster row, then wake it with a directed `steer`. If the wake's `residency.woke` row says `session: fresh`, the next `musterd status` must not print `resumable` for that seat; if it says `resumed`, it must. Baseline 2026-09-19: four seats print `resumable`, 0 of their last 42 wakes resumed.
- **Experiment:** when lane 01M2XD2WCE lands a life under the bound, the badge returning on its own for that seat after its first resumed wake is the end-to-end check that both this ADR and that lane did what they said.
