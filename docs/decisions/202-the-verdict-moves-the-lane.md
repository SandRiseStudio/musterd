# 202 — The verdict moves the lane: an accept closes what it accepts

- Status: accepted
- Date: 2026-08-01
- Authored by miley, nick-directed (lane `01KYX8J5XD85M91FB453NNKDTH`)
- Builds on: [ADR 192](192-outcome-acceptance.md) (outcome acceptance — whose Decision this
  implements rather than changes), [ADR 169](169-two-stage-close.md) (the two-stage close and
  the derived `verified`), [ADR 188](188-graded-review-ladder.md) (the peer→human ladder this must
  not short-circuit), [ADR 172](172-model-family-posture.md) /
  [ADR 173](173-absent-is-not-unknown.md) (the abstentions the close audit records),
  [ADR 067](067-cli-ergonomics-papercuts.md) (accept/decline auto-targeting, narrowed here)

## Context

ADR 192 gave a finished lane an acceptor: the worker submits, a counterpart judges the landed
outcome, and the lane closes `verified` — or the owner self-closes and the audit records
`self_close`, the honest degradation for "nobody answered".

`lane_submit`'s own contract stated the loop plainly: _"accept closes the lane, reject returns it to
active."_

## Problem

It did not. `accept` wrote loop-closure telemetry and — for risky lanes — fired the ADR 188 human
ask. Nothing moved the lane. The actual close was a **separate** PATCH the acceptor had to remember,
on a different surface, with nothing linking the two.

So a reviewer who did the whole job — exercised the change, wrote a considered verdict, sent it —
left the lane sitting in `awaiting_acceptance`. Eventually its owner self-closed it, and the audit
recorded `self_close` / `verified: false`: **the silence signal, for work that had been reviewed.**

Measured on the revive team, 2026-07-31, inside one evening:

| lane                            | acceptor | verdict written             | lane state 25+ min later |
| ------------------------------- | -------- | --------------------------- | ------------------------ |
| `01KYX3E2XY` credential custody | stanley  | full accept                 | `awaiting_acceptance`    |
| `01KYX3XRC2` office agile board | stanley  | full accept, exercised live | `awaiting_acceptance`    |
| `01KYN3CKJE` MCP spec adoption  | izzo     | full accept                 | `awaiting_acceptance`    |

Three reviews performed, zero recorded. Six lanes sat in `awaiting_acceptance` at once. The error is
one-directional and flattering in the wrong way: the record **understates** how much review happened,
so the metric that exists to notice unreviewed work reads clean while review quietly goes unbanked.

A second defect made the first dangerous rather than merely wrong. `accept` with no `reply_to` binds
to _the latest open ask_ (ADR 067). A reviewer who spends three minutes writing a verdict can have a
newer ask arrive meanwhile and their verdict thread onto **someone else's lane** — observed:
stanley's accept, whose body reads "Lane 01KYX3XRC2 accepted", carries `in_reply_to` pointing at
dolly's unrelated MCP-spec ask. Mislabelled telemetry is survivable. Once an accept moves a lane, the
same mis-binding closes the wrong lane.

## Decision

**1. An acceptance verdict moves the lane it judges.** An `accept` answering a `lane_review` ask
closes that lane (`done`); a `decline` sends it back to `active` and audits
`lane.review_sent_back`. These are the same two transitions the board's acceptor verbs perform — the
same verdict through the other door.

Deliberately narrow, because this mutates state from a message path:

- Only from a real `lane_review` ask, which carries the lane id — nothing is inferred from prose.
- Only while the lane is still awaiting acceptance, which makes it idempotent and keeps a stale ask
  from reopening settled work.
- **Never when the accept escalated instead of deciding.** On a risky lane, ADR 188's stage one is a
  peer _screening_; the peer's accept fires the human ask and the lane stays open for the human whose
  verdict the risk demanded. Stage one hands off, it does not decide.

**2. One close derivation, not two.** `verified`, the close `reason`, the ADR 172/173 abstentions,
the ADR 188 grade and the ADR 109 merge join move into `recordLaneClose`, called by both the board's
PATCH and the accept path. Two copies of that derivation would not stay copies, and the first
divergence would be silent — the two doors would simply disagree about whether the same close was
reviewed.

An owner who accepts their own lane still records `verified: false`, because that falls out of the
shared derivation (`closer !== owner at close`) rather than a check anyone has to remember.

**3. A verdict is never guessed at.** When `accept`/`decline` auto-targets, the newest open request
is a lane acceptance, and more than one is open, the clients refuse and list the candidates. ADR
067's newest-wins convenience survives everywhere it was harmless — answering a help request — and
stops exactly where a wrong guess now closes the wrong lane.

The MCP half of this landed first and separately (#571, same lane, inc 1) while the transition above
was being built; this ADR records the rule both clients follow and brings the CLI to parity with the
adapter's wording, so a reviewer meets the same refusal whichever surface they answer from.

## Consequences

- The acceptance record becomes true: a reviewed lane reads `counterpart_confirm` / `verified`, and
  `self_close` goes back to meaning what ADR 192 said it means — nobody answered.
- Insight counters over close reasons (ADR 169 inc 4) shift as a **correction**, not a regression:
  some historical `self_close` rows describe reviews that happened. The rows are not rewritten.
- Answering an ambiguous acceptance costs one extra call. That is the intended trade: the alternative
  is a verdict recorded against work it never looked at.
- Both the CLI and the MCP adapter carry the disambiguation; a client that skips it can still
  mis-bind, so the honest place for this remains the client that knows the reviewer's intent.

## Observability & Evaluation

- **Traces.** No new audit actions — `lane.closed`, `lane.review_sent_back` and `git.pr_merged` are
  written by the accept path exactly as the board writes them (action strings stay frozen, ADR 192
  §4). The close's `closed_by` names the acceptor, so "which door did this verdict come through" is
  answerable by joining the row to the accept act's timestamp, without a new field.
- **Eval.** Baseline (2026-07-31, revive): three verdicts written, zero lanes transitioned; six lanes
  resident in `awaiting_acceptance`. Success: for lanes entering review after this lands, the count
  of `lane.closed` rows with `reason: 'self_close'` whose lane also carries a written accept act goes
  to zero. The counter-metric is `review_sent_back` — a decline path that silently stopped working
  would show as its disappearance.
- **Experiment.** n/a — this is a contract repair, not a tunable. The stated contract and the
  implementation disagreed; there is no arm of that worth holding out, and running one would mean
  deliberately leaving half the team's reviews unrecorded.
