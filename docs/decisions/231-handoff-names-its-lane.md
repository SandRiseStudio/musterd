# 231 — A handoff act names the lane it hands off

Status: **Accepted**

## Context

The orientation brief's `why` (ADR 048/084, `deriveNext` in
`packages/server/src/store/orientation.ts`) serves the latest `handoff` addressed to the reading
seat. A seat reads it at session start as a live instruction — "here is what you were handed."

ADR 173 / PR #653 fixed one failure of that: the `why` took the newest handoff with no regard for
whether its lane was still open, so it served a four-day-old "finish step 7" for a lane whose PR had
merged. `deriveNext` now walks back from the newest handoff and takes the first whose lane is not
terminal.

**That fix does not reach the case that motivated it.** Re-running `team_next` against the live
daemon on 2026-08-04 served the same stale handoff again. The message (`01KYX63T81A8DW8EM9JCDMZ1PW`,
from stanley, 2026-07-31) carries `meta = {"model":"claude-fable-5"}` — no lane. `laneOf` returns
null, and orientation deliberately serves it: ADR 173's abstain-by-showing clause says a handoff
naming no lane is _unjudgeable_, not finished, and hiding the human's words is the worse error. The
#653 test reproduced the staleness with a synthetic handoff that _did_ carry
`meta.lane_handoff.lane`, so it went green while the real instance stayed broken — a fixture more
convenient than the truth.

The gap underneath is the real subject of this ADR. Only the `lane_handoff` tool writes
`meta.lane_handoff.lane`; the daemon attaches it at `http.ts:2697`. A plain
`team_send {act:'handoff'}` (or `musterd send --act handoff`) writes a handoff with no link to the
work being handed off. **The act that means "this work is now yours" is not required to say which
work.**

### Measurement

Over the full dogfood ledger (`messages where act='handoff'`), decomposed by how many lanes the
sender owned in a non-terminal claimed state at send time:

| Handoffs | Share | Sender's live lanes at send time                     |
| -------- | ----- | ---------------------------------------------------- |
| 6 of 30  | 20%   | carry a lane already (sent via `lane_handoff`)       |
| 8 of 30  | 27%   | none carried; sender owned **exactly one** live lane |
| 6 of 30  | 20%   | none carried; sender owned **two or more**           |
| 10 of 30 | 33%   | none carried; sender owned **none**                  |

So **24 of 30 handoffs — 80% — are structurally unjudgeable by the `why`**, and two of them were
sent on 2026-08-04: this is current behaviour, not legacy data. The motivating instance
(`01KYX63T81`) falls in the exactly-one bucket.

The 33% with no live lane are real and must stay legal: a handoff can be about a branch, a question,
or a body of context that no lane covers. Any fix that makes naming a lane mandatory breaks them.

## Decision

**The daemon derives the lane for a lane-less handoff, at send time, from a fact rather than a
guess** — and warns instead of guessing when the fact is ambiguous.

On `POST /messages` with `act = 'handoff'` and no `meta.lane_handoff.lane`, the daemon reads the
sender's non-terminal claimed lanes and:

1. **Exactly one** — attaches `meta.lane_handoff = { lane, branch }` to the stored envelope. Not a
   guess: with one live lane there is nothing to choose between. The ack reports what was attached
   so the sender can see and correct it.
2. **Two or more** — stores the message unchanged and returns a warning on the ack naming the
   candidate lanes, telling the sender to use `lane_handoff` or pass `meta.lane_handoff.lane`. The
   send **succeeds**.
3. **None** — stored unchanged, no warning. The legal lane-less handoff.

This lives in the daemon, not the MCP adapter, so the CLI, the MCP tools and any future harness get
it from one implementation.

### Why not the age heuristic

The rejected alternative was to make a lane-less `why` judgeable by age — a handoff older than N
days is not a live instruction. It is cheaper and touches no send path, but it substitutes a
heuristic for a fact, and picking N is the arbitrary-threshold move ADR 229 rejected in a case where
the number at least had a measurement behind it. Attaching the lane makes the `why` checkable **by
construction**, and repairs the same hole for anything else that later asks "what was this handoff
about" — `residency.ts` already reaches for `meta.lane_handoff.lane` in two places.

