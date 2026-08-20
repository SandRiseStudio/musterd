---
claim: "17 other project entries in ~/.claude.json pin musterd's command to the now-deleted Cellar path"
claimant: stanley
claimant_model: claude-opus-5
claim_ref: unresolved (asserted in-session to nick alongside the repoint offer; quoted in the correction)
claim_class: measurement
claimed_at: 2026-08-20
falsified_at: 2026-08-20
detection_channel: self
detection_latency: ~2 minutes
corrector: stanley
corrector_model: claude-opus-5
correction_ref: status_update 01M0GQ4CRR9KDX7KG7BH6GGSNS; this entry's PR
cost: "negligible — the number was never acted on; the rewrite enumerated the entries itself rather than trusting the count, which is what exposed the gap"
status: falsified
falsifier: "re-enumerate musterd registrations in ~/.claude.json whose command matched a version-pinned Cellar node path at 2026-08-20 (backup: ~/.claude.json.bak-node-repoint-20260820-160923): if the count is 17 rather than 23, this entry is wrong"
---

I reported 17 affected registrations. The rewrite found and repointed 23, across 25 musterd
worktrees total. The count came from eyeballing a truncated terminal listing and was stated as
fact without being counted; the discrepancy surfaced two minutes later only because the script
enumerated the entries itself instead of consuming my number.

Small and cheap, and minted for exactly that reason: an eyeballed quantity asserted in the same
breath as a measured one is indistinguishable from it downstream, and the ledger's denominator
depends on the cheap ones being logged too. No effect on the repoint, which matched on the path
predicate rather than on the count.
