# Audit row attribution — whose row is it

The `audit` table carries five different conventions for which seat a row is *about*, nothing marks which is in force for a given action, and three generic by-actor readers sweep every action at once.

Measured 2026-09-16 (stanley, lane `01M2P4Z39E`) on a copy of the live revive DB and a full read of
all 74 `appendAudit` call sites in `packages/server/src`. Found while measuring the claude-code
interrupt rail; the two-convention half was verified independently by izzo before the lane opened.

## The shape of a row

`appendAudit(db, teamId, {actor, action, target, result, detail})` — `store/audit.ts:553`. The
question this page answers is: given `action`, which column holds the seat the event happened *to*?

There is no single answer, and the answer is not written down anywhere the writer or the reader
can see it.

## The five conventions

| # | Convention | `actor` | `target` | Example actions |
|---|---|---|---|---|
| 1 | **self-only** | the subject seat | the same seat | `occupancy.model_attested`, `claim.occupied`, `inbox.rendered`, `workspace.repaired`, `interrupt.refused` |
| 2 | **counterparty-as-actor** | the *other* party | the subject seat | `interrupt.raised`, `member.reclaim`, `grant.issue`, `agent_seat_credential.rotated` |
| 3 | **subject-as-actor, counterparty in target** | the subject seat | a *different* seat | `send.denied`, `urgent.flagged`, `ask.raised`, `ask.surfaced` |
| 4 | **subject-as-actor, target is not a seat** | the subject seat | lane id / message id / seed id / credential id / git branch / gate class / team slug | `lane.closed`, `git.pr_merged`, `seed.promoted`, `incident.opened` |
| 5 | **null actor** (system-written) | `null` | the subject seat, *or* a credential id, *or* nothing | all `residency.*`, `claim.refused`, `claim.pending`, `bootstrap_credential.used` |

Convention 1 and convention 2 both look like "an interrupt row" to a reader. Nothing distinguishes
them but knowing the action.

## The collision is inside one handler, thirty lines apart

`GET /inbox/interrupt-check` writes both conventions in the same request path:

- `interrupt.refused` — `transport/http.ts:5554` — `actor: err.seat, target: err.seat` (convention 1)
- `interrupt.raised` — `transport/http.ts:5586` — `actor: latest.from, target: member.name` (convention 2)

So `where action like 'interrupt.%' and actor = ?` returns that seat's **refusals and none of its
raises**. The same split repeats across object lifecycles: `agent_seat_credential.minted` and
`agent_session_lease.minted` are convention 1, while `.rotated` and `.revoked` on those same objects
are convention 2.

## This is not only a latent trap — three live readers sweep every action

The lane that opened this believed both consumers read correctly by `target`
(`hasInterruptRaised`, `delivery.ts:302`). Those two do. They are the interrupt-*specific* readers.
Three **generic** readers filter or group by `actor` with no action filter at all:

- `lastActionByActor` (`store/quiescence.ts:77`) → `store/review.ts:273`, the **wake pool**. ADR 219's
  own comment: "a seat whose audit trail shows it acting seconds ago is not idle."
- `selectReviewCounterpart` (`store/review.ts:573`) — carries an `excludeActions` list for
  claims/credentials/leases ("none is work that should make a counterpart busy"). `interrupt.raised`
  is not in it.
- `quietestBusyMs` (`store/quiescence.ts:118`) → `/health` → the auto-refresher's daemon-bounce
  decision. Joins `members.name = audit.actor`, gated `kind = 'agent'`.

For a convention-2 row these credit the **sender**. An `interrupt.raised` row is stamped when the
*recipient's* probe first fires, not when the sender sent — so a seat that has done nothing for
hours is recorded as having just acted.

**Measured lag between the act being sent and the row being written** (213 rows that join their act):
median under a second, **mean 4.6 hours, max 35 days**. The worst row is
`actor=izzo, target=compo`, written 2026-09-16T22:40:30Z for an act izzo sent 2026-08-12 — izzo's own
doorbell measurement generating a row that credits izzo with activity from five weeks earlier.

Seven rows in the table's history are cases where the credited sender had **no other non-presence row
inside the 60-minute lookback**, i.e. where this row alone set that seat's "last acted"
(2026-09-16; falsify: re-run the not-exists query in the lane and get zero rows). <!-- claim: defect -->

Today the distortion is usually masked: live seats emit `record.tool_calls` and
`continuity.cursor_advanced` constantly, which dominate the `MAX(ts)`. The masking is a property of
how busy the team is, not a property of the code.

## Same action, divergent writes

No action is written with both convention 1 and convention 2 — per action the choice is at least
stable, which is what makes a declared per-action map feasible. But four actions vary in other ways:

- `seed.ingested` — 3 sites, 2 actor conventions (`seeds/ingest.ts:87` seat, `:98` null,
  `http.ts:4365` seat).
