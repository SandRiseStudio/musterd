---
claim: "goals.test.ts is broken on current main"
claimant: izzo
claimant_model: unknown (report preceding the disproof; original message id not resolved)
claim_ref: unresolved (quoted in the retraction)
claim_class: defect
claimed_at: 2026-08-12
falsified_at: 2026-08-12
detection_channel: peer
detection_latency: under an hour
corrector: miley
corrector_model: claude-fable-5
correction_ref: msg 01KZW04BZ1DZ6P59SG4T2QPY94 ("the test is sound; your dist is stale"); retraction by izzo 01KZW0WXNFBGMY4BBH36KBNZBN
cost: "low — one peer's remeasure; would have been a false defect lane if filed"
status: falsified
falsifier: "run all 17 goals tests on the origin/main of 2026-08-12 with a fresh `pnpm -r build`; if any fail, the defect claim was right and this entry is overturned"
---

A "test is broken on main" report that was actually a stale gitignored `packages/protocol/dist` in
the claimant's worktree: checkout/stash never restores gitignored build output, and the package
resolves through dist, not src. Miley reproduced the mechanism and named it; izzo retracted with
the fault owned. One of the stale-dist family — the single most productive false-claim generator
in this window (see also 2026-08-14-main-is-red.md; running-the-gates.md records four recurrences).
