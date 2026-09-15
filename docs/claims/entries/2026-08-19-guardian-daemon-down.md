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
falsifier: "AMENDED 2026-08-21 — see the note below; the original test could not see a deliberate bounce. Read /health and booted_at across the raise window AGAINST autorefresh's bounce stream: if booted_at moved after 16:22 and no autorefresh bounce is recorded in that window, the daemon really died and this entry is overturned. ~~if booted_at moved after 16:22, the daemon really died~~ — a bounce moves booted_at exactly as a death does."
---

The daemon never went down: its booted_at (18:13:01Z) predates the raise by 69 minutes and never
moved, and /health answered from the same pid throughout. Falsified with evidence, not just
cleared. Instruments make claims too — and this instrument's 23 raises carry one distinct body, no
probe error, no attempt count, which is why every raise so far has been cleared by hand rather than
diagnosed (ryder opened lane 01M0E9MRDJ for exactly that). Only this raise has been adjudicated;
the other 22 are unresolved, not presumed false.

## Amendment, 2026-08-21 (ryder) — this entry's own falsifier was wrong

The verdict stands: the 16:22 raise was false and the evidence for that is unchanged. What was
wrong is the `falsifier` field, and it was mine.

"If booted_at moved after the raise, the daemon really died" reads one bit and attributes one
cause. `booted_at` moving proves a restart; it does not say who ordered it, and on this machine the
common cause is autorefresh bouncing onto a new build, not death. Applied to tonight's seventh
false alarm the original test gives the wrong answer outright — raise at 14:33:54, booted_at now
14:38:00, moved, therefore "real outage" — when autorefresh had bounced on `f588c85` at 14:38:01
and the daemon had been up since 14:13:37. The corrected test names the bounce stream as its
discriminator.

Minted as its own entry, self-detected:
[2026-08-21-booted-at-cannot-see-a-bounce.md](2026-08-21-booted-at-cannot-see-a-bounce.md).

**Adjudication count, updated.** This entry said "only this raise has been adjudicated; the other
22 are unresolved, not presumed false." Two more were adjudicated with evidence on 2026-08-21 —
the 14:06:47 raise (msg 01M0K2BKWTK3SEHG3EK4SCD370) and the 14:33:54 raise (msg
01M0K3X8JDSG45EYM3C6TB59A4), both false, both cleared against booted_at and the bounce log rather
than on sight. Three of thirty adjudicated. The remaining 27 are still unresolved, and still not
presumed false.
