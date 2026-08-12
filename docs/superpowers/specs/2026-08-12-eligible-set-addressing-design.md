# Eligible sets — addressing an act to "either of you"

- **Status:** design, awaiting approval. ADR number assigned at PR time (re-check `origin/main` first —
  numbers collide both ways).
- **Relates to:** ADR 090 (per-recipient delivery status — the derive-don't-store doctrine this
  preserves), ADR 088/225 (interrupt line), ADR 131/252 (wake leases and wake cost), ADR 227 (roles;
  role-addressed sends stay deferred, see Non-goals), ADR 147 (`ask` tiers, whose 5m `standard`
  window this reuses).

## Problem

A seat has a question two teammates could each answer, and no way to say so. The addressing model has
exactly three forms (`packages/protocol/src/envelope.ts:7`):

```ts
{ kind: 'member', name } | { kind: 'team' } | { kind: 'broadcast' }
```

`broadcast` is wire-distinct but delivered identically to `team` (SPEC.md:43-48 reserves it for future
cross-team semantics). So the sender picks between two bad options:

1. **Send to one seat.** If they don't know, the question is re-asked serially. Latency stacks.
2. **Send two directed acts.** Two open loops for one question. If both answer, the work is
   duplicated — which is the precise waste the coordination thesis exists to remove (the pilot
   measured coordinated N=3 at 1.9% redundancy against uncoordinated N=3's 72%).
3. **Send `@team`.** Nobody owes an answer, so diffusion of responsibility applies; and it is noise
   for everyone who could not have answered.

This is not hypothetical demand. `packages/mcp/src/coerce.ts:64-83` exists because models keep passing
**arrays** to `to`. It repairs `[]` → default and `[one]` → string, then gives up on the case that
matters:

```ts
return null; // 2+ recipients: no single-recipient repair exists — bounce with the hint.
```

Every bounce there is a seat that tried to address two teammates and was told no.

## Decision

An act may carry an **eligible set**: two to four named seats, **any one of whom discharges it**.

It is **not** a new recipient kind. The act is addressed `to: {kind:'team'}` and stays visible to the
whole team and the firehose; `meta.eligible: ['stanley','izzo']` names who owes an answer.

### Why visibility and accountability are separate axes

The subset was never about secrecy. In a system with a firehose, observers, and a public audit log,
nobody wanted those two seats to be the only ones who can _see_ the question — they wanted them to be
the only ones who _owe_ an answer. Narrowing only the axis that needed narrowing is also what makes
this cheap: the inbox visibility predicate

```sql
(to_member = ? OR to_kind IN ('team','broadcast'))
```

is copy-pasted in seven places — `store/messages.ts:140`, `:176`, `:440`, `store/delivery.ts:237`,
`store/metrics.ts:36`, `store/orientation.ts:140`, `store/insights.ts:150`. A new `to_kind` would have
to be threaded through all seven (and would need a table rebuild to widen the `to_kind` CHECK at
`db/migrations.ts:290`). Adding an arm to a predicate duplicated seven times is how a system acquires a
silent inbox bug. **This design touches none of them.**

### Three rules

1. **Eligibility is enumerated, not derived.** `meta.eligible` is an array of 2–4 distinct seat names:
   live, non-observer members of the team, excluding the sender. (On the cap, see "The cap is four".)
2. **Any-of discharge.** The first `accept` or `decline` naming the act via `meta.in_reply_to`
   discharges it for every eligible seat. No per-recipient status is stored; the ledger keeps
   deriving.
3. **Restricted acts.** Only `message`, `request_help`, and `challenge` may carry an eligible set.

Rule 3 is what earns the single global discharge rule. A `handoff` to two seats is incoherent — two
owners is zero owners — and `accept`/`decline`/`defer`/`steer` are structurally single-target
(`steer` in particular resolves to exactly one winner per recipient, `store/messages.ts:245-259`).
Restricting the acts removes every case where "first answer wins" would have been the wrong
semantics, so no per-act rule table is needed.

## Validation is two-layer

`actMetaRules` (`packages/protocol/src/envelope.ts:54`) takes only `{act, thread, meta}` — it has no
`from` and no roster handle. So it can enforce **shape** and nothing more:

- `meta.eligible` present ⇒ `act ∈ {message, request_help, challenge}`
- array of 2–4 distinct, non-empty strings (`MAX_ELIGIBLE = 4`)

**Roster validation happens server-side** in `routeEnvelope` (`packages/server/src/protocol/route.ts`),
in the same place a `member` target is resolved today: every name exists, is `left_at IS NULL`, is not
an observer, and is not the sender. Unknown or ineligible names reject the send rather than being
silently dropped — a question addressed to a seat that cannot answer it is worse than a rejected send.

## Storage

One INSERT per envelope, unchanged (`store/messages.ts:28`). `to_kind = 'team'`, `to_member = NULL`,
and the set rides in the existing open JSON `meta` column. **No migration.**

The enumeration is the _only_ thing that is stored rather than derived, and that is unavoidable: every
existing recipient form is a rule (`member` → one row; `team` → "live non-observer roster minus
sender"), whereas a named pair is an arbitrary enumeration. ADR 090's objection was to N _status_ rows
per broadcast; status here stays fully derived, so the doctrine holds.

## Delivery ledger

`recipientsOf` (`store/delivery.ts:30`) gains one branch: when `meta.eligible` is present, the ledger
recipients are the eligible seats, not the whole roster. The ledger tracks **obligation**, and only
those seats have one.

- `seen` stays each seat's own cursor comparison (`delivery.ts:186`) — untouched.
- `answered` needs a **second clause**, corrected 2026-08-12 during implementation.

**Correction (2026-08-12).** This spec originally claimed any-of discharge fell out for free from the
existing `answerBy`. It does not. `answerBy` is scoped to a single recipient — `from_member =
recipientId` (`delivery.ts:78`) — which is exactly right for a directed act and exactly wrong for
"either of you": bob answering would have left Ada owing the act forever, and the ledger, the
instrument that decides what is still open, would have contradicted the primitive's whole promise.

So the ledger takes one genuinely new function, `anyAnswer(db, msg)` — the first `accept`/`decline`
naming the act **from anyone** — applied only when the act carries an eligible set. A plain team act
keeps per-recipient answering, because there "someone replied" really does not mean everyone else is
off the hook. Still derived, still nothing stored: ADR 090's doctrine holds, the derivation is just
one clause larger than advertised.

Note the pre-existing caveat this inherits: for team acts, recipients are "approximated by the roster
of now." An eligible set is _better_ than the status quo here — the names are pinned in the envelope,
so a seat that later leaves the team is still visibly the one who was asked.

## Stand-down

The second seat's obligation ends the moment the first answers, and they are told who took it.

Silent retirement was rejected: the second seat may be mid-draft, and killing their work with no
explanation also denies them the chance to disagree with the answer that landed. A stand-down that
does not tell you is the same class of defect as an instrument that goes quiet.

Mechanically this is nearly free. `pendingInterrupts` (`store/messages.ts:220`) is **pure over
envelopes** — no DB handle — so it cannot call `actAnswered`. It does not need to: line 232 already
builds a `resolved` set by scanning for `resolve` acts, and discharge is the same shape. Scan the same
list, in the same pass, for an `accept`/`decline` whose `meta.in_reply_to` matches:

```
obligation = eligible.includes(me) && !discharged.has(m.id)
```

`actionNeeded` (`store/messages.ts:242`) is extended to admit an eligible-set act for a named seat.
This also **narrows** `request_help`, which is currently interrupt-class for every seat on the team
(line 244) — a small win falling out for free.

### The obligation is inbox-class, not interrupt-class

`pendingInterrupts` gates on line 265: only `urgent`, `steer`, and obligation-class acts raise the
line. An eligible-set `message` therefore lands in both seats' **inboxes** as something they owe, and
does not interrupt them mid-task. That is the right default for "either of you know?" — it is a
question, not an emergency. A sender who needs it now still has `meta.urgent` + `urgent_reason`
(`envelope.ts:77`).

## Wake escalation: wake one, hold the rest

An **urgent** eligible-set act reaches the paid rail, and this is where the design earns its keep.
`claimWakeLeases` (`store/residency.ts:835`) iterates **per enrolled member**, deriving candidates
independently — so without a gate, an urgent act eligible to two sleeping seats mints two leases and
pays two `wake_cost` charges for one question that needed one answer. The redundancy reappears on the
expensive rail.

Two things already fall out for free:

- **A live seat is never woken** (`residency.ts:854`, `hasLivePresence`). If either eligible seat is
  awake, nothing is woken at all — it simply lands in their inbox.
- **The loop already reasons per-act.** `isExhausted(db, teamId, wakeExhaustionKey(act_id, lane_id))`
  at `residency.ts:880` is act-scoped and team-wide, not member-scoped. A per-act exclusion has a
  natural home here, mirroring `liveLease` (`residency.ts:409`) keyed on `act_id` instead of
  `member_id`.

### Lease expiry is not the escalation signal

The tempting design — "escalation is free, an expiring lease _is_ the signal" — is **wrong**, and the
distinction is exactly ADR 252's. A lease is discharged by the seat **reporting the wake**
(`residency.ts:997`), not by answering it. So `lease_expired` means _the wake never landed_ (host died,
seat never came up); it does not mean "they read it and said nothing."

| What happened                   | Lease status | Right move                                          |
| ------------------------------- | ------------ | --------------------------------------------------- |
| Wake never landed               | `expired`    | Escalate **immediately** — that seat is unreachable |
| Seat woke, has not answered yet | `reported`   | **Hold** — they are on it                           |
| Seat woke and `decline`d        | `reported`   | Escalate **immediately** — positive information     |

Only the first row is free. The middle row needs a genuinely new thing: an act-scoped _"someone is on
it"_ window that **outlives the lease**. Without it the design silently degrades to "wake one, then
wake the next one 2 minutes later anyway" — `WAKE_LEASE_TTL_MS` is 120s (`residency.ts:50`), barely
longer than the wake itself takes (a resumed wake was measured at 15.2s).

### The gate

Inserted beside the existing `isExhausted` check in the candidate loop:

> Skip this candidate if another eligible seat holds a **live lease** for this act, **or** reported one
> within `WAKE_DEFER_SNOOZE_MS` — unless that seat has since `decline`d the act, which releases the
> hold at once.

The hold window reuses `WAKE_DEFER_SNOOZE_MS` (5 min, `residency.ts:59`) — already the system's
"somebody is plainly working on this, stop re-deriving" constant, and the same number as ADR 147's
`standard` ask tier. No new tunable.

Net: one act-keyed predicate alongside an act-keyed gate that already exists, plus a decline-release.
No new timer, no new table, no change to wake policy, rate caps, or cost accounting.

## Non-goals

- **A new recipient kind.** Deliberately not built; see "Why visibility and accountability are separate
  axes." If a case later demands a subset that is genuinely _hidden_ from the rest of the team, that is
  a different feature with a different justification.
- **Role-addressed sends.** ADR 227:71 defers these and designs them as resolving to _one_ holder.
  Unchanged here. An eligible set is an enumeration; if role-routing later lands, it can resolve a role
  to an eligible set and reuse this whole mechanism.
- **All-of semantics.** "Both of you must answer" is not built. No demand observed, and it would
  require the per-recipient status rows ADR 090 rejected.
- **Eligible sets on `handoff`.** See rule 3.
- **Widening `broadcast`.** The reserved kind stays reserved.

## Observability & Evaluation

**Emitted:**

- `meta.eligible` on the envelope makes every eligible-set act self-describing in the audit log and
  firehose; no new audit action needed for the send.
- `residency.wake_held {act, held_for, holder}` — a new audit row each time the gate suppresses a
  second wake. This is the metric that says whether the primitive paid for itself.
- Existing `residency.wake_leased` / `woke` / `wake_failed` / `wake_exhausted` are unchanged, so
  before/after wake counts stay comparable.

**Evaluation — does this reduce duplicated work?** Pre-registered, measurable from the log alone:

1. **Adoption.** Count eligible-set acts per week, and the `coerce.ts:83` bounce rate — which should
   fall toward zero as the surface stops rejecting what agents were already trying to send.
2. **Duplicate answers avoided.** For each eligible-set act, count distinct seats that produced an
   `accept`/`decline`. The design predicts ~1. A rate materially above 1 means stand-down is not
   landing and the retirement path needs work.
3. **Wakes saved.** `residency.wake_held` count × mean `wake_cost` over the same window.
4. **Strand rate.** Eligible-set acts with no answer after all eligible seats have been offered.
   Compare against the directed-act strand rate. If eligible sets strand _more_, diffusion of
   responsibility has followed us and the primitive is not working.

**Reopening trigger:** if (2) exceeds 1.3 sustained, or (4) exceeds the directed-act baseline,
reopen — the likely fix is making stand-down interrupt-class rather than inbox-class.

## Testing

- **Protocol:** shape validation — reject `eligible` on a disallowed act, reject `<2` names, reject
  `>4`, reject duplicates; accept the good case. Pure unit tests on `actMetaRules`.
- **Surface arity:** the table in "Surface" is the test matrix — `[]` → `@team`, `['a']` → directed
  member (asserting the existing `coerce.ts` repair is untouched), `['a','b']` → team + eligible, five
  names → rejected with a message naming `@team`. The 0/1 rows are regression guards, not new
  behaviour.
- **Server routing:** through-DB integration test per the standing rule — reject unknown / departed /
  observer / self names; assert exactly one row inserted with `to_kind='team'`.
- **Ledger:** `recipientsOf` returns only eligible seats; `answered` flips for both on the first
  reply; `answerBy` names the right seat.
- **Interrupt line:** eligible seat sees the obligation; non-eligible seat does not; the obligation
  disappears after a discharging `accept`. Pure over envelopes, so these are cheap.
- **Wake gate:** the load-bearing tests. Two sleeping eligible seats + urgent act ⇒ exactly one lease.
  Lease expires ⇒ second seat leases on the next tick. Lease reported ⇒ second seat held for 5 min.
  Woken seat declines ⇒ second seat leases immediately. One eligible seat live ⇒ zero leases.
- **Regression guard:** an existing directed act and an existing `@team` act mint the same leases they
  do today (the gate must be inert without `meta.eligible`).

## Blast radius

| File                                            | Change                                          |
| ----------------------------------------------- | ----------------------------------------------- |
| `packages/protocol/src/envelope.ts:54`          | `actMetaRules` — shape validation               |
| `packages/server/src/protocol/route.ts`         | roster validation of the named set              |
| `packages/server/src/store/delivery.ts:30`      | `recipientsOf` — eligible branch                |
| `packages/server/src/store/messages.ts:220-244` | discharge set + `actionNeeded`                  |
| `packages/server/src/store/residency.ts:878`    | the act-scoped wake hold                        |
| `packages/mcp/src/tools/send.ts`                | `to` accepts an array                           |
| `packages/mcp/src/coerce.ts:83`                 | the 2+ case stops bouncing, normalises by arity |
| `packages/cli/src/commands/send.ts:69`          | `--to a,b`                                      |

Unchanged: the `messages` schema, all seven copies of the inbox visibility predicate, wake policy,
rate caps, and cost accounting.

## Increments

Two, and the split is not cosmetic: the first is entirely on the free rail and the second touches the
paid one.

**Increment 1 — the primitive.** Protocol shape validation, roster validation in routing, the ledger
branch, discharge and stand-down in the interrupt line, and the CLI/MCP surfaces. Ships a working
eligible set with no wake behaviour: an urgent eligible-set act to sleeping seats does what it does
today. Costs nothing, changes no policy, and is independently useful — the observed scenario (two
_live_ seats, either could answer) is fully served by this increment alone.

**Increment 2 — the wake gate.** The act-scoped hold in `claimWakeLeases`, the decline-release, and
`residency.wake_held`. Gated on increment 1 producing enough eligible-set traffic to measure, because
the gate's whole justification is a duplicate-wake rate that does not exist until the primitive is in
use. Shipping it blind would be tuning a hold window against zero observations.

If increment 1 shows eligible-set acts are almost never `urgent`, increment 2 may not be worth
building at all — that is a real possible outcome and the measurement in (3) below is what decides it.

## Surface: `to` accepts an array

`to` takes an array of seat names, and the surface normalises by **arity**. This makes the thing agents
are already attempting start working, rather than teaching them a second parameter.

| `to`                        | Result                                     | Status              |
| --------------------------- | ------------------------------------------ | ------------------- |
| omitted / `[]`              | `{kind:'team'}`                            | existing, unchanged |
| `'stanley'` / `['stanley']` | `{kind:'member', name:'stanley'}`          | existing, unchanged |
| `['stanley','izzo']`        | `{kind:'team'}` + `meta.eligible`          | **new**             |
| 5+ names                    | reject — "use @team, or name at most four" | **new**             |

The 0- and 1-element rows are exactly what `coerce.ts:75-82` already does, so this is additive: the
only behaviour that changes is the `return null` bounce at line 83 becoming a real path.

**The array is sugar; the envelope stays canonical.** A 2-name send is persisted and audited as
`to_kind='team'` with `meta.eligible`, not as some array-shaped recipient. Nothing downstream of
`routeEnvelope` learns a new wire shape, and the audit log reads consistently: one act, team-visible,
two seats on the hook.

CLI takes the same set as `--to a,b` (`commands/send.ts:69`), with `@team`/`@broadcast` still rejected
as list members — a set is named seats or it is not a set.

### The cap is four

`MAX_ELIGIBLE = 4`, enforced in shape validation alongside the other `meta.eligible` rules (no roster
needed to count).

Two reasons, and the second is the one that made it worth fixing now rather than leaving open:

1. **Above four it is `@team` with extra steps.** The primitive's whole value is that a small, named
   group owes an answer. A six-name set on a twenty-seat team is diffusion of responsibility wearing an
   enumeration, and the sender should be made to say `@team` and mean it.
2. **It bounds the escalation tail.** With increment 2's 5-minute hold, an unanswered urgent act walks
   the set serially. A cap of four bounds the worst case at ~20 minutes and at most four `wake_cost`
   charges. Uncapped, both the latency and the spend are unbounded — which would quietly reintroduce
   the duplicate-wake problem the gate exists to prevent, just spread over time instead of at once.

That second reason means the cap is not merely taste: it is what makes the escalation chain's cost
statable in advance.

## Open questions

None outstanding. Both prior questions (surface ergonomics, set-size cap) were resolved by nick on
2026-08-12 and are written up above.
