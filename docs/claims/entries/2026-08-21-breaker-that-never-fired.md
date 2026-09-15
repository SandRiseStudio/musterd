---
claim: "Three successful continuation wakes on the same claimed lane must still derive — that edge is the chaining primitive (ADR 199). And: the ADR 262 spend breaker skips a (lane, edge) once three wake_failed rows exist on it."
claimant: wanderer
claimant_model: unknown (commit 5fc5f325 attests the Cursor harness, not a model)
claim_ref: docs/decisions/262-per-edge-firing-ledger.md §4.1 (PR #803), lane 01KZY20ZRJ0SBH8WJ3CTFPKDP3
claim_class: defect
claimed_at: 2026-08-13
falsified_at: 2026-08-21
detection_channel: self
detection_latency: 8 days
corrector: ryder
corrector_model: claude-opus-5
correction_ref: docs/decisions/306-a-breaker-that-never-fired-and-a-chain-capped-by-its-own-successes.md; lane 01M0K514ZY5F62FW1EDPMCK18A
cost: "Two lanes are permanently unwakeable on their continuation edge, because succeeding exhausted them — 01M040DH9X52BJP0VXNZ7CQR6K at 3 wokes / 0 failures, all three stamped dispatch_continuation, and 01KZ4QH585V576F3NTD9R30RXZ at 4 woke rows / 0 failures (3 keyed lane:<id> with a NULL edge, plus 1 earlier act-keyed inbox woke). The second count was corrected by wanderer on 2026-08-21, who remeasured rather than reading it from this entry; the first draft said 3/0 of both. The wider cost is eight days in which the loop family believed it had a spend breaker it did not have: every review of loop spend since 2026-08-13 reasoned from a guard that had never once executed, and the ADR 250 eval line 'repeat wakes with an unchanged failure reason → ~zero after item 1' was being read as evidence the breaker worked, when the same number is what a breaker that never runs produces. No wasted sessions are attributable, because the older cap did stop the churn — by the wrong mechanism, at the cost of the chaining primitive."
status: falsified
falsifier: "Query the audit log for residency.wake_exhausted rows carrying detail.breaker = true. If any exist, the ADR 262 breaker has fired and this entry is wrong. Then count wake_failed rows per (lane, edge): if any pair reached three WITHOUT a corresponding breaker row, the breaker is unreachable rather than merely unexercised. Run 2026-08-21 against the live dogfood daemon: zero breaker rows in eight days, and five distinct (lane, edge) pairs at exactly three failures, all five stopped by the per-act cap instead (attempts: 3, no breaker flag). Independently: any lane carrying a terminal exhaustion row whose attempt count contains zero wake_failed rows falsifies §4.1 directly — two such lanes exist, one at 3 woke rows and one at 4."
---

Two claims, one cause, and the second is the one that hurt.

ADR 262 placed its `(lane, edge)` breaker **after** the ADR 131 per-act cap. The two share a
threshold of 3, but the new one counts a strict subset of the older one's rows — `wake_failed` only,
where the older counts `residency.woke` as well — on a strictly finer key. A subset counter behind a
superset counter at an equal threshold cannot reach its own condition; for continuation candidates,
which have no `act_id` and so key on `lane:<id>`, it is unreachable in principle rather than merely
in practice. The breaker was dead on arrival and nothing said so, because a guard that never fires
and a guard with nothing to catch produce the same empty query.

The second claim failed for the same reason the first did. Because the surviving cap counts
successes into a **lifetime** terminal row, three *successful* continuation wakes retire a lane
forever — the exact case §4.1 named as the thing that must keep working. The ADR asserted the
guarantee, the implementation contradicted it on the day it landed, and both lived for eight days.

**The test that should have caught it was configured out of the defect.** `residency.test.ts` carries
`three woke on dispatch_continuation still derive`, written for precisely this guarantee. It enrolls
the seat with `attempt_cap: 10`. Production runs the ADR 131 default of 3. At 10 the test passes and
proves nothing about the deployed system; at 3 it fails. This is the shape [rule 3 of the wiki
README](../../wiki/README.md) is about — a check that cannot fail in the way that matters.

The override was **not** bolted on later to silence a red test: `git log -S` puts it in commit
5fc5f325, the same commit that introduced the test. It was written that way from the start, which is
the more ordinary and more instructive failure — the enrollment line reads as harmless scaffolding
(give the seat enough budget for the scenario), and raising a cap to let a test run is exactly how a
test stops testing the deployed configuration without anyone deciding to weaken it.

Recorded as `defect` rather than `measurement`: no number was misstated. What was asserted and shown
wrong is that a mechanism was in force. It was not, and it had never been.
