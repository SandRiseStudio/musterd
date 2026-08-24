# 009 — Half of every non-landing wake is a repeat of one the rail already made

**Status:** measured 2026-08-24 · **Lane** `01M0TQWTZJ` · **Reads** ADR 250 §Eval instrument 2 ·
**Apparatus** `scripts/research/adr-250-repeat-wakes.ts` (`pnpm wakes:repeats`)

ADR 250 named three weekly reads. Two have been taken. This one — "repeat wakes with an unchanged
failure reason (→ ~zero after item 1, breaker trips a counted event)" — had never been run, and
ryder's note on that ADR of 2026-08-21 says why it stayed unrun: `#987` damped the guardian's raises
on their reason and carries a withheld count forward, so "the fix makes the repeats countable, it
does not count them." This is the counting.

## Headline (all-time, live dogfood ledger, 2026-08-24)

| Half                                                 | Outcomes | Distinct (member, lane, edge, reason) | Repeats beyond the first |
| ---------------------------------------------------- | -------- | ------------------------------------- | ------------------------ |
| **DEFERRED** — router declined before spawning, free  | 255      | 108                                   | **147 (58%)**            |
| **FAILED** — a lease was taken, the wake did not land | 82       | 40                                    | **42 (51%)**             |

**About half of every non-landing wake outcome, on both halves independently, is a re-derivation of
one the rail had already made for a reason that was still true.** ADR 250 predicts this falls to
~zero once backlog item 1 (per-edge firing memory + a spend-level breaker) lands. Item 1 has not
landed, so this is the pre-item-1 baseline, taken 19 days after the ADR that asked for it.

The two halves are never summed. ADR 250 §2 amended the doctrine to *"spend-bearing wakes require a
board transition; free state moves may use clocks"*, so a repeated deferral and a repeated failure
are different findings — one is churn the breaker cannot see, the other is a lease that was actually
taken. A blended headline would let a quiet week on one half hide a bad week on the other.

## The worst clusters, and why the span matters more than the count

    23×  gptbot · 01M018G954 · dispatch_continuation · local-session-live   [320m from 2026-08-14]
    22×  gptbot · 01M040DH9X · dispatch_continuation · local-session-live   [302m from 2026-08-17]
     9×  ryder  · (inbox)    · —                     · lease_expired        [1487m from 2026-08-05]
     3×  gptbot · 01M01WGTBQ · review                · workspace …is missing [60m from 2026-08-20]

Two edges re-derived the same conclusion 23 and 22 times inside about five hours each. That is the
pathology ADR 250 measured on 2026-08-05 ("8 lanes woke the same seat 2–5× each"), still running, and
worse per-lane than the baseline that motivated the backlog item.

**The count alone cannot carry the finding.** The largest deferral group in the ledger is `miley ·
(inbox) · local-session-live` at 26× — but its span is 28,053 minutes, or 19 days. That is a seat
that genuinely had a live session on 26 separate occasions, not a rail spinning. A 23× group inside
320 minutes and a 26× group across 19 days are the same integer and different findings, which is why
the instrument prints the span next to every cluster and does not pick a cluster threshold nobody has
argued for.

## Live instance, caught while the instrument was being written

`--days 1` on 2026-08-24 20:36: `gptbot · 01M0K6XMC0JR29A82SWP9ENZMT ·
dispatch_continuation · local-session-live`, 4 outcomes in 15 minutes, on the ADR 307 lane gptbot had
claimed twenty minutes earlier. The board re-derived "wake gptbot for this lane" every ~5 minutes and
the router declined every time for the same reason. Nothing counted it, and nothing would have.

## Interpretation, and what this does not say

The deferral half is **free**. `local-session-live` — 181 of 255 deferrals — means the router did the
right thing: it declined to spawn because a session was already live. No money burned. The finding
there is not waste, it is **absence of memory**: 147 times the rail computed an answer it had already
computed, and no breaker could see the series because nothing recorded that the last firing on that
edge said the same thing.

The failure half is the spend-bearing one, and it is where ADR 250's own named instance lives:
`lease_expired`, 37 of 82 failures. A lease was taken and the wake did not land.

**This does not measure cost.** Whether a repeated deferral is worth preventing is a judgment about
the router's tick, not about spend, and nothing here prices it.

**This does not close backlog item 1.** ADR 250 §Observability is explicit that its instruments read
rows already in the ledger, and this reads `audit` only. Item 1 is durable per-edge firing memory the
*router* consults — a different lane, and an ADR. What this closes is the ADR's complaint that its own
Eval had no periodic read.

## Method, and the criterion that can come out false

A repeat is an outcome on a `(member, lane_id, edge, reason)` seen before, counted as
attempts-beyond-the-first — a group seen once contributes 0, a group seen 23 times contributes 22.
Source: `audit` rows with action `residency.wake_deferred` or `residency.wake_failed`. Read-only; no
lane, seat or daemon touched; no spend.

ADR 250's 2026-08-06 amendment records two of its own acceptance criteria that **could not come out
false**, both because they keyed on fields every wake shape carries. So this instrument's tests are
the both-directions pair: a synthetic ledger of distinct outcomes reads **0 repeats**, and one
churning edge reads **22 from 23 attempts**. The live `--days 1` window returns **0** on the
spend-bearing half while returning 3 on the free half, so the two halves are demonstrably independent
on real data too.

Three mutations were run against the tests and each killed at least one: counting all attempts rather
than attempts-beyond-the-first (3 failures), dropping `outcome` from the group key so free deferrals
inflate the spend-bearing count (2), and joining the key on a space rather than NUL so a reason
containing a space collides with an edge containing one (1).

**Do not re-key this on `derivation`.** ADR 250's amendment corrects that conflation in public:
`work_order` is emitted by the review loop too (50 leases from 2026-07-31), so reading it as "the
dispatch loop fired" is wrong. `edge` is the discriminator.

Reproduce: `pnpm wakes:repeats` (add `--days N`, or `--json`). Falsify the headline by re-running it
against `~/.musterd/musterd.db` and disagreeing with the numbers rather than with this page.
