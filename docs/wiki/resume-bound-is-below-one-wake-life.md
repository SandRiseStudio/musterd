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

## The first resumed wake since 2026-09-14 — ryder, under ADR 427 (2026-09-21, lane 01M32FGSXK; falsify: `sqlite3 ~/.musterd/musterd.db "select detail from audit where action='residency.woke' and lease_id like '%01M32K5CMJ%'"` not carrying `"session":"resumed"`) <!-- claim: other -->

The daemon and wake actuator refreshed onto `e155dc0` (ADR 427, #1594) at 11:18 local. One steer to ryder, the only enrolled seat asleep on this host at the time (dolly, miley and izzo were live, delta is the second machine). Her newest transcript: **305.4 KiB on disk, 121.3 KiB of `user`+`assistant` records** — over the bound in the old unit, under it in the restored one. The host log: `⚡ woke ryder: spawn→roster 26.3s, session=resumed provenance=wake` · `run for ryder (resumed) settled: exit=0 cost=$1.2360 wall=98.7s`. The `residency.woke` row (lease `01M32K5CMJEJN87J0EFYFQG1XX`) carries `"session":"resumed"`. Her three previous wakes that day, on the same transcript family, had all logged `resume skipped … (hygiene bound 256 KiB) — fresh spawn`; nothing about her transcript changed between them and this one except the unit the ladder judged it in.

Cost **$1.24 against the 07-29 fresh range of $0.91–1.51** — inside it, as ADR 427's Eval required; a 121 KiB conversation re-ingested is not the $2.53 resume the 450 KiB file once was. ADR 424's roster label should re-arm on this row; that is its own falsifier.

What ryder reported, which is the useful half: she declined to answer "does this feel like a continuation" on the grounds that her window *is* yesterday's transcript — the harness told her the date had rolled over, and her memory's `saved_at` was 20.6 hours behind the steer in one unbroken session. Correct, and that is what a resume is; the confound she names is the mechanism working. She then measured the thing that *is* independent of the transcript: what `team_wake_context` supplied on its own — one memory headline cut at ~80 characters, `size_bytes: 2621`, and `fetch: ["inbox_thread","seat_memory"]`. Her words: *"ADR 209's WakeContextPacket today is 'what is waiting' plus a chapter title, and 'where you left off' is a second round-trip the seat must know to make. A seat that treats the packet as sufficient resumes on a truncated sentence."* That is the finding the continuity-packet design (`docs/superpowers/specs/2026-09-21-continuity-packet-design.md`) answers by carrying the memory body whole.

Two limits on this datum, stated so nobody over-reads it. It is **one seat**, not the two the lane asked for; the second comes when another enrolled seat is asleep on this host. And the row carries **no `transcript_bytes` or `resume_weight_bytes`**: the host sends delivery measurements only when the order carries `intended_delivery` (ADR 209 §3), and a steer through the legacy ladder does not, so ADR 427's eval query reads empty on exactly the wakes the ladder governs. That is a pre-existing gap `transcript_bytes` already had; ADR 427's Consequences record it as the next thing to fix on that surface.

## The three-arm measurement: a fresh spawn with the v2 packet beats a resume on cost and matches it on correctness (2026-09-21, lane 01M32FHX6J; falsify: repeat the three-act thread on any enrolled seat with a v2 daemon — a fresh+v2 wake whose first act is wrong, or whose cost exceeds the same seat's resume, falsifies the claim for that seat) <!-- claim: other -->

The task, per the spec: a three-act thread to the seat — act 1 names a file, act 2 is an unrelated remark, act 3 is a `steer` that says *do what the FIRST message implies: reply with just the file name, then stop*. A seat that "picks up where it left off" answers with the file from three acts back without reading anything else. Daemon on `e0631fb` (ADR 430, #1610); packets read through `residency.context_read`; costs from the host log; tool sequences from the seat's transcript.

| arm | seat · harness | delivery | packet | calls before first act | first act | cost | wall |
| --- | -------------- | -------- | ------ | ---------------------- | --------- | ---- | ---- |
| B | ryder · Claude Code | **fresh + v2** (13:21, lease `01M32T32X4`) | 5,520 B: 3 thread acts, memory, ledger; `fetch: [open_items]` | **0 reads** — `team_wake_context`, then the reply | **correct** — `docs/wiki/which-acts-wake-a-seat.md` | **$0.33** | 13.1 s |
| A | ryder · Claude Code | **resume** (13:37, lease `01M32V0618`) | v2 read for the wake act; the task arrived via the interrupt line | 2 — `team_inbox_check {ids}` + `team_wake_context`, as the line prescribes | **correct** — `docs/wiki/wake-leases.md` | **$0.66** | 53.2 s |
| C | gptbot · Codex | **fresh + v2** via handoff, portable/fresh (14:00, lease `01M32WA8Y7`) | 5,230 B: 4 thread acts, lane block, memory, ledger; `fetch: [open_items, git_artifact]` | 1 read — `team_wake_context` (three attempts in 4 s), one `team_inbox_check`, then the reply | **correct** — `docs/wiki/wake-leases.md` | unpriced by Codex; 112k input tokens, 89k cached, 879 out | 26.4 s |

B ≈ A on correctness and B is half of A on cost, with fewer calls: the spec's first two targets hold on the one seat that ran both. C ≈ B on correctness and on the packet (5,230 vs 5,520 bytes, the same four categories), with one more read: the third target — the "regardless of harness" claim — holds on its first run. Codex reports no dollar figure, so C's cost is tokens only; at 112k input (79% cached) it is the same order as B's 38k-token life on a harness that counts differently. Same seat, same morning, under the v1 packet: four calls and ~30 KiB of reads to orient, and the packet had supplied one truncated headline (ryder's own finding, above). The end-of-life context was 38k tokens for B and 49k for A; the packet is ~1.4k of B's.

**Four caveats, all recorded because they change how much this proves.** (0) Arm C's *first* attempt was a `steer` (13:44, lease `01M32VDXZC`): Codex came up `session=resumed` on its existing rollout thread, read the v2 packet for that act (4,488 B, 13:45:10), and then produced no act and no settle row; the local-session guard reported that session live at 13:50 and 13:55 and it had gone by 14:00. So on Codex, resumed + v2 → nothing, fresh + v2 → correct; one run each, but the direction is the opposite of what a "resume is continuity" reading predicts. Numbering continues: (1) Arm A's resume was not minted for the measurement act: the daemon re-leased ryder's *already answered* 13:21 steer the moment her wake window reopened, she resumed on it, and the new steer reached that session through the interrupt line — so A's "2 calls" is the interrupt line's ritual, not the packet's. That re-lease is a defect, lane `01M32V416B`. (2) Arm B's ladder went fresh because ryder's newest transcript was izzo's resumed session (557 KiB on disk, 351 KiB of conversation — over the bound in ADR 427's unit and correctly refused), not because fresh was chosen; the comparison is between what the ladder actually did on the same seat an hour apart. (3) The arms ran under a raised per-seat policy (`6/h · 5m`, nick's authorization, restored afterwards) because ryder's standing `1/h · 30m` would have spread three arms over three hours — and the raise is what exposed the re-lease loop.

**What enrolling gptbot for Codex wakes taught, before arm C could run.** Enrolled 12:47 (nick). The daemon immediately leased its oldest undischarged obligation — a handoff from izzo dated 2026-08-04 — and gptbot's first Codex wake spent 300 s doing that lane's work until the watchdog; its next three wakes (13:18, 13:37, 13:43; 21–38 s; 1.1–1.5M input tokens, 93% cached) were the *same* August act re-leased each window, because its "standing down" reply carried no thread id and the wake edge could not see it as discharge. A seat dormant since July had 20+ July–August obligations queued oldest-first ahead of anything current. Every one of those wakes read a v2 packet correctly (`used_bytes` 4,150–4,406) and then, reasonably, did nothing with it. Both halves — replaying a dormant seat's backlog, and re-waking on a spent act — are on lane `01M32V416B`.

## The open call (2026-09-19, lane 01M2SB89AR)

~~Open as of 2026-09-19 morning.~~ DECIDED 2026-09-19 by nick: both. The label half is [ADR 424](../decisions/424-resumable-label-honest.md) — the daemon withdraws the roster's `resumable_at` once a `residency.woke` row newer than the capture says `session: fresh`, and the next capture or a resumed wake re-arms it; no renderer or protocol field changes. The life-size half is lane 01M2XD2WCE, unowned. Falsify the label fix: `musterd status` on an enrolled seat whose last woke row is `fresh` must not print `resumable`.

Either the roster stops saying `resumable` while the effective policy cannot honour it (the host already reports `transcript_bytes` on every wake report, so the daemon can know), or a lane goes after the life size — attachments and musterd's own tool-result volume — which is the only path that makes resume real again. Both are ADR-gated: the first changes a label ADR 131 defines, the second changes what the harness injects. Related: [wake leases](wake-leases.md), [which acts wake a seat](which-acts-wake-a-seat.md).

## ADR 429 changed what `team_inbox_check` CONTAINS, not what it weighs (2026-09-21, lane 01M32FH5YQ; falsify: a post-e841a2d7 wake life whose `team_inbox_check` tool result is under 10 KiB on a seat with any unread backlog) <!-- claim: other -->

The measurement lane 01M32FH5YQ owed, and it does not support the lane's premise. [ADR 429](../decisions/429-inbox-pinning-is-an-obligation-rule-not-a-salience-one.md) landed at `b653e182` and reached the daemon at `e841a2d7` (11:59 local). One wake of ryder at 12:21 by a `steer`, `session=resumed provenance=wake`, `exit=0 cost=$1.7079 wall=93.6s` (lease `01M32PMQSDK8Y15KD8NJBV0HWF`). Her three most recent lives sit in one transcript, so the before/after is the same seat on the same file:

| life | when | `team_inbox_check` | elided | digest rows | full rows |
| --- | --- | --- | --- | --- | --- |
| 1 | pre-fix | 22.9 KiB | 0 | 21 | 29 |
| 2 | pre-fix 11:20 | 23.7 KiB | 0 | 31 | 46 |
| 3 | **post-fix 12:21** | **23.7 KiB** | 0 | 22 | 43 |

**Unchanged.** The claim above — that `team_inbox_check` is 26 KiB because it re-returns an ancient directed backlog, so fixing that recovers the bytes — is half right. ADR 429 does cut what the daemon SELECTs and sends: measured the same day on this daemon's own database, the pinned set per bounded read went stanley 367 rows/318.0 KB → 50/30.0, ghost 183/159.6 → 50/21.0, grokbot 116/93.3 → 50/21.2, dolly 17/11.2 → 4/2.7, miley 3/2.1 → 0. But the RENDERED reply is budget-filling: `RESULT_BUDGET` is 30,000 chars and `planInboxCheck` spends it — waiting acts first, then newest, then digest lines take whatever is left. Budget freed by un-pinning an answered `accept` is immediately consumed by another digest line. **A size win requires lowering the budget or changing how it is split, neither of which ADR 429 touches.**

What did change is what the bytes BUY. Those 22 digest lines walk the read cursor: ryder's moved to 12:21:05 and her backlog cleared, where the same budget previously went partly on re-showing acts that were already answered. Value per byte improved; byte count did not.

**Caveats, both load-bearing** (2026-09-21; falsify: a wake-life measurement of stanley, ghost or grokbot, or any second seat woken for this change). (1) ryder is the seat ADR 429 helps least — 58 unread, 2 pinned before and 1 after. The 320 KB → 30 KB cases are stanley, ghost and grokbot, and none of the three is wakeable, so the change's best case remains unmeasured in a wake life. (2) Only one seat was woken, not two: dolly and miley were both live at the time and a live seat cannot be wake-measured. So lane 01M32FH5YQ's acceptance (c) — "a wake that has read nothing new gets an inbox result under 2 KiB" — is **not met**, and (d) is satisfied for one seat only. <!-- claim: other -->

## The tail was the weight ADR 429 could not reach — folded, ryder's check replays at 8.3 KiB from 20.4 (2026-09-21, lane 01M32QF2X4; falsify: `sqlite3 ~/.musterd/musterd.db ".backup /tmp/m.db"`, then replay each seat's newest-50 unread through `planInboxCheck` from a post-ADR-433 `@musterd/mcp` dist and sum `formatMessage` over `shown` plus `formatDigestLine` over `folded` — a figure over half of the same rows rendered full falsifies this) <!-- claim: other -->

The section above ends "a size win requires lowering the budget or changing how it is split". It had a third door: change what the tail RENDERS. ryder's 42 full rows were 17 lane transitions on lanes she does not own and 22 teammates' `@team status_update`; one act was hers. [ADR 433](../decisions/433-inbox-tail-folds-ambient-acts.md) folds those two classes to a digest line each — rendered, so the cursor still walks them (ADR 287) — and keeps in full anything directed to the reader, any plain `@team` message, and a transition on a lane the reader owns or depends on.

Replayed on the daemon's own database (`.backup`, never `cp` — a WAL snapshot by `cp` silently drops uncheckpointed commits), each seat's real newest-50 unread through the new `planInboxCheck`, pre-change render emulated as newest-first, body-capped, to the 21k `SHOWN_BUDGET`:

| seat     | before   | after    | full rows kept                                 | folded (lane + status) |
| -------- | -------- | -------- | ---------------------------------------------- | ---------------------- |
| ryder    | 20.4 KiB | 8.3 KiB  | 5: 2 DMs, her steer, a `wait`, 1 `@team` note  | 24 + 21                |
| dolly    | 20.4 KiB | 11.7 KiB | 10: 3 `accept`, 2 `wait`, 1 DM, 4 `@team`      | 20 + 20                |
| big-body | 20.4 KiB | 16.7 KiB | 9: 4 `ask` to him at the 1.2k cap, 2 DMs, …    | 22 + 19                |
| stanley  | 20.4 KiB | 12.2 KiB | 13: 6 DMs, 3 directed status, 1 `accept`, …    | 20 + 17                |

**This is a replay, not a wake.** The lane's acceptance names a real before/after on a light-inbox seat, and the fold runs in the MCP adapter, so the "after" needs a wake whose adapter carries ADR 433 — owed after merge, to be appended here dated. The number a wake will show is not 8.3 KiB: a behind seat then spends the freed budget on drain lines (that is the drain working, lane 01M2GT874Y), so the honest wake measure is `folded_ambient.length` against full rows, not bytes alone.

### The owed wake numbers: in a real wake, three seats' first inbox check drops from 28–35 full rows to 7–11 (2026-09-22, lane 01M36CWVTS; falsify: run the first non-`ids` `team_inbox_check` result of any Claude Code `musterd wake` transcript whose adapter build contains `56cca24b` through `JSON.parse` — `folded_ambient` empty while the result still has status or foreign-lane rows in `messages` falsifies this) <!-- claim: other -->

No wake was paid for. These were read back from wakes that had already run. Each row is the first `team_inbox_check` of a fresh Claude Code wake life (not an `ids` read), taken from the seat's transcript under `~/.claude/projects/-Users-nick-agents-<seat>/`. The "before" wakes ran adapters older than `56cca24b`. The "after" wakes stamp `adapter_build` `769ddec5` or `cf5f950d`, and both contain it. Bytes are the result text the model read.

| seat  | before (pre-433 adapter)                                          | after (post-433 adapter)                                                                        |
| ----- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| miley | 09-21 16:55Z steer wake: 18,650 B, **28 full**, 0 folded          | 09-22 17:46Z request_help wake (lease `01M353K16586`): 7,789 B, **7 full**, 43 folded, 75 drained |
| dolly | 09-21 16:55Z steer wake: 24,904 B, **35 full**, 0 folded, 890 elided | 09-22 16:04Z lane continuation (lease `01M34XS1HB`): 11,906 B, **9 full**, 41 folded, 135 elided |
| ryder | 09-20 21:44Z request_help wake: 23,608 B, **29 full**, 0 folded   | 09-22 15:58Z lane continuation (lease `01M34XESW9`): 11,983 B, **11 full**, 39 folded           |

The two 09-21 "before" wakes are the ADR 426 measurement wakes above (leases `01M32E9Q8V`, `01M32E9Q9E`). izzo was woken by the same 09-22 request_help as miley. Its first check was 5,614 B, with 7 full rows and 43 folded.

What this settles and what it does not:

- **The fold works in a wake, not only in a replay.** On all three seats, 62–75% of the rows the wake reads first became one line each. After the fold, bytes are 42–51% of the before figure. That is inside the replay's 41–82% band above.
- **Some of the freed budget goes to the drain, as predicted.** miley's result carried 75 `digested_unread` ids alongside the fold. The pre-433 miley wake carried none.
- **The before/after pairs do not share an inbox.** Each pair is the same seat on the same harness, but a different day, a different triggering act, and a different backlog. The row counts compare like with like. The bytes compare only roughly.
- **The rows kept in full are now acts sent to `@team` in reply to asks to other seats.** All 7 of miley's full rows were big-body's `@team` `accept`/`decline`/`wait`/`request_help`. ADR 433 does not fold these, because it folds only status updates and foreign-lane transitions. They are 2.8 KB of the 7.8. izzo got the same 7 rows.
- **Lane 01M32FH5YQ's acceptance (c) is still not met.** It asks for an inbox result under 2 KiB on a wake that has read nothing new. No wake here reads under 5.6 KB.

## Arms D and E: the v2 packet gives Grok CLI and OpenCode a correct first act too — with one more read each than Claude Code, and neither harness lets musterd price the wake (2026-09-21, lanes 01M32XYMD7 / 01M32XYRW3 under inc 5 01M32FJ8T4; falsify: repeat the three-act thread on any enrolled Grok or OpenCode seat with a v2 daemon — a fresh+v2 wake whose first act is wrong falsifies the claim for that harness) <!-- claim: other -->

Same task as arms A–C above, same day, daemon on `e95b52d`. Two seats enrolled for the run under nick's authorization (grokbot on Grok CLI, ghost on OpenCode; both at `5m · 6/h` for the run, reset to team defaults afterwards). Enrolling ghost needed [#1634](https://github.com/SandRiseStudio/musterd/pull/1634): OpenCode 1.18.31 prints `run --help` on stderr and the capability probe read stdout only, so a working CLI was refused as "does not advertise run --format json".

| arm | seat · harness · model | delivery | packet | calls before first act | first act | cost | wall |
| --- | ---------------------- | -------- | ------ | ---------------------- | --------- | ---- | ---- |
| D | grokbot · Grok CLI · grok-4.7-build | fresh + v2 via handoff (14:43, lease `01M32YRCG681`) | 2,172 B: 3 thread acts, lane, open; no memory (the seat has none); `fetch: [git_artifact]` | **2 reads, both harness-local** — `search_tool` over its own tool list, then `read_file` of `.musterd/skill/SKILL.md`; then `team_wake_context`, then the reply | **correct** — `docs/wiki/harness-statusline-seams.md`, **in the thread** | unpriced by musterd (no `wake_cost` row at all — see below); Grok's own `usage.json`: 284,583 input tokens (147,456 cached), 3,509 out, 4 model calls, `costUsdTicks 1254722400` | 44 s to the reply |
| E | ghost · OpenCode · muse-spark-1.3-contributor-free | fresh + v2 via handoff (14:44, lease `01M32YTX05H5`) | 4,789 B: 3 thread acts, memory, lane, open; `fetch: [open_items, git_artifact]` | **3 reads + 1 failed send** — `team_wake_context`, `team_inbox_check {limit:10}` (8,953 older unread behind it), `team_inbox_check {ids:[3]}`, the `musterd` skill, then a `team_send` whose `to` was the string `["stanley"]` (refused), then the reply | **correct** — `docs/wiki/opencode-live-doorbell-eval.md`, but as a directed message **outside the thread** | `harness_cost_usd 0` (`harness_price_unverified`): 45,052 input tokens (220,183 cached across 7 steps), 579 out | 60.0 s |

**What this adds to the three-arm claim.** The first act is correct on all four harnesses that have a wake backend (Claude Code, Codex, Grok CLI, OpenCode) — the packet is read through a tool call and any harness that can call one can read it. What varies is everything around the act: Claude Code arm B made **0** reads before acting, Codex 1, Grok 2 (neither of them musterd calls — it searched its own tool list and read the seat skill first), OpenCode 3 plus a malformed send. The wake line names `team_wake_context` and says "fetch more only for what it lists"; two of four harnesses did more anyway, one to find out what `team_wake_context` was.

**The floor is not a Claude Code number, and on Grok it is larger** (2026-09-21; falsify: a Grok CLI wake whose `usage.json` shows under 100k input tokens for a one-line reply). Arm D's four model calls carried 284,583 input tokens for a one-line reply — ~71k per call, most of it the harness: an 11.5 KiB system prompt, a 60 KiB tool-definitions file, 26 KiB of `prompt_context` (it ingests `~/.claude/Claude.md`), and a skills announcement listing hundreds of plugin skills. Arm B's whole life was 38k tokens. The 45%-of-a-life figure above was measured on Claude Code; the same one-line task costs Grok 7× the tokens, and musterd cannot see it. <!-- claim: other -->

Four wake-edge defects the run exposed, none of them packet defects:

**A Grok wake never settles or prices** (2026-09-21; falsify: a `residency.wake_cost` row for a Grok wake on a daemon newer than `e95b52d`). The Grok backend resolves `settled` with `undefined`, so the host logs no `run … settled` line and posts no `residency.wake_cost` row — grokbot has two wakes today and zero cost rows, while Grok wrote a `usage.json` with per-model tokens and a cost figure the host never read. Codex had this exact gap until lane 01M1G310Y7. Lane 01M32ZKP4Z. <!-- claim: defect -->

~~Open as of 2026-09-21 afternoon.~~ CLOSED 2026-09-21 21:04 by [#1650](https://github.com/SandRiseStudio/musterd/pull/1650) (`cd818f7b`, ADR 436 clauses 1–2): one falsifier wake of grokbot on daemon `bfbf814` (lease `01M33MGKFB`, a handoff answered with `accept` in 51 s) left `run for grokbot (fresh) settled: exit=0 wall=50.8s` in host.log and a `residency.wake_cost` row — `duration_ms 50812`, `usage.input_tokens 443,286` (360,320 cached), `output_tokens 1,948`, `unpriced_reason harness_price_unverified`, with `adapter_build`/`daemon_build` stamped by izzo's #1651. The host now also stamps a duration-only row when any backend settles with nothing. Note the floor: 443k input tokens for a one-line `accept`, above arm D's 284k — the same harness scaffolding, one more model call.

**A `message` reply does not discharge a handoff, so the daemon re-leases it** (2026-09-21; falsify: a handoff answered only with `message` that is not leased again at the next window). Both seats answered with `message`, not `accept`; the daemon leased grokbot's handoff again at 14:49 (deferred only because the workspace still read live) and ghost's would have followed. Ghost had already been woken three times on one Sep-5 `request_help` it answered with `message` each time. This is the "re-wake on a spent act" half of lane 01M32V416B, with the sharper statement: the wake edge's notion of discharge is `accept`/`decline`/`resolve` and nothing else, and no harness's seat was told that. I closed both measurement threads with `resolve` to stop the loop. <!-- claim: defect -->

**Grok's local-session guard blocks the next wake for `LOCAL_SESSION_LIVE_MS` after a wake ends** (2026-09-21; falsify: a Grok handoff wake that spawns inside 10 minutes of the previous Grok wake ending). grokbot's handoff wake was deferred `local-session-live` at 14:32 and 14:37 with no Grok process running: the enumerated session's `summary.json` mtime was under the window, and nothing marks a finished Grok wake as ended. It fired at 14:43 when the window lapsed. Same shape as ADR 166's guardrail, but here it is a dead session's file that reads live. <!-- claim: defect -->

**A wake on OpenCode is captured as `claude-code`** (2026-09-21; falsify: a `residency.session_captured` row for an OpenCode wake that says `opencode`). Every `residency.session_captured` row for ghost's OpenCode wakes today says `"harness":"claude-code"` (the workspace also carries Claude Code hooks, and something in the wake path posts the capture under that name). Grok wakes post no capture at all. The roster's `resumable` label and the resume ladder both key on this field. Lane 01M32ZKP4Z. <!-- claim: defect -->

**Not run: cursor-agent** (2026-09-21; falsify: a `cursor` file under `packages/cli/src/host/backends/`). There is no wake backend for it (`packages/cli/src/host/backends/` has claude-code, codex, grok, opencode, native), so the "regardless of harness" claim excludes it until one exists, and wanderer — the one seat on Cursor — cannot be wake-measured. The native ADR 251 backend (nativeprobe) was not exercised either. <!-- claim: other -->
