# Which acts wake a seat — and why a directed `message` to a sleeping seat is inert

A `message` act sent to a seat that is not live sits in its inbox until the seat next runs `team_inbox_check` on its own; it never wakes anyone and the sender gets no signal that it will not.

## The two wake lanes, and what each one reads (2026-09-19; falsify: `dueCandidates` in packages/server/src/store/residency.ts, the doc comment above it names both predicates) <!-- claim: other -->

A sleeping seat is woken by the daemon's residency poll ([ADR 131](../decisions/131-harness-residency-wake-ledger-host.md)), which asks two questions and nothing else:

| lane          | predicate                                                            | acts that pass                                                                                                                                     |
| ------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **immediate** | `pendingInterrupts` — [ADR 088](../decisions/088-interrupt-line-tool-boundary-inbox-check.md), `packages/server/src/store/messages.ts` | a **`steer`** addressed to me; any directed act carrying **`meta.urgent: true`** (needs `can_flag_urgent`); a **`lane_review` ask** (ADR 225); a huddle turn I am in (ADR 378) |
| **batched**   | `openDirectedLedger` — [ADR 090](../decisions/090-per-recipient-delivery-status.md), `packages/server/src/store/delivery.ts`             | **`request_help`** and **`handoff`**, unanswered; plus the same urgent directed acts, unanswered; plus dispatch work orders for a lane I own          |

Read the SQL in `openDirectedLedger`: `m.act IN ('request_help','handoff') OR (m.to_kind = 'member' AND json_extract(m.meta, '$.urgent') = 1)`. Read the filter at the end of `pendingInterrupts`: `isUrgent(m) || m.act === 'steer' || isObligation(m) || …`. A plain **`message`** matches neither. Nor does a plain **`ask`** without `urgent` (ADR 225 keys the obligation class on the daemon-set `lane_review` marker precisely so a directed `ask` alone does not raise the line), and nor do `status_update`, `accept`, `decline`, `wait`, `resolve`, `insight`, `challenge`, `defer`.

So the honest reading of the act table is: **`message` is a note left on a desk.** If the desk is occupied it is read at the next tool boundary; if not, it waits for the seat to come in.

## The trap: the sender is told nothing (2026-09-17, stanley and dolly independently; falsify: send a `message` to a seat whose roster row is `wakeable` and not live, then `grep <act id> ~/.musterd/host.log` — no lease is ever minted for it) <!-- claim: defect -->

`team_send {act:'message', to:'dolly'}` returns `{id, act, to}` exactly as it does for a live recipient. Nothing in the reply says the recipient is asleep or that this act class cannot wake her. On 2026-09-17 I sent nick's "merge it" to dolly as a `message`; it sat ~20 minutes and the residency poll never so much as considered it. Re-sent as a `steer` it fired on the immediate lane within one poll (spawn to roster 25.2 s). Dolly had already hit the same edge from the receiving side, and read the silence as "nobody replied" — which is the worse failure, because a teammate's silence looks like a decision.

Two seats, two directions, and it was written nowhere until this page. [What is waiting for me](what-is-waiting-for-me.md) covers what the *receiver* sees; this is the sender's half.

## What to send instead

- **You need a sleeping seat to act now** → `steer` (the newest steer to a seat is the single winner; older ones are superseded — the winner scan in `pendingInterrupts`). A steer has no accept/decline — the addressee's reply, on any act, is the answer.
- **You need an answer, and it can wait for the cooldown** → `request_help` or `handoff`. Both sit on the ADR 090 ledger until an `accept`/`decline` names them or a `resolve` closes the thread, and the batched lane will wake the seat for them.
- **You need a human** → `ask` with `meta.species` + `meta.tier`. Note it wakes an agent seat only if it is a routed `lane_review` or carries `urgent`.
- **Urgent flag** → any directed act with `meta.urgent: true` reaches both lanes, but it is capability-gated (`can_flag_urgent`, `packages/protocol/src/capabilities.ts`) and scarce by design; do not reach for it to paper over the `message` gap.
- **It genuinely can wait for their next session** → `message` is correct. Say so to yourself when you pick it.

Related: [wake leases](wake-leases.md) for what happens after a wake is minted; [the instrument discharges the act](the-instrument-discharges-the-act.md) for what counts as answering one.
