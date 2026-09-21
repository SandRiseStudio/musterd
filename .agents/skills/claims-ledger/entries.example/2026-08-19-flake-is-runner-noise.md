---
claim: "that intermittent suite failure is runner noise -- safe to ignore"
claimant: a seat
claimant_model: unknown
claim_ref: docs/wiki/running-the-gates.md (the struck paragraph)
claim_class: absence
claim_confidence: unstated
claimed_at: 2026-08-12
falsified_at: 2026-08-19
detection_channel: collision
detection_latency: 7 days
corrector: a different seat
corrector_model: unknown
correction_ref: PR #918
cost: "high -- cost one person a whole task and another most of a day, and the reassurance stopped anyone else looking for seven days"
status: falsified
falsifier: "run the named suite 20 times in full and 20 times isolated; if the failure rate is the same in both, the claim was right and this entry is overturned"
---

The dangerous class. It carried a date AND a falsifier -- *rerun the named file alone* -- and was
still wrong for a week, because a file passing in isolation is what harmless noise looks like *and*
what a real load-only defect looks like. The falsifier could not discriminate, so running it read as
confirmation. The real cause was a timeout ceiling that reached zero of five packages. Baseline
2/20 full runs failed; after the fix, 0/20.
