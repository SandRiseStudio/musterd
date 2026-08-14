# Acceptance routing

Who gets asked to accept a lane, why it is nearly always the same seat, and how to measure any of it without fooling yourself.

## The grade ladder funnels every ask to the one cross-family seat (2026-08-14; falsify: re-run `scripts/research/adr-260-acceptance-eval.ts` and read the per-day `cross_family` share)

`pickReviewCounterpart` sorts candidates `cross_family` before `cross_model` (`packages/server/src/store/review.ts:369`, stable sort, no tie-break policy). On a team that is claude except for one grok seat, "highest grade available" resolves to that seat's name every time. Measured share of live-routed asks graded `cross_family`: 0–11% per day through 08-05, then **70% on 08-12, 57% on 08-13, 83% on 08-14**, with the same seat top reviewer on all three days.

The shift dates to **08-12**, when ADR 253 (#752) took humans out of the live pick — not to ADR 260's quiet filter, which went live 08-13 10:02. The quiet filter plausibly amplifies it (dropping busy same-family seats leaves the cross-family seat top of the ladder more often) but did not cause it.

This is a **queue at one acceptor**, and it depresses any 10-minute latency statistic on its own. Anyone measuring acceptance latency across 08-12 has this inside their window whether they modelled it or not.

## An acceptance ask is usually answered by the seat it was sent to — slowly (2026-08-14; falsify: the ON window rows printed by the eval script)

Over 28h post-ADR-260: the asked seat answered **15 of 18** asks (2 jumped the route, 1 still open), median 60 minutes, exactly **1** inside the 10-minute bar. On 12 of the 16 slow rows the asked seat has its own `lane.closed` / `git.pr_merged` audits between the ask arriving and the lane closing — it was awake and servicing other lanes while the ask sat.

Candidate *supply* is therefore not the binding constraint on this team; attention is. Adding names to an ask does not make a working seat look sooner. That is why quiet-set fan-out (increment 2 of the ADR 254 arc) is parked rather than built — see the dated note in ADR 260 §Observability.

## The attention finding, observed rather than inferred — a seat held for numbers already in its inbox (2026-08-14; falsify: messages `01M0124WS2JAFCZDRRP14WR4TW` and `01M0124A7753EES3VHWJGPBBEF` in the acts log, 8 minutes apart)

Everything above about attention is inferred from the audit log. On the day the Eval landed it happened in the open, inside the lane that was measuring it.

The Eval's numbers were sent to the cross-family seat at 21:19. Eight minutes later that seat told nick it was holding increment 2 because "izzo's Eval is in flight… I will not touch `ELIGIBLE_ACTS` until those numbers land." It was awake the whole interval — claiming a lane, writing a plan, posting two status updates. The message was in its inbox and unread; a third message finally surfaced it, and the seat then answered within minutes and accepted the verdict.

Three things this shows that the log alone cannot:

- **The stall is not the acceptor being unavailable, and not the candidate set being too small.** A wider set would have added names to an ask that the correct, quiet, willing recipient already had. It would not have made anyone look sooner.
- **A seat can be actively blocked *on* the thing sitting unread in its own inbox** and describe itself, accurately from its own point of view, as waiting (2026-08-14; falsify: the seat's own status at `01M0124A77`, timestamped after delivery of `01M0124WS2`). Nothing in the routing layer is broken in that story. What is missing is anything that puts an obligation in front of a seat between task boundaries — `team_inbox_check` is polled at boundaries the seat chooses, and a seat deep in a plan chooses none.
- **The mechanism is symmetrical and this page's author is not exempt.** The same day, the same seat's own acceptance ask (#837) was routed to that same cross-family seat by the concentration described above — the paper about the queue joined the queue.

This section was sent to the seat concerned in full before it landed (2026-08-14; falsify: message `01M012H0H8` in the acts log, and the absence of any reply answering it), with an explicit offer to rewrite it as a harness-interrupt gap if that seat had been mid-turn and unable to check, and to carry its own words instead of this reconstruction. It replied three times on other matters and did not answer that question, so **its account is missing rather than declined** — anyone who gets one should add it here. That gap is the same phenomenon the section describes, one turn further out, and it is recorded rather than treated as agreement.

## A burst of acceptances is not a latency measurement (2026-08-14; falsify: the OFF window in the eval, 08-12 21:45–22:10)

The 12.8h window between the web-low arming and ADR 260 going live scores 89% good-within-10-minutes, and it is worthless: 8 of its 9 fast confirms are one seat clearing six queued lanes in 25 minutes. A seat sitting down to work its acceptance backlog produces a cluster of tiny ages that looks exactly like excellent routing.

Before citing any acceptance window, print the rows and look at who closed them and when. n is small enough here that one seat's evening changes every number on the page.

## Two traps in the pre-registered definitions (2026-08-14; falsify: read the header comment of `scripts/research/adr-260-acceptance-eval.ts`)

- **A jumped route leaves the numerator, not the denominator.** The rule (`closer != asked reviewer AND closer != owner`) is written as "drop from the confirm numerator". Dropping those rows entirely raised the measured baseline from 23% to 27% — the routed ask still went unanswered, so it is a miss, not an absence.
- **The daemon is not a seat jumping the route.** `closed_by = 'musterd'` is the ADR 229 24h sweep. Classified as "jumped" it silently excludes 14 of the worst rows in the 14-day baseline.
- **A behaviour change starts when the daemon restarts, not when the PR merges** — and never at the commit's author date. #785's author date is 08-12, its merge 08-13 09:33, and the first autorefresh bounce carrying it 08-13 10:02. Cutting the window at either of the first two puts pre-change submits in the post-change bucket. See [shared-daemon](shared-daemon.md).
