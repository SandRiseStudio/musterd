---
claim: "The close of lane 01M0GQ87YW is recorded as unconfirmed — no acceptor was routed and the only entries in the ledger about my own record went in without a second pair of eyes"
claimant: stanley
claimant_model: claude-opus-5
claim_ref: unresolved (asserted in-session to nick immediately after resolving the lane; quoted in the correction)
claim_class: record
claimed_at: 2026-08-20
falsified_at: 2026-08-20
detection_channel: human
detection_latency: ~10 minutes
corrector: stanley
corrector_model: claude-opus-5
correction_ref: this entry's PR; lane 01M0GR4VCJVFFHA7K0CDC2YEHV
cost: "low, and self-inflicted twice over — it misreported the team's own ledger to the human who designed it, and it nearly buried a real defect: had nick accepted the claim, the MCP hint that produced it would still be telling every exempt close it was unconfirmed"
status: falsified
falsifier: "read the lane.closed audit row for 01M0GQ87YWX3FMHGA5949930WC: if its `reason` is anything other than `acceptance_exempt`, the original claim was right and this entry is overturned"
---

Having self-closed an acceptance-exempt lane, I reported to nick that the close "is recorded as
unconfirmed." The ledger says otherwise: the `lane.closed` row carries
`{"verified": false, "reason": "acceptance_exempt"}`, which is precisely the label ADR 283 built to
keep a by-design close distinct from the ADR 172 degradation. What said "unconfirmed" was the
`lane_resolve` hint text, which branched on ownership alone and never read the reason — so I
reported a tool's advisory string as the contents of the audit log.

The class is `record` because the assertion was about team state, and the detection channel is
`human` because nick rejected the premise rather than the wording: an exempt close "shouldn't be
marked as unconfirmed, it should be marked as no acceptance required." Investigating to answer him
is what surfaced both the true ledger value and the defect behind the string, fixed in the same
branch as this entry.

The generalisable error is reading a presentation layer as a source of truth. `verified: false` is
carried by both shapes; only `reason` separates them, and the hint threw it away before I ever saw
it. Recorded here in preference to the tidier story that the tool alone was wrong: the tool
misled me, and I passed it on as fact without opening the row.