### Why warn rather than refuse on ambiguity

`send.ts:134` refuses to guess when an un-threaded `accept` could bind to the wrong lane's ask, and
that precedent was considered here. It does not transfer. There, guessing **mis-attributes** a
verdict — an unrecoverable, silently wrong record. Here, declining to attach leaves the message
exactly as it is today: unjudgeable, but not wrong. Blocking a handoff over bookkeeping would trade
a real message for a derived field, against musterd's warn-never-block posture for lanes. So the
ambiguous case warns and lets the words through.

### What this does not do

It does not make the `why` hide a lane-less handoff. ADR 173's abstain-by-showing clause stands
unchanged: the unjudgeable case is still served. This decision only shrinks the unjudgeable set —
from 24 of 30 to 16 of 30 automatically, with the warning aimed at 6 more.

## Consequences

- `meta.lane_handoff` is an existing shape written by an existing path; no protocol schema changes.
  The ack gains an additive `handoff_lane` field, the same contract as `ask_contract` (ADR 147) and
  `delivery_hint` (ADR 167): older clients ignore it, older daemons omit it.
- A handoff sent while the sender holds one live lane now carries that lane even when the sender
  never mentioned it. This is visible in the ack, and `lane_handoff` / an explicit
  `meta.lane_handoff.lane` always wins.
- A seat that hands off work it does _not_ own gets no attachment (the derivation is scoped to
  `owner_seat`), which is correct — you cannot hand off what you do not hold.

## Observability & Evaluation

**Traces.** Every derivation is durable, because it happens on the sender's behalf and is otherwise
invisible to their transcript. `routeEnvelope` appends `handoff.lane_derived` with
`{ message, lane, branch, source }` on attach, and `handoff.lane_ambiguous` with
`{ message, warning }` on the warned case; both are keyed to the message id, so a row joins to the
envelope it changed. Nothing is logged for the no-lane case — it is the legal path, common enough
that logging it would drown the two rows that carry signal. The derivation also rides the send
response as `handoff_lane`, so the sender sees it at the moment it happens, not only in the ledger.

**Eval.** Dataset: `messages where act = 'handoff'` on the dogfood team — 30 rows at decision time,
with the hand-labelled baseline in Measurement above (6 carry a lane, 8 auto-attachable, 6 ambiguous,
10 genuinely lane-less). The decision is working if the unjudgeable share of _new_ handoffs falls
below the 33% floor set by the genuinely lane-less population:

```sql
SELECT
  SUM(json_extract(meta,'$.lane_handoff.lane') IS NOT NULL) AS carries_lane,
  COUNT(*)                                                  AS total
FROM messages WHERE act = 'handoff' AND ts > <adr-merge-ts>;
```

Baseline: 6 of 30 (20%) carry a lane. Target: ≥ 60% of handoffs sent after this ships, from the
8-of-24 that auto-attach plus whatever share of the 6 ambiguous cases the warning converts.

**Experiment.** None pre-registered, and deliberately not: the auto-attach arm has no meaningful
contrast — with exactly one live lane there is no second choice to compare against, so an A/B would
measure nothing. The one genuinely open question is behavioural, and it is the ambiguous branch:
does a warning actually get senders to name a lane, or do they ignore it? That has a clean natural
measurement without a designed experiment — count `handoff.lane_ambiguous` rows whose sender sent a
lane-carrying handoff within the same session. If that conversion sits near zero after ~10 ambiguous
rows, the warning is decoration and the branch needs a stronger shape (the ADR-192-style refusal
this decision declined). That is the trigger to revisit refusing — never a reason to start guessing.

**Known gap this does not close.** The 24 handoffs already in the ledger keep their empty meta, so
the `why` will go on serving stanley's 2026-07-31 handoff to dolly until a newer handoff supersedes
it. No backfill is proposed: the lane a past handoff meant is exactly the fact that was never
recorded, and inventing it now would be the guess this whole decision refuses.
