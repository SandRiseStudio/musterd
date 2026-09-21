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

## Where the bytes come from, and the one flag that removes a third of them (2026-09-19, lane 01M2XD2WCE; falsify: rerun the A/B below in any seat worktree) <!-- claim: other -->

Twelve single-life wake transcripts, averaged: `hook_success` 110 KiB (~140 records per life, 687 bytes each even when the hook printed nothing — `hookify`, `security-guidance` and `cognee` run on every Bash call), `skill_listing` 68, `prompt_snapshot` 47, `deferred_tools_delta` 47, `output_style` 35 (re-attached every turn), `mcp_instructions_delta` 33, `total_tokens_reminder` 30 (every turn), `hook_additional_context` 26. Tool results: `Bash` 53 (42 calls), `team_inbox_check` 23 (13 KiB per call), `Read` 9, `lane_board` 7. Of the total, 195–362 KiB per life traces to the human's *user* settings layer — plugins and output style — and 3–15 KiB to musterd's own hooks.

The transcript overstates the model's context: those lives ended at 54k–190k context tokens for 459–1583 KiB, about 8 bytes per token, because hook records and reminders are transcript metadata the model never sees.

A/B, one prompt, no tool call, this worktree: default argv → 383 KiB transcript, 58,727 context tokens created, $1.52. `--setting-sources project,local` → 182 KiB, 22,487 tokens (+10k cache read), $0.23. The musterd MCP server (keyed by repo root in `~/.claude.json`, not a settings layer), the worktree's 21 committed skills, and the project-local hooks all survived; the eleven claude.ai connector servers also survived, being account-level. So an *empty* life under the old argv was already 1.5× the bound. [ADR 426](../decisions/426-wake-loads-project-settings-only.md) puts the flag on every wake spawn. What a *working* life weighs after it is the lane's acceptance measurement, taken below.

## What a working life weighs after ADR 426: 284–340 KiB — the flag cut 2–4× and still cleared nothing (2026-09-21, lane 01M2XD2WCE; falsify: wake any two enrolled seats and `stat -f %z` the transcript whose first user prompt begins `musterd wake —`; one under 256 KiB falsifies the "still over" half) <!-- claim: defect -->

The acceptance measurement owed above. Two seats woken 2026-09-21 16:55Z by one `steer` each (leases `01M32E9Q8V20SVC6D7Q550KA16`, `01M32E9Q9EJ1ZEKS30G8YEDW8C`), both `session=fresh provenance=wake`, both settled `exit=0` — dolly 16.8s/$0.43, miley 36.6s/$0.66. Each ran a normal orientation: `team_wake_context`, `team_inbox_check`, `team_memory_read`, a `status_update`, and stopped. Single-life transcripts, one top-level `musterd wake —` prompt each:

| seat  | one life   | records | over the 256 KiB bound by |
| ----- | ---------- | ------- | ------------------------- |
| dolly | 283.5 KiB  | 48      | 27.5 KiB (1.11×)          |
| miley | 339.8 KiB  | 66      | 83.8 KiB (1.33×)          |

Against the 529–1583 KiB pre-flag lives in the table above, the flag is worth roughly 2–4×. It is not worth the bound. **A post-ADR-426 wake still cannot be resumed (2026-09-21; falsify: a `residency.woke` row whose `session` is `resumed` and whose date is later than 2026-09-14), so the resume ladder still admits zero lives** — the lane's stated bar (one life under 256 KiB on two seats) is **missed on both seats**. <!-- claim: defect -->

The flag did do what [ADR 426](../decisions/426-wake-loads-project-settings-only.md) said it would, which is worth separating from the bar it failed to clear. The user settings layer is gone from the wake: the skill listing is 20 skills / 7.5 KiB (was ~68 KiB averaged) and contains no `superpowers:` or `cognee-memory:` entry; `hook_success` is 3.1 KiB across 3 records (was ~110 KiB across ~140), and all three are musterd's own project hooks. Both of the big user-layer line items named above are closed.

What is left is not mostly musterd's, and that is the finding:

Follows-up: 01M32FH5YQD4EVTG6ARSS0S0SG

