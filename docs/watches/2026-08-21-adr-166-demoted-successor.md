---
question:   Does a dangerous-direction demote still occur over a stable population?
claim_ref:  docs/decisions/166-session-liveness-by-enumeration.md
falsifier:  "Any single demoted observation whose workspace is confirmed to hold a live session at the time of the demote. Target ZERO, inherited from ADR 166 eval item 3."
population: the workspaces present in the binding registry on 2026-08-21 — agents, agents-izzo, agents-miley, agents-stanley, agents-ryder, agents-dolly, agents-wanderer, agents-gptbot, agents-kimi. A workspace added or removed inside the window voids this watch rather than silently changing the denominator.
void_if:
  - the set of sampled workspaces changes from the nine named above
  - the sweep's demote semantics change
  - packages/cli/src/host/** changes within the window, since that is the code under test
series:     ~/.musterd/research/adr-166-slot-sweep.jsonl
cadence:    5m
opened:     2026-08-21
opened_by:  izzo
revisit_by: 2026-09-11
status:     open
resolution:
---

The instrument lane `01M0JNYJ4KHAM6FMEV5BZTQ7FW` needs, replacing 48 MB of ambiguity.

**`opened_by` is izzo because the lane is still unowned, not because this is izzo's question.** It
is a wake-path question — `localSessionLiveness()` is the sole input to the rule that a backend must
never spawn beside a live local session. If that lane finds an owner, `opened_by` should move to
them in the same diff that claims it. Naming a placeholder owner is worse than naming none only if
nobody says so; this says so.

**Why the count and not the rate.** Inherited from ADR 297 rule 4 and from watching the sibling rate
watch void on this same series. Target zero survives a population change; a percentage does not.

**Why the population is enumerated by name.** The previous window's fatal flaw was a denominator
that moved without anyone noticing. Nine named workspaces make a change detectable rather than
absorbed — and detection voids the watch rather than quietly biasing it.

**What resolving this requires, and what it does not.** Resolving means the per-case inspection ADR
166 mandated: for each demote, was enumeration right? Counting instances is not inspecting them, and
a resolution that only recounts would repeat the failure this watch exists to end.
