# 276 — The acceptance queue reports its own state

- Status: accepted
- Date: 2026-08-15
- Deciders: dolly (found it while clearing the queue, built it), nick (authorized taking the lane)
- Relates to: ADR 067 (auto-targeted accept), ADR 202 (an accept closes the lane it accepts),
  ADR 192 (lane acceptance asks), ADR 188 / ADR 253 (the review ladder refuses `same_model`),
  ADR 147 (an admin answers the latest open ask), lane 01KYX8J5XD (the first, partial fix)

## Context

Clearing five waiting lanes on 2026-08-15 produced three separate ways the acceptance queue
misdescribed itself. They are filed as one decision because they are one story: a seat cannot act
correctly on a queue that reports its own state wrongly, and each of these was invisible from inside
the queue.

## Problem

1. Four `accept` acts bound to guardian `daemon_down` asks instead of the lanes they named. Two of
   those lanes had a correct acceptance ask open at the time; it was passed over. None of the four
   lanes left `awaiting_acceptance`, so the queue did not move while the ledger recorded four
   accepts — and four outage reports now read as answered by reviews of unrelated pull requests.
   Measuring the pattern afterwards found it is not one bad afternoon: **32 of 280 threaded accepts
   (11.4%) across all seven accepting seats**, the human included. See §Observability.
2. Three of the five lanes had never routed an acceptance ask to anyone. They sat for 19 hours
   looking exactly like lanes whose reviewer was merely slow.
3. The brief showed three waiting lanes with no total. Clearing those three surfaced two more that
   had been waiting just as long.

## Decision

### 1. A verdict is auto-targeted only when nothing unrecoverable is at stake

`chooseAutoTarget` (in `@musterd/protocol`) decides what an un-threaded `accept`/`decline` answers,
and both surfaces call it:

- exactly one open ask → bind to it (ADR 067 unchanged);
- several open, none a lane acceptance → bind to the newest (ADR 067 unchanged, deliberately: a
  misdirected `request_help` answer is recoverable);
- **a lane acceptance open anywhere in the set → refuse, and list the candidates with their lane
  ids.**

The previous condition was `isLaneReviewAsk(open[0]) && open.length > 1` — it asked whether the
unrecoverable candidate happened to be _newest_, so any later plain ask switched the guard off. That
is the whole defect, and it had this shape in two copies, tested in neither.

The rule now lives in one module with one test suite. The wording of the refusal is still per
surface (`reply_to:<id>` for MCP, `--reply-to <id>` for the CLI) via an injected `ReplyToStyle`;
having two copies of the _rule_ is what let it be wrong in both places at once.

### 2. The brief says when nobody was asked

`review_debt[].no_candidate` reports that the lane entered the acceptance stage with no eligible
reviewer — `pickReviewCounterpart` returning null, which on a same-model monoculture is every seat,
because ADR 188/253 refuse to route `same_model` and ungradeable counterparts.

**This changes no routing.** The ladder's refusal is deliberate and stays. What changes is that
"waiting on a slow reviewer" and "waiting on nobody" stop looking identical, because they want
opposite responses: chase a person, or notice that no person exists.

### 3. The brief says how many are waiting

`review_debt_total` carries the full count beside the three shown. A window that does not admit it
is a window reads as the whole queue.

## Consequences

- A seat with a lane acceptance open must now name its target when anything else is open. That is
  one extra field on the call that most needed one, and the refusal lists the ids ready to paste.
- `NextBriefSchema` gains two fields, both defaulted (`no_candidate: false`,
  `review_debt_total: 0`), so a brief from an older daemon still parses. A `0` total beside a
  non-empty `review_debt` means "this daemon does not count", not "nothing is waiting".
- Not fixed here, and recorded so it is not mistaken for fixed: an undirected `to_kind: 'team'`
  ask is an auto-target candidate for _every_ seat's accept. That is what made guardian's outage
  asks reachable at all, and narrowing it touches ADR 147's admin path, so it wants its own lane.
- Also not fixed here: `musterd next` does not render `review_debt` at all, so a CLI seat sees none
  of this. Same shape as the incident banner's CLI gap (lane 01M017ZFMQ).

## Observability & Evaluation

**Traces.** The refusal is a surface-level return, not an audit act — it prevents a write rather
than making one. The measurable trace is its absence: `accept` messages whose `meta.in_reply_to`
names an ask carrying no `lane_review`, while an unanswered `lane_review` ask sat open for that
member at the same ts.

That query is **32 of 280 threaded accepts** on the ledger as of 2026-08-15 — **11.4%** — and it is
spread across every seat that has ever accepted anything:

```
dolly=7  miley=6  stanley=4  gptbot=4  nick=4  wanderer=4  ryder=3
```

This is the number that reframes the lane. I filed it believing it was four accepts of mine from one
afternoon; it is a systemic rate that predates yesterday and has caught the human seat too. Roughly
one accept in nine has been landing on something other than the lane it was about.

_Caveat on the measurement, because it bounds the claim:_ "unanswered" is approximated as "no
`accept` anywhere in the ledger binds to that ask id", since the daemon's own `answered` set is not
reconstructible from message rows alone. That proxy can call an ask open that was settled another
way (a `resolve`, a lane closed directly), so 32 is an upper bound. The unfiltered count is 35; the
direction and the spread across seats do not depend on which of the two you take.

**Eval.** ~~Re-run that query after 30 days.~~ **AMENDED 2026-08-16 — read it at 50 threaded
accepts of exposure, not on a date** (see below). **PASS: zero new rows.** **FAIL: any new row**,
which would mean the guard is reachable around some path this decision did not consider.
Separately, count `review_debt` entries carrying `no_candidate: true` — a sustained nonzero share is
evidence about the monoculture, and it is the number the ADR 260 concentration work should read next.

> **Amendment, 2026-08-16 (dolly, prompted by nick asking whether 30 days was too long).**
>
> It was, and the original unit was wrong besides. This Eval is a binary "did the guard hold", and
> what it needs is not elapsed time but **exposure** — un-threaded accepts actually sent.
>
> Measured on the live ledger the day this landed: **174 accepts in 30d, 75 in the last 7d
> (~10.7/day)**. The pre-fix mis-binding rate was **32/280 = 11.4%**, so at that volume roughly
> **one mis-bound accept per day** would be expected if the guard failed. Fifty accepts of exposure
> — about **5 days** at the current rate — already represents ~6 expected-and-absent failures. That
> is decisive for a binary; thirty days buys confidence nobody needs and delays a signal worth
> having early.
>
> **The trigger is now 50 threaded accepts, and the report must state the exposure count it read
> at.** A PASS with the exposure unstated is not a result: "zero mis-bound rows" is trivially true
> over a window where nobody accepted anything, and on this team a quiet week is a real possibility
> (accept volume swings from 5.8/day averaged over 30d to 10.7/day over the last 7).
>
> The general point, which applies past this ADR: a date-triggered Eval on a bursty team fires when
> the calendar says so, sometimes with almost no data, and reports INCONCLUSIVE — which reads
> identically to the instrument not existing. Keying on sample count self-adjusts to activity.

**Experiment.** The falsifier that drove the build: with a lane acceptance open and a plain ask
newer, an un-threaded `accept` must refuse and name the lane ask. Verified failing against the
previous rule and passing against this one, at both the pure-rule and MCP-adapter levels.
