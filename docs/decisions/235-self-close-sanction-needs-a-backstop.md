# 235 — The self-close sanction is conditional on a backstop

Status: **Accepted**

## Context

When a lane enters outcome acceptance, `lane_submit` tells the owner, verbatim:

> acceptance asked of `<seat>` (`<route>`) — wait ≤5m; accept closes the lane, reject resumes it; on
> silence, `lane_resolve` yourself (recorded unconfirmed).

The CLI says the same. Agents obey it, and the result is bucket A of the review-failure
decomposition (lane `01KZ9B4BXH`): **unverified self-closes at a mean of 8.5 minutes**, with the
named acceptor never once active during the window.

That reads like impatience. It is not. It is compliance with our own instruction, and the instrument
that produced it is a five-minute wall-clock timer on a team that exists roughly 4.7 hours a day.

### The measurement

For every bucket-A close, asking one further question — did that acceptor ever come back?

|                                                                    |                     |
| ------------------------------------------------------------------ | ------------------- |
| lanes (owner self-closed, acceptor never active during the window) | 20                  |
| owner closed after                                                 | 8.5 min (mean)      |
| **acceptor came back online afterwards**                           | **20 of 20 (100%)** |
| acceptor back within 1 hour                                        | 11 of 20 (55%)      |
| acceptor back within 24 hours                                      | 20 of 20 (100%)     |
| owner was early by                                                 | 106.8 min (mean)    |

Every single one. The owner shut the lane unverified an average of an hour and three quarters before
a live acceptor returned, and **100% returned inside the sweep's 24-hour grace**.

### Why the advice was right, and no longer is

Before ADR 229, a lane nobody accepted hung forever. Self-close was the only escape, and sanctioning
it was correct — the alternative was stranded work. That premise no longer holds where `loops.sweep`
is armed (as it now is on `revive`): an unanswered lane is collected after 24 hours. The escape
hatch has outlived the trap, and it is now the mechanism converting recoverable waits into permanent
unverified closes.

### What this is not

**It is not a labelling problem.** ADR 217 already labels these honestly: of bucket A, 13 are
`review_timeout` (legacy rows with no promised window recorded), 6 are `review_unanswered` (the owner
genuinely did wait the window it promised), 1 `review_cut_short`. The labels are accurate. The
_window_ is wrong. No relabelling work is warranted here, and `laneClose.ts`'s reason derivation is
deliberately untouched — history is derived, never rewritten (ADR 169).

**It is not reviewer re-routing.** The acceptor came back in every case. Choosing a different name
would fix a failure that does not exist.

## Decision

**The recommendation follows the backstop.** The daemon annotates the submit response's `review`
with `backstop: { armed, grace_ms }` when — and only when — an acceptor was actually asked _and_ the
team armed `loops.sweep`. Both clients advise from that fact instead of a fixed timer.

| situation                          | what the owner is told                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| acceptor asked, backstop **armed** | you are done; leave it with them. Do **not** self-close on silence — the daemon sweeps an unanswered lane after 24h. `lane_resolve` still works if you need it shut now, and records unconfirmed. |
| acceptor asked, **no** backstop    | unchanged from before this ADR: wait ≤5m, then self-close on silence.                                                                                                                             |
| **no acceptor** asked              | unchanged: self-close sanctioned.                                                                                                                                                                 |

Three properties this deliberately preserves:

- **Self-close is never removed.** Every degradation in this system is warn-and-sanction, never a
  lock (ADR 145). This changes which action is _advised_, not which is _allowed_ — the escape stays
  named in the armed branch precisely so it does not read as a wedge.
- **The no-acceptor branch keeps its sanction even with the backstop armed.** Nobody was asked, so no
  verdict is coming, and waiting out a 24-hour grace would be pure delay. The discriminator is
  `reviewer`, not the policy.
- **Absent means "no backstop", not "backstop off".** An older daemon omits the field entirely, and
  the clients treat absence exactly as they treat an unarmed team — the pre-235 advice. The
  degradation runs toward the safe answer: telling a seat to rely on a sweep that will never run
  would strand the lane forever, which is the very failure the sanction exists to prevent.

The annotation is applied at the single return site rather than inside each `review` branch: the
branches disagree about who was picked, never about whether the team armed a sweep.

## Consequences

- The `lane_submit` tool description no longer carries a fixed "wait ≤5m" — it points at the
  response, which is the only thing that knows. A description that contradicts the runtime hint is
  worse than one that defers to it.
- Teams without `loops.sweep` see no behavioural change at all. This ADR is inert until a team arms
  the backstop, which is the same opt-in posture ADR 229 shipped with.
- `backstop` is additive and optional on `LaneResultSchema`; older clients ignore it, older daemons
  omit it.
- A consequence worth stating plainly: lanes will now sit in `awaiting_acceptance` **longer**. That
  is the intent — the wait is where the verdict comes from — but it means `awaiting_acceptance` depth
  is no longer a health signal on an armed team, and anything reading it as one needs revisiting.

## Observability & Evaluation

**Traces.** No new audit rows, and deliberately none: the decision changes advice, and advice is not
an event. What it moves is already recorded — `lane.closed` carries `reason`, `verified`, and
`time_in_review_ms`, which is exactly the triple the eval reads. The one new fact, `backstop`, is
derived from a policy row that `policy.change` already logs.

**Eval.** Dataset: `lane.closed` rows carrying `time_in_review_ms`, joined to their `lane_review` ask
and split by whether the acceptor was active during the window. Baselines, all on the pre-235
population: bucket A **n=20, mean time-in-review 8.5 minutes, 0 verified**; acceptor-returned **20 of
20**. The decision works if, on an armed team, the mean time-in-review for owner-closed lanes rises
well above the old 8.5 minutes and the share of bucket-A closes falls. Success after 20 further
closes: **bucket A below 25% of unverified self-closes, and mean owner-close time above 1 hour.**

**Experiment.** None pre-registered, and the reason is structural rather than ethical this time: the
treatment is a per-team policy that is already opt-in, so `revive` (armed) versus any unarmed team is
a natural A/B with the assignment recorded in `policy.change`. Manufacturing a second arm would mean
withholding the backstop from a team that wants it. The honest limitation is that no unarmed team is
currently active enough to serve as a live control, so this is a before/after on one team until that
changes — stated so nobody later reads it as a controlled result.

**Counter-signal, and the one to actually watch.** If bucket A collapses but `review_swept` closes
rise to replace it, this has not created verdicts — it has moved unverified closes from the owner to
the daemon and made them slower. That would falsify the premise (acceptors return and answer), and
the response is not a longer grace but re-examining whether the acceptor ever intended to answer.
Watch `review_swept` count as the denominator of any claimed improvement.
