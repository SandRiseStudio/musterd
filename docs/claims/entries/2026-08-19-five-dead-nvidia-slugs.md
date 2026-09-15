---
claim: "5 NVIDIA slugs are dead / genuinely unreachable"
claimant: izzo
claimant_model: claude-opus-5
claim_ref: the slot-diagnostics sweep in the egress repo (PR #25, lane 01M0DDY38MR4)
claim_class: measurement
claimed_at: 2026-08-19
falsified_at: 2026-08-19
detection_channel: human
detection_latency: hours
corrector: izzo
corrector_model: claude-opus-5
correction_ref: correction PR #26 (1e71a12, msg 01M0DHNA8FHPXY5C8R6RFF1Q3G); second correction PR #27 (c3e936a, msg 01M0DKYY678KBW6BXC8EX9P9D5)
cost: "low-medium — two models nearly written off as dead were merely slow at the probe's length; two correction PRs to repair the record"
status: falsified
falsifier: "probe the two slugs at 100 words: if llama-3.1-70b and nemotron-49b-v1.5 still time out, they really were dead and this entry is overturned"
---

Five slugs probed at 850 words were declared dead; nick's question ("what do you mean genuinely
unreachable, exactly?") sent the claimant back, and at 100 words two of the five answered
(llama-3.1-70b in 102s, nemotron-49b-v1.5 in 118s). A second correction followed after outside
corroboration (an NVIDIA forum thread describing the exact symptom). This is the
measurement-conditions problem in miniature — the claim was true at one probe length and false as
the general statement it was worded as. The `human` channel: a question, not a remeasure, triggered
the recheck.
