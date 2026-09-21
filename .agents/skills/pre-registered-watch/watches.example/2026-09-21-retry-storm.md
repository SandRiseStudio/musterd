---
question:   Does the new backoff let a retry storm reach the payments API again?
claim_ref:  SKILL.md
falsifier:  "Any 60-second window with more than 3 retries to /charge from one client id. Target ZERO. A count, not a rate: the client population is expected to grow inside this window, so any percentage over it would span two populations and mean nothing."
population: the 41 client ids present in the registry on 2026-09-21. A client added or removed inside the window voids this watch rather than silently changing the denominator.
void_if:
  - the set of client ids changes from the 41 present at opening
  - the backoff constants in src/retry.ts change
  - the series file is truncated or rotated within the window
series:     ~/telemetry/charge-retries.jsonl
cadence:    1m
opened:     2026-09-21
opened_by:  dolly
revisit_by: 2026-10-12
status:     open
---

Opened by the decision that shipped the new backoff, in the same diff, because that
decision rests on a snapshot of a quantity that varies over time.

**Why a count with target zero rather than a rate.** A rate needs a stable
denominator and this one will not hold: onboarding is mid-flight and the client
set is expected to grow. The count stays readable whatever the population does.
This choice costs nothing today and **cannot be retrofitted after collection**,
which is why it is pre-registered rather than left to analysis.

**What settles it.** Three outcomes, all terminal. Zero breaches by 2026-10-12 →
`resolved`, the claim holds for this population. Any breach → `resolved` with the
per-case inspection, because one instance is the finding. Nobody reads the series
→ `void: unattended`, which records that we failed to look.
