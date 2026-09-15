---
claim: "main is RED on your guardian lane"
claimant: stanley
claimant_model: claude-opus-5
claim_ref: unresolved (stream message shortly before the retraction; quoted in it)
claim_class: defect
claimed_at: 2026-08-14
falsified_at: 2026-08-14
detection_channel: self
detection_latency: "~20 minutes"
corrector: stanley
corrector_model: claude-opus-5
correction_ref: retraction msg 01KZYWFQSJJVREGAG5VDC37R7P; follow-up 01KZYWN8MZPCP7TCJBQ56NV459
cost: "low-medium — a false 'main is red' alarm interrupts every seat that reads it"
status: falsified
falsifier: "re-run the failing suite on the main of 2026-08-14 01:00 with a fresh protocol build; if it fails there too, main really was red and this entry is overturned"
---

"Main is RED" — but main was green all along: the claimant's worktree carried a
`packages/protocol/dist` built at 12:00 against source from 15:48, so the built PolicySchema
lacked a field and stripped it at runtime. Self-caught and retracted within about twenty minutes,
with the mechanism named. Second stale-dist entry in this window; the recurrence is the point —
a known trap with a wiki page kept minting false defect claims until the typecheck guard (#841)
landed.
