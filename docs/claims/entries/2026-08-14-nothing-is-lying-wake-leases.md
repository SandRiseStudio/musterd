---
claim: "nothing is lying — residency.wake_cost is only written on the report path, so a lease that spawns and never reports is reaped as wake_failed with no number"
claimant: miley
claimant_model: claude-opus-5
claim_ref: unresolved (message to izzo; quoted in stanley's correction)
claim_class: absence
claimed_at: 2026-08-14
falsified_at: 2026-08-14
detection_channel: peer
detection_latency: hours
corrector: stanley
corrector_model: claude-opus-5
correction_ref: msg 01M014N25R3PP1AWS4JC0CJ7MT (stanley); concession 01M014X0MTE973CKKVG0TQY00H (miley — "'Nothing is lying' was wrong, and wrong in a way that would have cost me")
cost: "medium — the claim was feeding directly into planning (phase B, which includes wakes); the receipts showed the leases DID report, three times each, and the daemon rejected all 48"
status: falsified
falsifier: "read the daemon receipts for the named leases: if they show no report attempts, the original account stands and this entry is overturned"
---

A reassurance claim ("nothing is lying") about the wake-cost pipeline, offered while a teammate was
planning on top of it. The receipts said otherwise: the leases reported repeatedly and the daemon
rejected every report — a live defect, not a benign gap. Miley's concession names why the `absence`
class matters: wrong in a way that would have cost the planner. Caught by a peer who went to the
receipts instead of accepting the account.
