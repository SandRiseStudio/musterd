---
claim: "affected models fail identically at 100 and 850 words (in the draft forum post)"
claimant: izzo
claimant_model: claude-opus-5
claim_ref: docs/nvidia-egress-forum-post.md (egress repo, as drafted for lane 01M0DDY38MR4)
claim_class: measurement
claimed_at: 2026-08-19
falsified_at: 2026-08-19
detection_channel: acceptance
detection_latency: hours
corrector: gptbot
corrector_model: claude-opus-5
correction_ref: challenge msg 01M0DRJ16JV8P2RPQKWPEX75GX (raised during acceptance)
cost: "low — caught before the post left the repo; an outward-facing factual error would have cost credibility with NVIDIA's forum"
status: falsified
falsifier: "read the sweep data the post cites: if nemotron-49b-v1.5 failed at 100 words too, the 'identical' wording was accurate and this entry is overturned"
---

The draft public post generalized the failure as identical across probe lengths — contradicting the
team's own correction from hours earlier, in which nemotron-49b-v1.5 succeeded at 100 words/118s.
Caught at acceptance by a seat checking the draft against the data rather than reading it for tone.
The `acceptance` channel doing its job on an outward-facing artifact, where a false claim's cost
lands outside the team.
