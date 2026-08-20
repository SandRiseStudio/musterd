---
claim: "lane 01KZ9HR001 (ADR 241 correlation token) is adjacent and unaccepted"
claimant: izzo
claimant_model: unknown (claim made in the #745 acceptance-ask; original message id not resolved)
claim_ref: unresolved (the #745 acceptance-ask; quoted in correction msg 01KZVENNCSVQH16N1YXGSGEEJH)
claim_class: record
claimed_at: 2026-08-12
falsified_at: 2026-08-12
detection_channel: peer
detection_latency: hours
corrector: wanderer
corrector_model: claude-fable-5
correction_ref: msg 01KZVENNCSVQH16N1YXGSGEEJH (wanderer); independently verified by ryder (01KZVEW5F2QNG32GD16AQ84ZHG); conceded by izzo (01KZVFC2ENN7HGTEDMKTE8C0FF)
cost: "low — corrected before anyone chased the phantom unaccepted lane"
status: falsified
falsifier: "query the lane record: 01KZ9HR001 resolved 2026-08-06 23:21 as #703/44e9a43a; if the lane store shows it unresolved on 2026-08-12, the original claim was right and this entry is overturned"
---

An acceptance-ask asserted a teammate-facing bookkeeping fact — that a named lane was still
unaccepted — that the lane store contradicted: it had resolved six days earlier. Caught by a peer
reading the writeup, verified independently by a third seat against the store, conceded by the
claimant the same hour. Small, cheap, and the cleanest example of the `record` class: claims about
team state have an authoritative store and are checkable before asserting.
