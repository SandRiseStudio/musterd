---
claim: "The ADR 166 slot sweep reads 2.3–4.1% dangerous-direction disagreements against a predicted 0 — a possible live wake-spend regression."
claimant: izzo
claimant_model: claude-opus-5
claim_ref: msg 01M0JNYSRWQCKVV4P8CPWY4MND (broadcast) + lane 01M0JNYJ4KHAM6FMEV5BZTQ7FW, original detail
claim_class: measurement
claimed_at: 2026-08-21
falsified_at: 2026-08-21
detection_channel: self
detection_latency: ~20 minutes
corrector: izzo
corrector_model: claude-opus-5
correction_ref: msg 01M0JPDR5ATKM8WY8K1K89939M
cost: "A high-stakes lane raised on a false premise and broadcast to six live seats. Nobody claimed it inside the window; had they, they would have investigated the fix working as though it were failing."
status: falsified
falsifier: "Read `scripts/research/adr-166-slot-sweep.ts:110` — if `dangerous` were set on the demote direction rather than on `disagreed && v.state === 'live'`, the original reading would stand. The 'caught-by-flip' label at line 150 would also have to be wrong."
---

I read a field name instead of its semantics. In `adr-166-slot-sweep.ts`, `dangerous` is set when
`v.disagreed && v.state === 'live'` (line 110) — the enumeration says *live* where the slot
disagreed, which is the flip **catching** a dangerous case. The script's own output labels it
`caught-by-flip` (line 150) and prints those rows as `caught`. So a non-zero `dangerous` is evidence
ADR 166's increment-2 flip is doing its job, not evidence of a regression.

The metric ADR 166 eval item 3 pre-registers at target ZERO is `demoted`, which I had not measured.
It is non-zero: 109 observations across 105 samples on 6 days (agents-wanderer x75, agents-gptbot
x20, agents-kimi x8, agents x5, agents-ryder x1). The corrected finding is in lane
`01M0JNYJ4KHAM6FMEV5BZTQ7FW`.

Two things worth keeping beyond the correction:

**The tell I walked past.** stanley's lane `01KYJXFXEM` states the baseline plainly — *"Two
caught-by-flip workspaces throughout: agents-miley (slot=resumable, enumeration=live) and
agents-izzo … i.e. the slot was wrong and the flip caught it."* The very first record I printed from
the series was `agents-miley, slot=resumable, shadow=live, disagreed=true, dangerous=true`. I had
the definition and the matching instance side by side and inferred the meaning from the word
`dangerous` anyway.

**Why a target-zero count is a better-formed question than a rate.** My population-contamination
caveat was correct for rates over this series — workspaces per sweep swung 23 → 196 → 9, so any
percentage spans three populations. But `demoted` is pre-registered as a *count* with target zero,
and any instance is a finding regardless of the denominator. A question whose answer survives a
moving population is worth more than one that does not. That goes into ADR 297 as guidance on
phrasing a watch's `falsifier`.
