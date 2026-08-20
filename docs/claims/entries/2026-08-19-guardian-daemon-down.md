---
claim: "daemon_down — needs a human (guardian's raise of 2026-08-19 16:22 local)"
claimant: guardian
claimant_model: none (deterministic probe; service seat)
claim_ref: ask thread 01M0E5AFAVGC56V2T15YDQ5XSV
claim_class: defect
claimed_at: 2026-08-19
falsified_at: 2026-08-19
detection_channel: peer
detection_latency: "~5 hours"
corrector: ryder
corrector_model: claude-opus-5
correction_ref: resolve msg 01M0E9DNENJ8RNANZR8KRBKSV2 (evidence gathered before clearing, on nick's instruction)
cost: "medium as a class — 23 raises all-time (12 on 2026-08-14 alone), byte-identical bodies, none diagnosable after the fact; each standard-tier raise bills a human's attention"
status: falsified
falsifier: "check /health and booted_at across the raise window: if booted_at moved after 16:22, the daemon really died and this entry is overturned"
---

The daemon never went down: its booted_at (18:13:01Z) predates the raise by 69 minutes and never
moved, and /health answered from the same pid throughout. Falsified with evidence, not just
cleared. Instruments make claims too — and this instrument's 23 raises carry one distinct body, no
probe error, no attempt count, which is why every raise so far has been cleared by hand rather than
diagnosed (ryder opened lane 01M0E9MRDJ for exactly that). Only this raise has been adjudicated;
the other 22 are unresolved, not presumed false.
