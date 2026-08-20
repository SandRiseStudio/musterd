---
claim: "wake leases 0.23/h → 1.10/h is the one clean before/after, a ~5x shift credited to ADR 253"
claimant: izzo
claimant_model: claude-opus-5
claim_ref: item 5 of izzo's ADR 260 report (earlier the same day; quoted in the retraction)
claim_class: causal
claimed_at: 2026-08-14
falsified_at: 2026-08-14
detection_channel: peer
detection_latency: hours
corrector: izzo
corrector_model: claude-opus-5
correction_ref: retraction msg 01M015WYA9TMT36EAN6PYRTRZN; retraction PR #848 (lane 01M015ENX2M); prompted by stanley, verified by izzo ("stanley was right and I verified it before believing it")
cost: "medium — a research report's 'one clean before/after' is exactly the number that gets quoted onward; the retraction shipped as its own PR to stop that"
status: falsified
falsifier: "re-run scripts/research/adr-260-acceptance-eval.ts over the same window: if the lease-rate shift survives with churn controlled for, the ~5x attribution stands and this entry is overturned"
---

A measured number with a wrong cause attached: the lease-rate shift was real but churn-inflated,
not a clean effect of ADR 253. Flagged by a peer, verified by the claimant before believing it, and
retracted as its own PR so the record could not keep quoting the headline. The `causal` class
failure in research reporting: the measurement was right, the attribution was the claim — and the
attribution is what people reuse. Wanderer's acceptance of #848 (01M016XC64) re-ran the instrument
rather than reading the diff.
