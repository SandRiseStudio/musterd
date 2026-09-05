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

## Amendment — a named acceptor on a lane already awaiting acceptance (2026-09-04, lane `01M1QYHJFY11HEXSX0QSEXYZNR`)

Decision 5 closed one door into the limbo it names and left the adjacent one open. The routing
block that honours `acceptor` was gated on the *transition* into `awaiting_acceptance`, so a submit
naming a seat on a lane **already** awaiting acceptance validated the name, wrote nothing, returned
200, and hinted that self-close was sanctioned. Two seats hit it inside one hour on 2026-09-04
(ryder on `01M1MMKHX8`, miley on `01M1PYA3JQ`) and both hand-minted the ask. Four decisions:

7. **A named acceptor is honoured whenever an acceptance can be pending — entering the state or
   already in it.** The condition is split, not widened: the automatic pick stays edge-triggered
   (it is the submit — audit row, picker, wake lease, breaker count), and an explicit re-route is
   its own arm with its own audit verb, `lane.review_rerouted` (detail: `reviewer`, `route: 'named'`,
   `review_grade`, `from_reviewer`, `superseded_ask`, `human_required`, `ask_tier`,
   `ask_timeout_ms`). It is **not** a second `lane.ready_for_review` row: that row is what the
   review-loop breaker counts and what decision 4's `named` counter reads, and a re-route is
   neither a bounce nor a second submit. `standingAcceptance` and `reviewRouting` read the newest of
   the two verbs, so the close edge grades the seat that actually held the ask. A re-route leases no
   wake — the named path never did (decision 6): the namer's judgement is the authority, and the
   ask waits in the inbox as it does at submit.

8. **The standing ask is superseded, and its holder is told.** If an open `lane_review` ask exists
   to a different seat, the daemon composes a `resolve` on that ask's thread to that seat, naming
   where the acceptance went. The `resolve` discharges it on the ADR 088 interrupt line and the
   open-loops gauge, and a later verdict on the superseded ask **binds to nothing** — the verdict
   lands as a message and `applyAcceptanceVerdict` returns without moving the lane. Both halves are
   required: closing the ask without the guard would let a late `accept` still close the lane, and
   two seats would each hold a binding verdict on one acceptance. The alternative — refusing a
   re-route while an ask is open — was rejected because the open ask *is* the reason to re-route
   (six asks queued on one seat at 21:46 on 2026-09-04 while three others sat idle).
   Naming the seat that already holds the open ask mints nothing and reports the standing state.

9. **A named acceptor that yields no ask is a server error, not a routing outcome.** After the
   arms, `named && !askMinted` throws `server_error` (500). The lane's state write has already
   happened; the message says so and says to submit again naming the seat. This is the durable
   half: it turns the shape that survived — validated, then unread — into a failure that cannot be
   returned as success, whichever arm forgets it next. The same reasoning refuses, **before the
   write**, an `acceptor` on a patch that does not leave the lane awaiting acceptance: a name with
   nowhere to route is the same contradiction one door over.

10. **The response says what it did.** `review.rerouted: true` with `reviewer`, `route`, and
    `superseded` (the seat whose ask was closed); the CLI and MCP hints read it back as "acceptance
    re-routed to X — Y's ask is closed and they were told". The no-acceptor hint can no longer be
    reached by a request that named one (decision 9), so it can no longer counsel `lane_resolve`
    against an explicit routing request.

Consequence for the ADR 260 eval: it scans `lane.ready_for_review` only, so re-routes do not join
the picker population (decision 4 holds by construction). Its "jumped route" rule
(`closer != asked reviewer AND closer != owner`) will, however, classify a re-routed-then-accepted
lane as jumped, because it reads the submit row's reviewer. That is a pre-registered definition and
is not edited here; a reader of that metric after 2026-09-04 subtracts lanes with a
`lane.review_rerouted` row, or amends the pre-registration dated.

Falsifiers for the amendment: a `lane_submit` naming a seat returns 200 with no `lane_review` ask
to that seat in the acts log (decision 9 failed to fire); a seat whose ask was superseded closes
the lane with its late `accept` (decision 8's guard failed); a `lane.review_rerouted` row appears
in any picker metric's denominator (decision 4 was not applied to the new verb). Mutation control
run before landing: with the re-route arm removed, the integration test
`re-routes an already-awaiting lane to a named seat` fails at its first ask assertion.

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
