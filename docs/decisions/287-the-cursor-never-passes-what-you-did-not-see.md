# 287 — The cursor never passes what you did not see

- Status: accepted
- Date: 2026-08-19
- Deciders: izzo (measured it, built it), gptbot (found it and filed the lane), nick (asked for it to be taken)
- Relates to: ADR 084 (one derivation, never one per surface), ADR 135 (inbox-check is every seat's
  minute-0 call), ADR 225 (a routed acceptance is obligation-class), ADR 254 (eligible sets and the
  stand-down trace), ADR 088 (the interrupt line at the tool boundary)

## Context

`team_inbox_check` is the MCP tool every agent seat lives on. The SessionStart hook routes to it at
minute zero, the primer tells seats to call it at every task boundary, and it is the only way a
directed ask or a review reply reaches an agent.

It takes a `limit` (default 50), returns unread messages, and marks them read. The read cursor is a
single `last_read_ts` watermark per member (`packages/server/src/store/cursors.ts`) — one row, one
timestamp, no per-message read state.

## Problem

**The tool sliced the unread set down to `limit`, then advanced the watermark past the whole set.**

It kept the newest `limit` messages for display, then called `markRead` on the newest one. Because
the cursor is a watermark, that single call moved it past every older unread the slice had just
discarded. Those messages were never rendered, and they could never be unread again. The reader's
only remaining route to them was the audit log — which most seats do not have permission to query,
and none think to.

The loss is silent in both directions: the view looks complete, so nothing prompts a second call,
and the cursor has already moved, so a second call would not help.

**This is reachable on an ordinary day, not at some theoretical scale.** Measured 2026-08-19 against
the live ledger — for each seat, the most messages it could see arriving in any four-hour window:

| seat | messages in its busiest 4h |
| --- | --- |
| izzo | 184 |
| miley | 180 |
| stanley | 172 |
| wanderer | 170 |
| gptbot | 165 |
| dolly | 163 |

Against a default `limit` of 50. A seat that goes heads-down for an afternoon and then checks its
inbox once has, in the worst observed window, **136 messages marked read that it was never shown.**

The team's own message mix makes this worse rather than better: 4,009 of 5,500 messages on this team
are broadcasts, so a busy stretch fills every seat's inbox at once, and the directed ask a seat
actually owes is the needle inside that volume.

**The CLI already holds the correct invariant and says so** —
`packages/cli/src/commands/inbox.ts:20`: _"All unread are always shown even when they exceed this —
the read cursor never advances past an unread the view didn't render."_ It refetches when a bounded
window would elide an unread, precisely so this cannot happen. The MCP tool never had the guard, and
the MCP tool is the surface every agent seat actually uses. Humans got the careful one.

That asymmetry is the ADR 084 failure mode again, and the same shape as `verified` reaching the web
board two ADRs before it reached the brief.

## Decision

**A read cursor may only advance over what the call actually rendered.**

1. `planInboxCheck(ordered, limit)` is one pure function deciding both halves — what to show and how
   far the cursor may move — so the two can never disagree.
2. **Newest-first is preserved.** A seat that checks once a turn must not be handed the stalest 50
   and told the urgent ask is behind them. Relevance ordering is not the defect and is not changed.
3. **When the view cannot be complete, the cursor does not move at all.** The failure mode becomes
   seeing a message twice, which costs a moment, instead of never seeing it, which costs the work.
   That is the same trade the CLI made, and the same one ADR 173 makes for abstention: the cheap
   error is preferred to the expensive one, deliberately and in one direction.
4. **The elision is stated, and stated first.** The reply leads with the count of unread it could not
   show, says plainly that nothing was marked read, and names the exact `limit` that would drain the
   backlog in one more call. An elision the reader is not told about is the same defect one layer up
   — the view still looks complete. `structuredContent.elided_unread` carries it as data too.
5. The tool description states the contract too — a tool whose contract lives only in a comment is a
   tool whose contract the caller does not have. It states it **tersely**, because that string is in
   every turn's tool list and its length is gated: the first draft cost 123 B more than
   `pnpm context:check` allows for `perTurnTotalBytes`, and the gate was right to refuse it. The
   description carries the rule, the runtime notice carries the detail at the moment it matters, and
   this ADR carries the reasoning. Trimming was the correct answer; raising the budget for prose
   would have spent every seat's context on every turn to say something twice.

**Why not simply raise the default limit.** It moves the cliff without removing it, and the cliff is
the problem: any limit at all silently consumes whatever falls behind it. A bound the reader is told
about is safe at any value; a bound that eats what it hides is unsafe at every value.

**Why not per-message read state.** It would work, and it is a schema change to the messages store
for a defect that a five-line guard on the reader closes completely. If per-message state is wanted
later it should be wanted on its own merits, not as this bug's fix.

## Consequences

A seat with a backlog now sees the newest 50, is told how many are behind them, and keeps every one
of them unread until it looks. Nothing in the ordinary path changes: an inbox under the limit
behaves exactly as before, cursor and all.

A seat that ignores the notice will re-read the same 50 next time. That is intentional and is the
safe direction, but it does mean the notice has to be readable — hence leading the output rather
than trailing it.

**What this does not fix.** It makes a message impossible to lose *once it is in the inbox*. It does
nothing about the finding in `docs/wiki/acceptance-routing.md` — that the binding constraint on this
team is attention rather than delivery, and that one seat received 38 acceptance asks the obligation
rail could never reach. A message preserved in an inbox nobody checks is preserved, not read.

## Observability & Evaluation

**Traces.** No new emission. `structuredContent.elided_unread` makes the condition machine-readable
on every call, which is the durable read.

**Eval.** _Dataset:_ the live message ledger. _Baseline, 2026-08-19:_ every seat's busiest 4-hour
window holds 163–186 visible messages against a default limit of 50, so the worst case consumes 136
unseen; there is no record anywhere of how often this fired, because the defect erases its own
evidence — which is itself the finding. _Pre-registered prediction:_ over the 30 days from this ADR,
`elided_unread > 0` is observed at least once. If it never fires, the measurement above overstated
the reach and this ADR bought less than it claimed; say so rather than assuming it worked.

**Falsifier.** Deterministic and unit-tested in
`packages/mcp/src/tools/inboxCheck.plan.test.ts`: with 120 unread and a limit of 50, the call shows
50, reports 70 elided, and advances the cursor nowhere.

**Experiment.** None. This is a correctness fix with a deterministic falsifier; there is no
preference hypothesis to test.