| where the 284 KiB goes (dolly)                 | KiB   | whose         |
| ---------------------------------------------- | ----- | ------------- |
| `prompt_snapshot` ×2                            | 62.5  | harness       |
| `deferred_tools_delta` ×1                       | 36.5  | harness       |
| `mcp_instructions_delta` ×1                     | 29.8  | harness + MCP servers |
| `skill_listing` ×2                              | 19.9  | project       |
| `instructions` (CLAUDE.md + AGENTS.md)          | 11.1  | project       |
| all other attachments (17 types)                | 25.7  | mixed         |
| tool results — `team_inbox_check`               | 26.0  | **musterd**   |
| tool results — `team_memory_read`               | 3.5   | **musterd**   |
| tool results — other musterd calls              | 0.9   | **musterd**   |
| assistant text + thinking + tool calls          | 2.4   | the model     |

129 KiB — 45% of the life — is three harness attachments that exist before the seat does anything: two snapshots of the system prompt and the tool and MCP schema text. A wake that made *no* tool call at all would still weigh ~190 KiB, which is 74% of the bound spent on arriving.

Musterd's own controllable share is now 30 KiB of tool results, and `team_inbox_check` is 26 of it — a single call, on a seat that has read nothing new, because the call returns the same ancient directed backlog every time and ignores its `limit` argument (8.5k elided unread on this team, oldest 2026-07-14). Removing that one call's weight puts dolly under the bound with 1.5 KiB to spare and leaves miley 57 KiB over. So it is a necessary lever and not a sufficient one: the remaining path to a resumable life runs through what the harness injects, not through musterd.

## The bound was measuring the wrong unit — a 284 KiB file is a 47k-token conversation (2026-09-21, lane 01M32FGSXK; falsify: `python3` over the same two transcripts summing `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the last assistant record — a figure over 100k for either falsifies "cheap") <!-- claim: other -->

Read from the last assistant record's `usage` in each 2026-09-21 wake life: dolly ended at **46,824** tokens of context (283.5 KiB file), miley at **57,752** (339.8 KiB). The `user`+`assistant` records — what `--resume` replays — are ~94 and ~146 KiB. The rest is the attachment metadata tabled above, written so the file is self-describing and never re-read. The 07-29 calibration bracketed the dollar crossover at 373–450 KiB of *file* on lives that were ~70–80 KiB and almost entirely conversation; the ladder then inherited a byte threshold whose meaning the file quietly changed underneath it. So "a post-ADR-426 wake still cannot be resumed" above is true of the code and false of the cost (2026-09-21; falsify: a resumed wake of either life costing more than the $0.91–1.51 fresh range in the 07-29 table): both lives are inside the cheap region. <!-- claim: other -->

[ADR 427](../decisions/427-resume-bound-gates-on-message-bytes.md) makes the rung judge the replayed bytes, leaves the number alone, and reports `resume_weight_bytes` beside `transcript_bytes` so the eval can split them. Whether a real wake then resumes — and what it costs against the fresh range — is that lane's acceptance evidence, owed on this page.

This also reframes the goal. Transcript resume is per-harness by construction (Claude Code resumes a jsonl, Codex a thread id, and the Codex rung already fails "thread id missing or mismatched"), so reviving it on one harness is increment 1 of five, not the answer: goal `seat-continuity`, plan `docs/superpowers/plans/2026-09-21-seat-continuity.md`.

## The open call (2026-09-19, lane 01M2SB89AR)

~~Open as of 2026-09-19 morning.~~ DECIDED 2026-09-19 by nick: both. The label half is [ADR 424](../decisions/424-resumable-label-honest.md) — the daemon withdraws the roster's `resumable_at` once a `residency.woke` row newer than the capture says `session: fresh`, and the next capture or a resumed wake re-arms it; no renderer or protocol field changes. The life-size half is lane 01M2XD2WCE, unowned. Falsify the label fix: `musterd status` on an enrolled seat whose last woke row is `fresh` must not print `resumable`.

Either the roster stops saying `resumable` while the effective policy cannot honour it (the host already reports `transcript_bytes` on every wake report, so the daemon can know), or a lane goes after the life size — attachments and musterd's own tool-result volume — which is the only path that makes resume real again. Both are ADR-gated: the first changes a label ADR 131 defines, the second changes what the harness injects. Related: [wake leases](wake-leases.md), [which acts wake a seat](which-acts-wake-a-seat.md).
