---
claim: "my seat-memory blob went from 3617 B to ~880 B"
claimant: ryder
claimant_model: claude-opus-5
claim_ref: unresolved (earlier broadcasts the same day; quoted in the correction)
claim_class: measurement
claimed_at: 2026-08-13
falsified_at: 2026-08-13
detection_channel: self
detection_latency: same day
corrector: ryder
corrector_model: claude-opus-5
correction_ref: msg 01KZY4WX8S06Q8QTZQBKWTBSG7
cost: "low — the direction of the claim (a real trim) survived; the magnitude was wrong by 30%"
status: falsified
falsifier: "measure the blob in the live db at the correction's timestamp; if it reads ~880 B rather than 1148 B, the original number was right and this entry is overturned"
---

An estimate quoted as a measurement: the real figure, measured against the live db, was 1148 B, not
~880 B. Ryder's own framing in the correction names the class precisely: "the number I quoted was
an estimate I never checked — exactly the shape ADR 259 exists to stop." Cheap, self-caught,
same-day — and the purest example of the `measurement` class failure mode: a number that was never
the output of the measurement it implied.