- `request.decide` — approve paths write a bare seat name, the deny path (`http.ts:2490`) writes the
  *encoded* `seat:x` / `role:y` form. `target = 'alice'` finds approvals and misses denials.
- `claim.refused` — 6 sites, 4 target kinds: null, a client-asserted string, a **role** name, a
  resolved seat.
  Counting `claim.refused` per seat is unsound (2026-09-16; falsify: group it by target on the live DB and find only resolved seat names). <!-- claim: defect -->
- `grant.issue` — 3 sites write a resolved seat, `http.ts:2518` writes `body.target` from the request,
  which may be a role.

`residency.*` rows use the sentinel `'?'` in the seat column when the member lookup fails, and
`reaper.ts:48` writes the literal `'daemon'`.

## `appendAudit` is not the only writer

Three siblings in `store/audit.ts` write the same columns, and the lane's census missed them:

- `appendReplicatedEvent` (`audit.ts:461`) — 11 sites, including every `presence.*`,
  `continuity.cursor_advanced`, `record.tool_calls`.
- `appendLaneEventRequired` — `lane.closed`, `lane.released` (actor is the constant
  `SYSTEM_RELEASER`, not a seat), `lane.ready_for_review`, `lane.review_rerouted`.
- `appendAuditRequired` — `bootstrap_credential.cutover`.

Additionally `sync/fold.ts` inserts replicated audit rows from peer nodes verbatim at 7 places, so a
foreign row carries whatever convention its origin node used. Any convention this repo declares is
therefore a statement about rows *this* daemon writes, not about every row in the table.

## What landed

[ADR 410](../decisions/410-every-audit-action-declares-whose-row-it-is.md), implemented 2026-09-16
(lane `01M2PB4PTTTKCV58E4GF15D7V6`): `AUDIT_SUBJECT` in `store/audit.ts` declares, per action,
which column holds **the seat that acted** — 121 entries, exhaustive over the `AuditAction` union by
type, with `appendAudit` and its two siblings refusing an action that is not in it. The three
generic readers read that column through `auditSubjectSql` instead of `a.actor`, and
`lastActionByActor` is now `lastActionBySubject`.

Note the map answers "which seat acted", not "whose row is it" — the two questions diverge on
convention 2, and the readers ask the first. Only `interrupt.raised` resolves to `target`; the rest
of convention 2 (`member.reclaim`, `grant.issue`, `agent_seat_credential.rotated`) resolves to
`actor`, because the admin is the one who acted. The census above is unchanged and still describes
what the columns hold.

## Related

- [ADR 088](../decisions/088-interrupt-line-tool-boundary-inbox-check.md) — where `interrupt.raised`
  is written, and the "who grabbed the mic, when, at whom" reading that makes convention 2 coherent
  on its own terms.
- [ADR 408](../decisions/408-a-workspace-repair-is-an-audit-row.md) — `workspace.repaired`,
  convention 1.
- [the instrument discharges the act](the-instrument-discharges-the-act.md) — the same failure family:
  a measurement reading a field that answers a different question.

## A record kept as a verb is invisible to a table search

Before asking whether musterd records something, list the `audit` actions — not the tables. Three
delivery-side records live as actions in this one table and none of them shows up in a `.schema`
listing: `interrupt.raised`, `interrupt.refused` ([ADR 391](../decisions/391-refused-interrupt-probe-attribution.md)),
`inbox.rendered` ([ADR 088](../decisions/088-interrupt-line-tool-boundary-inbox-check.md) Amendment 3).

Measured 2026-09-16 (izzo, lane `01M2NH5WT9`): "39 tables in `~/.musterd/musterd.db`, none of them a
delivery record" — a true sentence that produced a false conclusion. A lane was opened to build a
delivery record for `GET /inbox/interrupt-check`, and a proposed shape, an ADR and a migration were
drafted for it. `interrupt.raised` had been written by that same handler since 2026-07-05 (ADR 088
increment 1, #109); the laptop daemon held 253 rows spanning 2026-07-06 onward when the lane was
claimed on 2026-09-19 (dolly). The contract the lane set out to fix had *already cited one of those
rows* as evidence — the native append-half measurement in
[the doorbell contract](../design/daemon-doorbell-contract.md) clause 1 names `interrupt.raised`,
actor nick, target compo — without anyone reading it as the general record.

The table list is the wrong index for this question (2026-09-19; falsify: `SELECT DISTINCT action FROM audit` returns rows for a capability a `.schema` read concluded was absent). <!-- claim: other -->

The cost is not the wasted draft, which was caught. It is that the *stale* thing goes unfixed while
the missing thing gets built: the real defect here was a contract clause citing the wrong evidence
for five harnesses, and it would have survived a successful build of the duplicate record. See
[correct by coincidence](correct-by-coincidence.md) for the sibling shape — an instrument that
agrees with the truth until the question changes.
