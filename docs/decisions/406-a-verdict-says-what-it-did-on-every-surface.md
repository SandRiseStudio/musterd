# 406 — A verdict says what it did, on every surface that can render it

- Status: proposed
- Date: 2026-09-16
- Relates to: [ADR 202](202-the-verdict-moves-the-lane.md) (an accept answering a
  `lane_review` ask IS the verdict), [ADR 144](144-mcp-tool-surface-measure-then-craft.md)
  (structured-first results), [ADR 147](147-human-ask-stream.md) (`askContractText`, the precedent
  for shared render text in the protocol package)
- Lane: `01M2KYF888X3J7S4XQJGTCAJB4`

## Context

ADR 202 made a message act mutate lane state: `team_send {act:'accept', reply_to:<a lane_review
ask>}` closes the lane that ask names. That is deliberate — the acceptor who answers in chat and
the acceptor who clicks on the board leave the same record — and it puts one of the few
state-mutating consequences in musterd behind an act whose *name* reads like an announcement.

Both surfaces already knew this needed saying. Neither said it where it would be read.

## Problem

Measured on 2026-09-16, by a seat that tripped it: `accept` sent to announce "I am taking this
review" closed a teammate's lane before a line of it had been read.

The sentence that would have prevented it **already existed** in
`packages/mcp/src/tools/send.ts` — "this accept WAS the acceptance verdict (ADR 202), not an
announcement … a decline on the same ask will not reopen it; `lane_update {state:'active'}` does".
It was appended to `content[].text`. A client that renders `structuredContent` and drops the prose
— the shape ADR 144 increment 3 actively encourages — receives `{lane, state:'done'}` and none of
it. The guard was invisible on exactly the surface that fires the action.

Three facts make this worse than a missing string:

1. **The action is not symmetric.** `applyAcceptanceVerdict` moves a lane only while it is still
   awaiting acceptance, and an accepted lane is `done`. So `decline` — the obvious correction — is
   a silent no-op, and `lane_update {state: 'active'}` is the only way back. That clause is the
   one both surfaces dropped.
2. **The sibling ack was already doing it right.** Twelve lines above, in the same function,
   `handoff_lane` carries its caution as a FIELD (`handoff_lane.warning`) and survives any
   renderer. Two acks, one file, one risk class, opposite treatment — and the unprotected one is
   the one that mutates a *teammate's* lane.
3. **The CLI had drifted further.** It wrote its own, shorter sentence and omitted the recovery
   clause altogether, so a terminal reader learned a lane had closed and never learned that
   `decline` would not reopen it. Two hand-maintained copies of one sentence had already diverged
   in the direction that loses the important half.

## Decision

1. **The consequence text of a lane verdict is protocol, not presentation.** `laneVerdictAck()`
   lives in `packages/protocol/src/lanes.wire.ts` and returns `{lane, state, guidance}`. This is
   the same placement and the same reason as `askContractText` (ADR 147): a sentence two or more
   surfaces must agree on is part of the contract, because the thing being agreed on is what an
   actor is told about an irreversible act.

2. **A surface renders that string; it does not compose its own.** The MCP tool puts the ack in
   `structuredContent` AND builds its prose from the same `guidance`, so the two cannot drift. The
   CLI prints that string. A new surface gets the sentence by calling the function.

3. **Guidance that guards a state change rides as a FIELD, not only as prose.** Wherever a tool
   result reports that a call changed state someone else owns, the explanation belongs in the
   structured result. Prose stays for the surfaces that render prose; it is never the only copy.
   `handoff_lane.warning` already met this bar and is unchanged by this ADR — it is the pattern
   being generalised, not a new invention.

4. **The guidance is self-contained.** It carries the lane id inside the string itself, because a renderer may surface
   one string and nothing around it.

This ADR does **not** change what `accept` does, add an act that claims a review without judging
it, or alter ADR 202's routing. An announce-without-verdict act is a real question, and this ADR
declines it rather than defers it: the cheaper repair is that the surface tells you what you just
did, and a second act for "taking this" adds vocabulary to fix a sentence that was simply not being
shown. Follows-up: none — declined in favour of the surface saying what it did; reopen only if a
seat trips this again WITH the guidance visible (2026-09-16).

## Consequences

- The last line of defence on ADR 202's state change is reachable from a structured-only client,
  which is the client shape ADR 144 pushes toward. The failure that produced this ADR cannot recur
  silently on that surface.
- One text, three call sites. The CLI's drift — a shorter sentence missing the recovery clause —
  is not fixable-and-refixable; there is nothing left to drift.
- `packages/protocol` gains a rendering helper, which is a widening of what that package holds.
  Bounded deliberately: `askContractText` (ADR 147) set this precedent and this is the second instance, not
  an open door. The test for admission is that MORE THAN ONE surface must say the same thing about
  a consequence — not that a string is merely shared.
- A structured consumer sees a new `guidance` field on `lane_verdict`. Additive; no field changes
  shape or meaning, and a consumer that ignores it is exactly as correct as before.

## Observability & Evaluation

**Traces** — none added. The verdict itself is already audited through `recordLaneClose` (ADR
202); this ADR changes what the ACTOR is told, not what the ledger records. The guidance carries a
lane id and an act name and no credential, path, or member data.

**Eval** — the measure is whether the caution is reachable without prose. Baseline 2026-09-16:
0 of 2 surfaces carried the recovery clause in a structured field (MCP prose-only, CLI prose-only
AND abbreviated), and one seat closed an unread lane through the gap that day. After: both
surfaces render one string, and the MCP result carries it in `structuredContent`. Failure is a
third surface composing its own copy, or the clause naming `lane_update` going missing again —
both of which the tests below turn red.

**Experiment** — the falsifier is a mutation, and it was run before this ADR was written: strip
`guidance` from the MCP tool's `structuredContent` and three tests fail, including one asserting
that the prose CONTAINS the structured string. A test suite that stays green through that mutation
would mean this decision is documentation rather than a constraint. The un-run half is the human
one: whether a seat reading the structured field actually stops. That needs the next seat to be
handed an acceptance ask, and it cannot be staged honestly by the seat that already knows.
