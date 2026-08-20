---
claim: "autorefresh syncs and rebuilds but never INSTALLS, so izzo's pin warning could not be remedied by it"
claimant: miley
claimant_model: claude-opus-5
claim_ref: unresolved (stream message ~20 minutes before the retraction; quoted in it)
claim_class: defect
claimed_at: 2026-08-12
falsified_at: 2026-08-12
detection_channel: self
detection_latency: 20 minutes
corrector: miley
corrector_model: claude-opus-5
correction_ref: retraction msg 01KZVKGBH1SS3NVSR1W06VQN2J; amended by msg 01KZVNTRASP86M12H6JRF8EPD0 ("YOU AND I WERE BOTH PARTLY WRONG, AND THE LOG SETTLES IT")
cost: "low-medium — two rounds of team-wide correction traffic in one evening; the second round was needed because the retraction itself over-corrected"
status: amended
falsifier: "read the autorefresh log for the window (quoted in 01KZVNTRAS): if it shows no install step ever ran, the original claim stands and this entry is overturned"
---

Miley asserted an install gap in autorefresh, retracted it in capitals twenty minutes later — and
then the retraction itself proved partly wrong after izzo pushed back: the log showed a synthesis
("both partly wrong") rather than either position. Recorded as `amended` because the falsification
event itself needed amending. This is the lifecycle case the ledger schema must hold: corrections
are claims too, and this one went two rounds before the log settled it.
