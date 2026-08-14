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

## The obligation interrupt is installed by ONE harness — so the seats the ladder favours are the seats it can never reach (2026-08-14; falsify: `grep -rc interrupt-check packages/cli/src/onboard/harnesses/*.ts` — claudeCode 3, cursor 0, codex 0)

ADR 225 makes a routed acceptance obligation-class, and the machinery is real: `pendingInterrupts` in `packages/server/src/store/messages.ts` admits `lane_review` asks, and `GET /inbox/interrupt-check` raises the line. But that endpoint is called by a **PostToolUse hook**, and the hook is wired by exactly one harness adapter — `claudeCode.ts`. `cursor.ts` and `codex.ts` wire nothing.

Measured over all acceptance asks, by recipient:

| seat | asks received | interrupts ever raised |
| --- | --- | --- |
| **wanderer** (grok) | **38** | **0** |
| **gptbot** (codex) | **5** | **0** |
| miley | 26 | 16 |
| stanley | 19 | 10 |
| izzo | 15 | 12 |
| dolly | 15 | 3 |

**The two mechanisms compound in the worst direction.** The ADR 188/253 ladder sorts `cross_family` first, so it deliberately routes acceptance toward model diversity — and on this team the cross-family seats are exactly the ones on other harnesses. The more the ladder prefers a different model, the more obligations land on a seat that is structurally impossible to interrupt. wanderer received 38 acceptance asks and could not be reached by the obligation rail for any of them.

That is a better explanation of the 60-minute median than inattention, and it is a correction to how this page first described the observed instance: the seat was not failing to look, it was **unreachable by design**. The audit's `interrupt.raised` row carries `actor` = the *sender* and `target` = the recipient; joining on `actor` (the intuitive read) produces a confident 0/32 that means nothing.

## No evidence the interrupt helps where it does fire — and the data cannot show it (2026-08-14; falsify: re-run the join in the section above, and read the reverse-causality note before quoting it)

Post-#785 acceptance asks, split by whether the interrupt was delivered before the lane closed: **delivered n=6, median 202m, 0 inside ten minutes. Not delivered n=22, median 25m, 6 inside ten minutes.**

Do **not** read that as "interrupts make acceptance slower." It is reverse causality by construction: the line is a tool-boundary probe over the *unread* inbox, so an ask can only be delivered if it is still sitting when the seat next runs a tool. Fast-answered asks are answered before the probe ever sees them. Delivery is partly a *marker* of having already sat.

What the numbers do establish is narrower and still useful: **there is no evidence in this log that the obligation interrupt produces ten-minute acceptance**, and 0/6 of the asks it reached were answered inside the bar — one of them 324 minutes later, interrupted at minute zero. Anyone proposing more interrupt rails as the fix for acceptance latency is proposing something this team has already shipped for its claude seats, with no measured benefit.

## A burst of acceptances is not a latency measurement (2026-08-14; falsify: the OFF window in the eval, 08-12 21:45–22:10)

The 12.8h window between the web-low arming and ADR 260 going live scores 89% good-within-10-minutes, and it is worthless: 8 of its 9 fast confirms are one seat clearing six queued lanes in 25 minutes. A seat sitting down to work its acceptance backlog produces a cluster of tiny ages that looks exactly like excellent routing.

Before citing any acceptance window, print the rows and look at who closed them and when. n is small enough here that one seat's evening changes every number on the page.

## Routing changes faster than it can be measured — 11 commits and 4 policy changes in one week (2026-08-14; falsify: `node scripts/research/adr-260-acceptance-eval.ts --rerun --days 7`)

The instrument now refuses to report a before/after when the window is contaminated, and the first thing it did was refuse. A 7-day window to 2026-08-14 contains **4 `policy.change` rows** and **11 commits** to `review.ts` / `orientation.ts` / `envelope.ts` — ADR 253, ADR 254, ADR 255, ADR 257, ADR 258, ADR 264, #785 and more.

The practical consequence: **a clean measurement window for acceptance routing may not exist on this team at the current rate of change.** That is not an argument for measuring anyway. It means any acceptance statistic quoted over a multi-day window here is describing a moving system, and the honest options are a deliberate freeze on routing code for the length of a window, or descriptive-only numbers that nobody cites as a before/after.

**And a freeze is weaker than it sounds, because the worst contamination leaves no trace** (2026-08-14; falsify: `grep -c "transcript_age_ms" ~/.musterd/host.log` against stanley's #844 / ADR 269, and the retraction note on ADR 260). A wake report whose `transcript_age_ms` was fractional was rejected whole by a `.int()` schema: 48 refusals, $22.54 of real spend, and **no ledger row for the refusal**. That ran ~3 weeks, inside both arms of the Eval that was trying to measure across it, and it inflated the lease rate by re-leasing acts that could never settle — one act held 12 leases.

Holding files still excludes the changes you can see. It cannot exclude a defect that arrives silently and distorts a denominator. So when quoting any acceptance number over a window here, the freeze buys you the visible half only — and the arm most likely to be wrong is the one whose denominator you did not think to check.

The re-run prints its numbers either way — refusing to *compare* is not the same as refusing to *look*. Descriptive read of that same dirty window, for scale: n=56 live-routed, top reviewer 55% (31/56), `cross_family` 68%, good-≤10m 38%. The concentration figure is consistent with the smaller 28h window above, which is the one number here that has now been seen twice.

## Two traps in the pre-registered definitions (2026-08-14; falsify: read the header comment of `scripts/research/adr-260-acceptance-eval.ts`)

- **A jumped route leaves the numerator, not the denominator.** The rule (`closer != asked reviewer AND closer != owner`) is written as "drop from the confirm numerator". Dropping those rows entirely raised the measured baseline from 23% to 27% — the routed ask still went unanswered, so it is a miss, not an absence.
- **The daemon is not a seat jumping the route.** `closed_by = 'musterd'` is the ADR 229 24h sweep. Classified as "jumped" it silently excludes 14 of the worst rows in the 14-day baseline.
- **A behaviour change starts when the daemon restarts, not when the PR merges** — and never at the commit's author date. #785's author date is 08-12, its merge 08-13 09:33, and the first autorefresh bounce carrying it 08-13 10:02. Cutting the window at either of the first two puts pre-change submits in the post-change bucket. See [shared-daemon](shared-daemon.md).
