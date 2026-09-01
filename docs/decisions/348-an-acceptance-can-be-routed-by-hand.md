# 348 — an acceptance can be routed by hand, and says so

- Status: proposed — 2026-09-01
- Date: 2026-09-01
- Authored by dolly on lane `01M1FBM0NCB9D3E3ZQ8RH1XBGA`, from nick's routing of lane
  `01M1F9QVG6XCFQAZSH7XSZ13JT` to `ghost`
- Builds on: [ADR 192](192-outcome-acceptance.md) (outcome acceptance, and `verified` derived from
  closer ≠ owner-at-close), [ADR 202](202-the-verdict-moves-the-lane.md) (the verdict moves the lane it judges),
  [ADR 169](169-two-stage-close.md) (the picker and the sanctioned self-close),
  [ADR 188](188-graded-review-ladder.md) (the diversity ladder and its grades),
  [ADR 056](056-research-as-first-class-practice.md) (the counts a routing feeds)

## Context

The acceptance picker chooses a counterpart and the daemon composes a `lane_review` ask. That ask is
the **only** thing an `accept` binds to: `applyAcceptanceVerdict` reads the lane id out of the ask's
server-controlled meta and refuses to infer one from anything else — deliberately, and rightly.

A human routing an acceptance by hand had no way to produce that ask, so the routing could not exist
as far as the ledger was concerned.

**Measured 2026-09-01, lane `01M1F9QVG6XCFQAZSH7XSZ13JT`.** nick routed its acceptance to `ghost`
specifically because the lane's author had reviewed 5 of the 6 PRs the work analysed — the exact case
where an independent acceptor is load-bearing. ghost re-derived the classification, ran the
falsifier, and posted a PASS. The accept auto-targeted the plain `request_help` that carried the
routing; that message's meta is NULL; `applyAcceptanceVerdict` returned at its first guard; the lane
stayed in `awaiting_acceptance` until the owner self-closed. **The close recorded `verified: false`,
`self_close`** — for work a second seat had reviewed harder than most picked acceptances get.

Every component did what it says. The gap was that nothing could tell the daemon a human had made
the routing decision, so the deliberate act of seeking independence was recorded as its absence — in
the field ADR 056 counts from.

The same shape had already been paid for elsewhere: seven of big-body's security lanes closed
`no_candidate` (nobody eligible was live, so no ask was composed at all), including three accepted
remediations.

## Decision

1. **A submit may name its acceptor.** `acceptor` on the lane PATCH, `--to <seat>` on
   `musterd lane submit`, `acceptor` on the MCP `lane_submit` tool. The named seat receives the same
   server-composed `lane_review` ask the picker's choice would receive, so its `accept` binds and
   closes the lane through the ordinary ADR 202 path. Naming an acceptor skips the picker and the
   ADR 234 acceptance exemption alike: naming a seat *is* asking for one.

2. **A named routing is recorded as `route: 'named'`, never as a pick.** The picker is what enforces
   cross-family eligibility; filing a hand-routed acceptor as though it had been chosen would assert
   a diversity guarantee nobody made. This is the corruption `laneClose.ts` already refuses for
   daemon sweeps (a system close is excluded explicitly, so a sweep never reads as a cross-seat
   review), running in the other direction.

3. **A named route's grade is observed, not promised.** It reports the pairing as it stands and
   abstains to `same_model` when it cannot prove better. Nothing is filtered on it — the namer's
   judgement is the authority.

4. **Every metric about the picker must exclude `named` rows.** They are not the picker's decisions
   and reading them as such inverts the conclusion: a human repeatedly routing to one trusted seat
   would read as the picker funnelling, a false positive on the pre-registered concentration
   hypothesis (izzo's review of #1152, tracing `liveRouted` in
   `scripts/research/adr-260-acceptance-eval.ts`). The exclusion is keyed on `route`, because `route`
   is the field a query meets.

5. **Three refusals, at the point the mistake is made**, never a silent fallback to the picker: an
   unknown seat, an observer, and the lane's own owner — that close could only ever derive
   `verified: false`, so naming yourself is refused rather than accepted and disappointed. Validation
   precedes the state write: there is no transaction on that path, and refusing after it would leave
   a lane submitted with no ask and no acceptor, which is the limbo this ADR exists to remove.

6. **Presence is deliberately NOT required.** The named seat may be offline. `ghost` was `out` and
   answered within minutes; an ask waiting in an inbox is the normal way an agent seat is reached,
   and requiring liveness would rebuild the gap for exactly the case that motivated this — the
   deliberately chosen acceptor need not be the one who happens to be live. This is the decision a
   later reader is most likely to want to re-litigate, so it is stated here rather than only in a
   function comment.

## Falsifiers

- A `named` row appears inside a picker metric's denominator — decision 4 was written and not
  applied; the conclusion that metric supports is contaminated for the window.
- Named routing becomes the common path (say, a majority of submits over a month) — the picker is
  being routed around rather than supplemented, which is a different problem than this ADR solves
  and would mean the ladder is failing to find acceptors people trust.
- A named acceptance closes with `verified: false` — the binding did not work and the ask is not
  reaching the seat named.
- Owners name acceptors who never answer, at a materially higher rate than the picker's choices —
  hand-routing would then be buying the appearance of review rather than review.

## Observability & Evaluation

- **Traces**: `lane.ready_for_review` records `reviewer` and `route: 'named'`; the close records the
  ordinary `verified` / `counterpart_confirm` derivation, so the two reads cannot disagree.
- **Eval**: the share of submits routed by hand, and the answer rate of named vs picked acceptors,
  read from the same rows. The prediction is that named routing stays rare and answers at least as
  often as the picker's picks — it is a human spending a decision on who should read something.
- **Experiment**: n/a — a routing verb; the falsifiers above are its observable failure modes.

## Consequences

- `scripts/research/adr-260-acceptance-eval.ts` gains the `route !== 'named'` filter, and the
  pre-registration it serves needs a dated amendment saying so, landed **before** the first named
  submit — otherwise the referent moves under a pre-registered metric mid-window
  ([measuring a moving page](../wiki/measuring-a-moving-page.md)). izzo owns both.
- The `named` route is a third value on a field that was two-valued since ADR 169. Readers that
  enumerate routes must handle it; the audit row is the durable source either way.
- Nothing about the picker changes. A submit that names nobody routes exactly as it did.
