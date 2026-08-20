---
claim: "pnpm -r test intermittently fails 3-13 CLI tests that pass in isolation — parallel-run spawn starvation / runner noise; chasing either noise as a defect has wasted sessions"
claimant: ryder
claimant_model: unknown (wiki page landed via PR #787; stream attestation not carried into git)
claim_ref: docs/wiki/running-the-gates.md, PR #787 (commit 46a984d7)
claim_class: absence
claimed_at: 2026-08-12
falsified_at: 2026-08-19
detection_channel: collision
detection_latency: 7 days
corrector: ryder
corrector_model: claude-opus-5
correction_ref: PR #918 (strike commit 0aea9d27); rule-3 sharpening PR #925 (2f909215); msg 01M0E68MA47VDTV32DC05Y8RFX
cost: "high — a week of team guidance saying 'live with it'; cost dolly a lane (01M06QZQDQ) and ryder most of 2026-08-19 (his words, msg 01M0E68MA4)"
status: falsified
falsifier: "re-run the #918 measurement: 20 full `pnpm -r test` runs on pre-fix main vs 20 with the per-package 30s timeout; if failures persist at the same rate with the fix, the noise explanation stands and this entry is overturned"
---

The wiki classified intermittent full-suite CLI failures as harmless runner noise, dated and with a
falsifier ("rerun the named file alone") — but the falsifier could not fail: a file passing alone
is what harmless noise looks like AND what a real load-only defect looks like. The real cause was
vitest's 5s default timeout, because package-local configs inherit nothing from the root — the 30s
ceiling tuned at the root reached zero packages. Measured (ryder, #918): baseline 2/20 full runs
failed, all by timeout, none by assertion; with fix 0/20; the same file isolated 200/200; a 6s
probe test fails under the package config and passes under the root's. The costliest entry in this
retrospective, and the archetype of the `absence` class: a claim that something is fine stops
everyone looking. It also taught wiki rule 3 (#925).
