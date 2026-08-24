# 172 — Model-family posture: the team knows, at read time, whether its agents are one family or several

- Status: accepted — 2026-07-28. Authored by ryder (lane `01KYMZG7R2H2TMD35J3R30MJCH`),
  nick-directed. Number **172** — next free above ADR 171 at branch time.
- Date: 2026-07-28
- Builds on: [ADR 169](169-two-stage-close.md) (the review counterpart picker and the
  `no_candidate` close reason this enriches — PR #450/#453 are the immediate ancestors),
  [ADR 101](101-model-as-a-variable.md) / [ADR 158](158-model-attestation-truth.md) (attestation:
  observed-over-declared, `unknown` is legal and never blocks),
  [ADR 314](314-correlated-models-correlated-mistakes.md) (correlated models make correlated mistakes — the
  family boundary is the decorrelation line), [ADR 145](145-human-role-refounded.md) (humans are
  peers with an authority overlay, not a diversity ingredient).

## Context

The first three real uses of `lane_ready` on this fleet all degraded: no eligible cross-family
counterpart was live, no review ask was routed, self-close was sanctioned — 3 of 3, zero asks sent
(izzo's datum, recorded in ADR 169's amendment). The degradation was _correct_ each time, because
every live agent seat was Claude-family. But nothing in the system could say that. The response said
"nobody is eligible" without saying what the team looked like or what would change it, and the audit
row recorded `no_candidate` without recording _why_ there was no candidate.

The structural fact underneath: a musterd seat is a **name, not a model**. `grokbot` is whatever it
attests when it is live, and that can change between sessions. The team roster therefore cannot
answer "is this fleet one family or several?" by looking at seat names — only live attestations can,
and nothing aggregated them at the team level. Three consumers each answered the family question
locally: the ADR 169 picker (per-candidate), the ADR 056 MAST diversity flags (per-chain), and any
human reading the roster (by eye).

## Problem

"No agent on this team runs outside the family the others use" is a fact the flow needs — it decides
whether cross-family review is possible, whether ADR 314 conclusions drawn this week were drawn under
monoculture, and whether the remedy for an empty reviewer pool is to wake an enrolled seat or to
enroll one. Nothing derived it, so every consumer either recomputed a slice of it or guessed.

## Decision

One derived read, `teamFamilyPosture(db, teamId, presenceTimeoutMs)`, in the store beside the picker
that motivates it. **Derived at read time, never stored** — a posture is a statement about _now_,
stamped `computed_at`; sustained monoculture is read off a series of snapshots, not off any single
one.

### Counting rules, each load-bearing

- **Family comes from live attestation only, never the seat name.** The ADR 101/158 ladder is the
  sole source; a seat's name is a label someone chose optimistically.
- **A live agent attesting `unknown` counts as `unattested`, not in the denominator.** It cannot
  prove diversity, and a wrong guess poisons the posture the way a wrong attestation poisons ADR 056
  conclusions. This is the picker's per-seat rule, applied to the aggregate.
- **Humans ride beside the posture (`humans_live`), never inside it.** Human review is its own
  requirement class — the ADR 169 risk route (user-facing, expensive, destructive, prod-touching
  lanes want a _human_ review, separately from agent review). It is not a diversity substitute: one
  live human must not make an all-Claude agent fleet read `diverse`, because a human's presence does
  not decorrelate the agents' mistakes.
- **Enrolled-but-silent agents are the `wake_pool`** — the remedy list. On this fleet, monoculture is
  fixed by _waking_ an enrolled seat (grokbot, gptbot, kimi, dolly…), not by spending on a hosted
  foreign model; the pool being named in the read-out is what makes the fix one step instead of a
  census.

### Three states, deliberately not two

- `diverse` — ≥2 distinct families among attesting agents;
- `monoculture` — ≥2 attesting agents, all one family;
- `unknown` — fewer than 2 attesting: with one or zero data points you cannot tell.

Two states would collapse "everyone **here** is Claude" into "everyone **on the team** is Claude" —
the same absent-vs-unknown conflation ADR 169's `no_candidate` fix removed one level down
(`review_timeout` asserting a question was asked when none was). Shipping that conflation again, one
layer up, the day after fixing it, would be the defect this team keeps catching wearing a new coat.

### Consumers in this increment

1. **The `lane_ready` no-candidate sanction** carries the full posture plus one bounded
   `posture_hint` line (`monoculture — 3 agents attesting, all claude; idle & enrollable: dolly,
grokbot, gptbot +2`). The degradation becomes legible at the point it is read, and the wake pool
   is the actionable half.
2. **The `lane.ready_for_review` audit row** gains a compact posture (`wake_pool` as a count, not
   names), so a _series_ of `no_candidate` rows is analyzable later without replaying presence
   history.
3. **`GET /report`** (`family_posture`, optional for back-compat) — the series a sustained-monoculture
   claim is read off, beside the MAST diversity flags that consume the same family boundary.

Roster/web surfacing is deferred — it belongs to the web owner (standing rule) and touches surfaces
this lane deliberately avoids. The picker itself is unchanged: it already applies the same rules
per-seat; the posture aggregates them, it does not re-decide them.

### Pre-registered, then decided the same day

- **The risk-route fall-through — DECIDED by nick, 2026-07-28: human review is required.** This was
  drafted as an open question; nick resolved it before the ADR merged, so the decision lands here
  with it. A risky lane (any declared `risk` tag — user-facing / expensive / destructive /
  prod-touching) now requires a **human** review, and an agent is not a substitute:
  - `pickReviewCounterpart` no longer falls through to cross-family agents when no human/admin is
    live — the pick is null, and the response says so before the worker chooses
    (`human_review_required`, `close_records: 'human_review_missed'`), with the posture attached so
    the situation is legible.
  - The ask to a live human rides the **blocking tier** (15 m hold, ADR 147/153 reachability-gated)
    instead of standard's 5 m proceed-with-risk. The tier is where "required" has teeth without a
    wedge.
  - The close derives `human_review_missed` — a requirement with no one to meet it — as distinct
    from `no_candidate`, the sanctioned empty-pool degradation. The two must not share a label for
    the same reason `no_candidate` was split from `review_timeout`.
  - Even a **verified** close can miss the requirement: an agent counterpart's confirm on a risky
    lane is a real review (`verified: true`, `counterpart_confirm`) but not the human one the risk
    demanded, so the close row additionally carries `human_review_missed: true`. Without this flag,
    routing an agent around the null pick would quietly satisfy a requirement it does not meet.
  - Never a wedge, still: nothing blocks the close. The requirement has a record, not a lock — the
    ADR 145 line this whole arc holds.
  - **Amended 2026-07-29 (ADR 173 correction #1).** This counter-metric was wrong in both directions
    at once and neither was visible: on a close whose ready row predated the requirement field, the
    read served "could not tell" as "not required" and the flag was silently omitted; and where the
    reason DID fire, `deriveReviewMetrics` had no bucket for it, so `human_review_missed` closes were
    counted as `self_close` — "never entered review", of a lane that entered review. The requirement
    is now always recorded at the ready edge (both booleans, so absence means "legacy" and nothing
    else), the close edge asserts the flag only on `=== true`, and the report carries
    `closed.human_review_missed` beside `closed.human_required_unknown` — the count of closes this
    number abstains over. Read the second before drawing any conclusion from the first.

- **Admins can only be humans — DECIDED by nick, 2026-07-28.** The first cut of the risk route
  accepted `kind === 'human' || is_admin`, which left an edge: an agent granted admin capability
  would have satisfied a _human_-review requirement. That edge is now closed at both ends. Reconcile
  — the single writer of capabilities — clamps `is_admin` to false on any agent seat, loudly (the
  declaration lands in the reconcile errors), so a seat file or an admin role can no longer
  manufacture agent authority. And the review predicates check `kind === 'human'` directly rather
  than trusting the capability bit, so the invariant holds even against a stale pre-clamp row. This
  makes ADR 145's "authority = human-only admin overlay" an enforced property instead of a
  convention.
- **ADR 169 inc 5** (spin-up ephemeral cross-family reviewer) stays parked. This posture makes its
  evidence legible (the wake pool and the no-candidate series), and makes its cheap form obvious
  (wake an enrolled seat before renting a foreign model); the ask-gated spend design remains a
  deliberate pass of its own.

## Observability & Evaluation

**Traces.** No new ledger events. The posture _rides_ existing surfaces — the `lane.ready_for_review`
audit detail (compact form) and `GET /report` (full form) — rather than minting its own, because it
is a derived projection, not an occurrence. A posture row of its own would attribute a team-level
fact to whichever request happened to compute it.

**Eval — dataset and baseline.** The baseline is the incident: 3 of 3 `lane_ready` uses degraded
with zero routed asks, and neither the response nor the audit could say why. The target, asserted by
the through-DB and integration tests: every no-candidate sanction and every `no_candidate` audit row
now carries state + families + wake pool. The live fleet is the standing dataset — today it reads
`monoculture` (3 attesting, all claude) with a 6-seat wake pool, which is the honest description of
the situation that motivated this.

**Guard metric.** The posture must never read `monoculture` from fewer than two attesting agents,
and a live human must never flip an all-one-family agent fleet to `diverse` — both are pinned by
through-DB tests, because both are the "fixed later by someone who thinks two states are enough"
regressions.

**Experiment.** The falsifier for the wake-pool remedy: the next time a lane needs cross-family
review under monoculture, wake an enrolled seat (dolly is wake-enrolled today) and measure whether
`teamFamilyPosture` flips to `diverse` within one presence timeout and the picker routes an ask. If
the woken seat attests `unknown` (no model declaration on its harness), the posture correctly stays
`unknown`-ward and the remedy documentation is wrong, not the posture — that outcome would redirect
inc 5 toward attestation coverage before reviewer spin-up.

## Consequences

- _Dated note (2026-08-24):_ the Decision's citations of "ADR 056 conclusions" resolve to
  [ADR 314](314-correlated-models-correlated-mistakes.md), the diversity charter — ADR 056 never
  stated the thesis (its acceptance amendment records this); the Decision text is frozen, so the
  repoint lives here.
- The `no_candidate` degradation stops being a shrug: it names the team's shape and who could be
  woken to change it, in the worker's own context at the moment of degradation.
- ADR 056 analyses gain a team-level series to condition on — "these chains were scored under
  sustained monoculture" becomes a lookup instead of a reconstruction.
- The posture is recomputed per read (a member scan plus one presence probe per member). At this
  fleet's size that is noise; a much larger roster would want the presence reads batched, and that
  is deliberately left until a fleet exists that needs it.
- One more thing rides the report schema (optional field, back-compat preserved).

## Related

- [ADR 169](169-two-stage-close.md) — the degradation this makes legible; its amendment (#453)
  carries the 3/3 datum.
- [ADR 158](158-model-attestation-truth.md) — why `unknown` never counts toward a conclusion.
- [ADR 148](148-feature-epoch-roster-skew.md) — the roster surface a future increment would join.
