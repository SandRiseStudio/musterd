# 235 — The self-close sanction is conditional on a backstop

Status: **Accepted**

## Context

When a lane enters outcome acceptance, `lane_submit` tells the owner, verbatim:

> acceptance asked of `<seat>` (`<route>`) — wait ≤5m; accept closes the lane, reject resumes it; on
> silence, `lane_resolve` yourself (recorded unconfirmed).

The CLI says the same. Agents mostly obey it, and the result is bucket A of the review-failure
decomposition (lane `01KZ9B4BXH`): **unverified self-closes at a mean of 8.5 minutes**, with the
named acceptor never once active during the window.

That reads like impatience. It is not. It is compliance with our own instruction, and the instrument
that produced it is a five-minute wall-clock timer on a team that exists roughly 4.7 hours a day.

**"Mostly" is load-bearing, and it is a correction to this ADR's first draft** (izzo, on accepting
the lane). The hint does not compel. izzo received the old five-minute text at 09:41 on the day this
shipped — the daemon had not yet rebuilt onto the merge — and did _not_ self-close; the lane was
left with its acceptor and stayed open. One counter-example against twenty is not a refutation, but
it changes the mechanism from coercion to path-of-least-resistance: the advice makes self-closing the
obvious next move, and over twenty lanes that is enough. "Agents obey" was the stronger claim and
"agents mostly obey" is the truer one.

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

Every one of **these twenty**. The owner shut the lane unverified an average of an hour and three
quarters before a live acceptor returned, and 100% of this set returned inside the sweep's 24-hour
grace.

The scope qualifier is deliberate (ryder, reviewing the first draft). "Every one of those acceptors
came back" is a fact about twenty measured lanes on one team over roughly two weeks. It is not
"acceptors always come back", and the difference is exactly the failure mode this team hit four times
in a day: a true finding generalised one notch too far survives being re-checked, because the thing
it says _is_ true — just not of what it was applied to. Anything reading this ADR should treat 20/20
as strong evidence that the five-minute window is too short **here**, not as a law about acceptors.

### Is this really about a human's sleep cycle?

Raised as a falsification test after the decision shipped (miley): perhaps the acceptors "came back"
only because the team's asks route to its one human, so the result would be a fact about nick's sleep
cycle rather than about agents and session boundaries. Checked, and it does not hold — the split runs
the other way:

| routed acceptor | n   | came back | mean gap after the close |
| --------------- | --- | --------- | ------------------------ |
| **agent**       | 18  | 18        | **59.3 min**             |
| human           | 2   | 2         | 534.3 min                |

Eighteen of the twenty were agent-routed, and agents returned roughly **nine times faster** than the
human. So bucket A is an agent-return result, and if anything the human-routed pair is the weaker
part of the evidence — a 534-minute mean is a sleep cycle, and it is the minority case. The
falsification test strengthened the finding rather than undermining it.

One adjacent fact surfaced by the same query and worth recording because it is a real fragility, not
a footnote: every live agent seat now attests `claude-opus-5`, so ADR 188's cross-family ladder finds
no agent peer among them and a single wakeable seat is carrying essentially the whole acceptance
load. That is a separate defect from this one, and it wants its own lane.

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

**It is not reviewer re-routing.** The acceptor came back in every case measured here. Choosing a
different name would fix a failure that, in this sample, does not exist.

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

> **Amendment (2026-08-05): a path around this ADR, found live the day it was measured against.** A
> **repeat** submit — recording the merge SHA after the PR lands, which is the _normal_ flow, since
> the SHA exists only after the merge — re-routes nothing, so the server composed no `review`, and
> both clients read that silence as "no eligible acceptor is live — self-close sanctioned." Against
> two lanes whose acceptor held a pending ask. Following that hint is precisely the premature
> unverified close this ADR measured 20-for-20 and shipped to stop, reached by a branch the backstop
> advice never touched: the no-acceptor branch keeps its sanction unconditionally (correctly — where
> nobody was asked, no verdict is coming), and the repeat submit was landing in it by absence rather
> than by fact.
>
> Two additive fields on `LaneResultSchema.review` close it, and the contract change is this
> amendment's subject: **`standing: true`** marks a report of the existing acceptance state (who was
> asked at the original submit, read from the recorded ready row — never re-derived from live lane
> fields, so a later stakes edit cannot rewrite what the submit did) as distinct from a fresh routing
> decision; **`acceptance_exempt: true`** carries the ADR 234 exemption so clients word it as the
> designed path rather than the "nobody was eligible" degradation. Client rule, both surfaces: a
> standing report with a reviewer names them and says leave it with them; a missing `review`
> **abstains** — absence of a routing decision is not absence of an acceptor (the ADR 173 discipline,
> applied to the one read that never had it) — and the sanction is reserved for a recorded null-pick.
> Older clients ignore both fields; older daemons omit them and the client abstention is the safe
> floor.

## Observability & Evaluation

**Traces.** No new audit rows, and deliberately none: the decision changes advice, and advice is not
an event. What it moves is already recorded — `lane.closed` carries `reason`, `verified`, and
`time_in_review_ms`, which is exactly the triple the eval reads. The one new fact, `backstop`, is
derived from a policy row that `policy.change` already logs.

**Eval.** Dataset: `lane.closed` rows carrying `time_in_review_ms`, joined to their `lane_review` ask
and split by whether the acceptor was active during the window. Baselines, all on the pre-235
population: bucket A **n=20, mean time-in-review 8.5 minutes, 0 verified**; acceptor-returned **20 of
20 in this sample** (18 agent-routed at a 59.3-minute mean, 2 human-routed at 534.3). Re-derive the
baseline rather than quoting it if the roster's composition changes — the agent/human mix is what
that number is made of. The decision works if, on an armed team, the mean time-in-review for
owner-closed lanes rises
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
