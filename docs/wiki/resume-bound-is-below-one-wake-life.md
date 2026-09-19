# The resume hygiene bound is below one wake life — so "resumable" promises continuity no seat can receive

A wake's own transcript weighs 2–6× the 256 KiB `transcript_max_bytes` bound by the time the wake ends, so the ADR 131 resume ladder can never admit a second life on the same transcript; every wake since 2026-09-14 has been a cold fresh spawn.

## What the ledger says (2026-09-19; falsify: `sqlite3 ~/.musterd/musterd.db "select max(strftime('%Y-%m-%d', ts/1000, 'unixepoch')) from audit where action='residency.woke' and detail like '%resumed%'"` — a later date than 2026-09-14 falsifies this) <!-- claim: defect -->

`residency.woke` rows by session axis: resumed wakes did happen — 25 across 09-01..09-04, the last one on 09-14 — and 0 of the 42 wakes from 09-15 through 09-18. The host log (`~/.musterd/host.log`, no timestamps, so line order only) shows 122 wakes after its last `session=resumed` line.

## Three causes, ranked — and the first one is not a defect (2026-09-19; falsify: re-run the tally in the host log) <!-- claim: other -->

Tallied over the host log after its last resumed wake:

| reason logged                                               | count | what it is                                                                                                              |
| ----------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `portable delivery … fresh spawn (resume bypassed)`         | 109   | ADR 209 by design: work-order and handoff wakes ship `intended_delivery: fresh`, which bypasses the transcript ladder entirely              |
| `resume skipped … newest transcript is N (hygiene bound …)` | 43    | ADR 131 §5 hygiene clause: the ladder found a transcript and it was over `transcript_max_bytes`                          |
| `resume failed for gptbot (thread id missing or mismatched)` | 3     | ADR 210 exact-match rung on the Codex backend                                                                            |

The lane that named this ("every enrolled seat's transcript outgrew the bound") named the second row. The first row is larger and is policy, not breakage: `portable_inbox_replies` defaults false, so only work orders and handoffs are portable, and those are fresh on purpose. A roster that reads `wakeable · resumable` for a seat whose wakes are mostly work orders is describing a path most of its wakes do not take.

## The bound is below one life (2026-09-19; falsify: `stat -f %z` the newest transcript in any wakeable seat's `~/.claude/projects/-Users-nick-agents-<seat>/` whose first user prompt begins `musterd wake —`; one under 256 KiB after a completed wake falsifies this) <!-- claim: defect -->

`RESUME_TRANSCRIPT_MAX_BYTES` was recalibrated on 2026-07-29 (comment in `packages/cli/src/host/backends/claudeCode.ts`) from 10 MiB to 256 KiB on a measured 70–80 KiB per life, i.e. "~3 lives of continuity". Measured 2026-09-19, single-life wake transcripts (exactly one top-level user prompt beginning `musterd wake —`):

| when         | seats               | one life weighs    |
| ------------ | ------------------- | ------------------ |
| 09-03..09-06 | ryder, dolly        | 68–472 KiB         |
| 09-14..09-17 | dolly, miley, ryder | 529–1583 KiB       |

Every skipped-size figure in the log is consistent: 125 skips, min 262 KiB, median 773 KiB, p75 2.1 MiB. So the ladder is not failing on bloated *chains*; it is failing on the first life. There is no bound-and-response tuning that gives ~3 lives at 256 KiB when one life is 700 KiB.

Where the bytes are, one 802 KiB dolly life (09-17): 385 KiB `attachment` lines (harness-injected context — `skill_listing` 76, `deferred_tools_delta` 66, `hook_success` 52, `prompt_snapshot` 51, `mcp_instructions_delta` 41, `output_style` 24), 268 KiB `user` lines of which tool results are 103 KiB (`lane_board` 45, `team_inbox_check` 30, `Bash` 28), 138 KiB `assistant`. The transcript is mostly what the harness and musterd hand the model, not what the model said. A `lane_board` call with no filter returned 394 KB on 2026-09-19 (this seat, one call).

## What this does NOT say (2026-09-19)

- It does not say raise the bound. The 07-29 calibration measured a resume at 450 KiB costing 2.2× a fresh boot and one at 3.4 MiB costing 8×; a bound that admits today's lives admits those costs. The bound may be right and the life wrong.
- It does not say the wake-failure rate is related. Transcript size is not on a fresh spawn's critical path (retracted 2026-09-18 in lane 01M2SB89AR's evidence).
- `~/.musterd/host.err.log` "pre-ADR-281 v1 binding" lines for dolly are stale; her binding is version 2. Read the file, not the log about the file.

## The open call (2026-09-19, lane 01M2SB89AR)

~~Open as of 2026-09-19 morning.~~ DECIDED 2026-09-19 by nick: both. The label half is [ADR 424](../decisions/424-resumable-label-honest.md) — the daemon withdraws the roster's `resumable_at` once a `residency.woke` row newer than the capture says `session: fresh`, and the next capture or a resumed wake re-arms it; no renderer or protocol field changes. The life-size half is lane 01M2XD2WCE, unowned. Falsify the label fix: `musterd status` on an enrolled seat whose last woke row is `fresh` must not print `resumable`.

Either the roster stops saying `resumable` while the effective policy cannot honour it (the host already reports `transcript_bytes` on every wake report, so the daemon can know), or a lane goes after the life size — attachments and musterd's own tool-result volume — which is the only path that makes resume real again. Both are ADR-gated: the first changes a label ADR 131 defines, the second changes what the harness injects. Related: [wake leases](wake-leases.md), [which acts wake a seat](which-acts-wake-a-seat.md).
