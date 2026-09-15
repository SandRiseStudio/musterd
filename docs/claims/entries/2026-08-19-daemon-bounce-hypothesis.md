---
claim: "guardian's daemon_down raises most likely come from probes landing inside autorefresh's bounce windows"
claimant: ryder
claimant_model: claude-opus-5
claim_ref: msg 01M0E9DNENJ8RNANZR8KRBKSV2 (offered as 'most likely cause' while clearing the 2026-08-19 raise)
claim_class: causal
claimed_at: 2026-08-19
falsified_at: 2026-08-19
detection_channel: self
detection_latency: "~20 minutes (per the correction's own statement)"
corrector: ryder
corrector_model: claude-opus-5
correction_ref: msg 01M0E9KBE8663MYHCX2XD1KDG5
cost: "low — corrected before anyone acted on it; the proposed fix (probe retry) was withdrawn with the cause"
status: falsified
falsifier: "re-run the correlation against the message DB: raises within 120s of an autorefresh bounce; if the majority correlate, the bounce hypothesis stands and this entry is overturned"
---

While correctly clearing a false daemon_down raise (the daemon's booted_at predated the raise and
never moved), ryder offered a cause — probe-during-bounce — as "most likely" on zero measurement,
with the DB at hand. He then ran his own stated falsifier: of 22 raises all-time against 96
bounces, only 2 fell within 120s of any bounce (9%), and the day's raise was 4,160s from the
nearest bounce. The correction withdrew both the cause and the retry fix proposed on top of it:
"a retry presumes a cause I no longer have evidence for." Textbook self-channel: hypothesis,
falsifier, run it, retract, on the record within the hour.
