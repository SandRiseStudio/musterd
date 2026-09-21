# 427 — The resume hygiene bound judges the conversation, not the file

- Status: proposed
- Date: 2026-09-21

## Context

ADR 131 §5 gives a wake a hygiene clause: the host prefers `--resume` for continuity but rolls over to a fresh session when the transcript is bloated, because past some size a resume spends more re-ingesting history than a fresh boot costs. The clause is a **cost crossover**. Its implementation (`RESUME_TRANSCRIPT_MAX_BYTES`, `packages/cli/src/host/backends/claudeCode.ts`) gates all three rungs of the ladder — the ADR 210 exact-match rung, the slot rung, the ADR 166 enumerated rung — on `stat().size` of the transcript file, against the policy's `transcript_max_bytes` (256 KiB since the 2026-07-29 recalibration, which bracketed the dollar crossover at 373–450 KiB of file on transcripts that were, then, ~70–80 KiB per life and almost entirely conversation).

The file stopped being the conversation. A Claude Code transcript also records `attachment` lines — the harness's snapshot of its own system prompt, its deferred-tool and MCP-instruction deltas, skill listings, output-style reminders — plus hook records and cost/queue bookkeeping. None of it is re-read into the model's context on resume; it is written so the file is self-describing. Lane 01M2SB89AR found every enrolled seat's transcript over the bound (0 resumed wakes in 42, 2026-09-15..18); lane 01M2XD2WCE measured why and landed ADR 426, which halved the file by dropping the human's user settings layer from wake spawns.

## Problem

The acceptance measurement for ADR 426 (2026-09-21, two seats woken cold; [wiki](../wiki/resume-bound-is-below-one-wake-life.md)):

| seat  | file on disk | `user`+`assistant` records | context at end of life | verdict today |
| ----- | ------------ | -------------------------- | ---------------------- | ------------- |
| dolly | 283.5 KiB    | ~94 KiB                    | 46.8k tokens           | refused       |
| miley | 339.8 KiB    | ~146 KiB                   | 57.8k tokens           | refused       |

45% of each file is attachment metadata. The ladder refuses a ~47k-token resume — well inside the cheap region the 07-29 table measured — because a number it never meant to bound crossed a threshold calibrated in a different unit. The consequence is the one ADR 424 had to paper over: the roster's `resumable` is withdrawn on evidence because no wake ever resumes, and every wake pays the full fresh boot (ADR 426's $0.23 floor, plus re-orientation) for continuity it could have had for the price of re-reading 94 KiB.

Raising the number does not fix this: it would admit the file's metadata as if it were cost, and the 07-29 measurements of a $2.53 resume at 450 KiB stand. Shrinking the file further is not musterd's to do: what remains after ADR 426 is the harness's own scaffolding.

## Decision

1. **The hygiene rung judges the resume weight — the bytes of a transcript's `user` and `assistant` records — against `transcript_max_bytes`.** That is what `--resume` replays. `resumeWeightBytes(path)` lives in `packages/cli/src/session/transcript-model.ts`, the one module that already knows the transcript's on-disk shape, and returns `undefined` when the file cannot be read or no line parses.
2. **A file at or under the bound is admitted without a read.** Its conversation cannot outweigh it, and the scan already paid for the stat. Only a file over the bound is weighed, so the common case costs nothing new.
3. **A file that cannot be weighed is judged as the file.** `undefined` from the weigh falls back to `stat().size`, which refuses; the ladder never grants a resume on a guess. The skip line then reads exactly as before this ADR.
4. **The bound's number does not change.** 256 KiB was calibrated as a cost crossover on transcripts that were almost entirely conversation; in the unit this ADR restores, that calibration still holds. Retuning it is a separate, measured decision.
5. **The wake report carries the judgement.** `WakeReportBody.resume_weight_bytes` (optional, `HostMeasuredCount`, protocol change gated by this ADR) rides beside `transcript_bytes` whenever the host weighed the file, and is absent when it did not — the report never claims a measurement it skipped. The daemon stores it on the `residency.woke` audit detail with the other delivery measurements.
6. **All three rungs share one judgement** (`judgeHygiene`): exact-match, slot and enumerated. The enumerated judgement now names its newest transcript's `path` so the rung can weigh it rather than only read the size the scan recorded. The skip text for a weighed refusal names both numbers: `transcript is 449.8 KiB on disk, 293 KiB of conversation (hygiene bound 256 KiB)`.

Codex, OpenCode, Cursor and Grok backends are unchanged: none of them applies a transcript bound today.

## Consequences

- A post-ADR-426 wake life (284–340 KiB on disk, 94–146 KiB of conversation) is under the bound and resumes. The measurement of a real resumed wake — its `residency.woke` row, cost against the 07-29 fresh range — is lane 01M32FGSXK's acceptance evidence, recorded on the wiki page.
- The ~3 lives of continuity the 07-29 recalibration aimed for become reachable again in principle; how many a seat actually gets is now a question about conversation volume, which is the right question.
- A long interactive session (miley's newest transcript was 5.6 MiB) is still refused when its conversation is genuinely large; this ADR does not admit bloated chains, it stops refusing thin ones.
- One additional full read of a transcript per wake decision, only when the file is over the bound; a 5.6 MiB file parses in tens of milliseconds and the decision is not on the spawn's critical path.
- Transcript resume remains inherently per-harness. This ADR revives it on Claude Code. The harness-independent continuity a seat needs to be reachable on any harness is goal `seat-continuity` increments 3–5 (`docs/superpowers/plans/2026-09-21-seat-continuity.md`), not this ADR.
- ADR 131 gains a dated note under "Append + context hygiene"; SPEC.md's wake-report paragraph names the new field.

## Observability & Evaluation

- **Traces:** every `residency.woke` audit row carries `resume_weight_bytes` beside `transcript_bytes` whenever the host weighed the file; the host log's skip line names both numbers on a weighed refusal (`… 449.8 KiB on disk, 293 KiB of conversation (hygiene bound 256 KiB)`). Absent `resume_weight_bytes` on a row means the file was at or under the bound and was never read.
- **Eval:** `select session, count(*), avg(json_extract(detail,'$.transcript_bytes')), avg(json_extract(detail,'$.resume_weight_bytes')) from audit where action='residency.woke' group by session` splits resumed from fresh and file from conversation. The 07-29 table re-run in the restored unit: resumed wakes' `cost_usd` against the fresh range, joined to `resume_weight_bytes`. Falsifier: no `residency.woke` row with `session: resumed` within a week of enrolled seats waking after this lands means another rung is refusing and this ADR's premise is wrong; a resume under 256 KiB of conversation costing more than the fresh range means the number needs retuning, not the unit.
- **Experiment:** lane 01M32FGSXK's acceptance — wake two enrolled seats after the daemon and host carry this, confirm `session=resumed` in `host.log` and on the row, record the cost on the wiki page beside the 2026-09-21 fresh costs ($0.43 dolly, $0.66 miley). ADR 424's `resumable` badge re-arming on that row is the roster's own check.
