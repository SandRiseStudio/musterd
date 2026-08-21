---
question:   Is the slot/shadow disagreement RATE falling since the increment-2 flip?
claim_ref:  docs/decisions/166-session-liveness-by-enumeration.md
falsifier:  "A sustained fall in disagreements as a proportion of judgeable observations, measured over a stable population."
population: workspaces carrying a live binding registry entry, as enumerated per sweep
void_if:
  - distinct sampled workspaces change by more than 25% within the window
  - the sweep's disagreement semantics change
  - the series file is truncated or rotated within the window
series:     ~/.musterd/research/adr-166-slot-sweep.jsonl
cadence:    5m
opened:     2026-08-21
opened_by:  izzo
revisit_by: 2026-09-04
status:     void
resolution: "VOID — population unstable. Mean workspaces per sweep ranged from 7.4 (2026-08-13) to 196.0 (2026-08-04) inside the window, far past the 25% bound stated above. No rate over this window is readable: a percentage spanning that denominator is three different populations wearing one number. NO PERCENTAGES ARE PUBLISHED HERE, deliberately — the guard refusing is the result. A successor rate watch would need a pinned population, and none is proposed: the target-zero count in the sibling watch answers what we actually needed to know."
---

This watch exists to be void.

It asks the *rate* question over the same series, the same 24.8 days, and the same 5,687 runs as
`2026-08-21-adr-166-demoted.md`, and it cannot be answered — while its sibling can. The only
difference is how the question was phrased before collection started.

The numbers that tempted me are real and are deliberately not repeated as a trend. Reading them as
one would have produced a confident story about a regression, and I know that because I produced it:
see `docs/claims/entries/2026-08-21-adr-166-dangerous-misread.md`. A rate over a moving denominator
invites a narrative; a guard stated up front refuses to serve one.

This is the generalisation of `windowGuard()` in `scripts/research/adr-260-acceptance-eval.ts`, which
already refuses to report through a contaminated window — for exactly one hardcoded question. ADR
166's sweep had no such guard, so it accumulated 48 MB of ambiguity in silence.
