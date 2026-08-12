# 254 — Eligible sets: addressing an act to "either of you"

- **Status:** accepted — increment 1 (the primitive, on the free rail). Increment 2 (the wake gate)
  is deliberately unbuilt; see Consequences.
- **Date:** 2026-08-12
- **Owner:** ryder
- **Supersedes / relates to:** ADR 090 (per-recipient delivery status — the derive-don't-store
  doctrine this preserves and slightly extends), ADR 088/225 (the interrupt line whose obligation
  predicate this narrows), ADR 131/252 (wake leases and wake cost — increment 2's territory), ADR 227
  (roles; role-addressed sends stay deferred), ADR 147 (`ask` tiers, whose 5m `standard` window
  increment 2 would reuse), ADR 063 (observers, who receive but never owe).

## Context

A seat has a question two teammates could each answer, and no way to say so. The addressing model has
exactly three forms (`packages/protocol/src/envelope.ts`):

```ts
{ kind: 'member', name } | { kind: 'team' } | { kind: 'broadcast' }
```

`broadcast` is wire-distinct but delivered identically to `team` (SPEC.md reserves it for future
cross-team semantics). So the sender picks between three bad options:

1. **Send to one seat.** If they do not know, the question is re-asked serially. Latency stacks.
2. **Send two directed acts.** Two open loops for one question, and if both answer, the work is
   duplicated — the precise waste the coordination thesis exists to remove. The pilot measured
   coordinated N=3 at 1.9% redundancy against uncoordinated N=3's 72%; this is that 72% in miniature,
   manufactured by the addressing model itself.
3. **Send `@team`.** Nobody owes an answer, so diffusion of responsibility applies, and it is noise
   for everyone who could not have answered.

**The demand is already measurable in the code.** `packages/mcp/src/coerce.ts` exists because models
keep passing **arrays** to `to`. It repairs `[]` → default and `[one]` → string, then gives up on the
case that matters, with a comment that has been describing this gap for months:

```ts
return null; // 2+ recipients: no single-recipient repair exists — bounce with the hint.
```

Every bounce there was a seat trying to address two teammates and being told no.

## Decision

An act may carry an **eligible set**: two to four named seats, **any one of whom discharges it**.

It is **not** a new recipient kind. The act is addressed `to: {kind:'team'}` and carries
`meta.eligible: ['stanley','izzo']`, which names who owes an answer.

### Visibility and accountability are separate axes

The subset was never about secrecy. In a system with a firehose, observers, and a public audit log,
nobody wanted those two seats to be the only ones who can _see_ the question — they wanted them to be
the only ones who _owe_ an answer. Narrowing only the axis that needed narrowing is also what makes
this cheap: the inbox visibility predicate

```sql
(to_member = ? OR to_kind IN ('team','broadcast'))
```

is copy-pasted in **seven** places across `store/messages.ts`, `store/delivery.ts`, `store/metrics.ts`,
`store/orientation.ts`, and `store/insights.ts`. A new `to_kind` would have to be threaded through all
seven and would need a table rebuild to widen the `to_kind` CHECK. Adding an arm to a predicate
duplicated seven times is how a system acquires a silent inbox bug. **This design touches none of
them, and needs no migration.**

### Three rules

1. **Eligibility is enumerated, not derived.** `meta.eligible` is 2–`MAX_ELIGIBLE` (4) distinct seat
   names: live, non-observer members of the team, excluding the sender.
2. **Any-of discharge.** The first `accept`/`decline` naming the act via `meta.in_reply_to` discharges
   it for every eligible seat.
3. **Restricted acts.** Only `message`, `request_help`, and `challenge` may carry an eligible set.

Rule 3 is what earns a single global "first answer wins" rule instead of a per-act table. A `handoff`
to two seats is incoherent — two owners is zero owners — and `accept`/`decline`/`defer`/`steer` are
structurally single-target.

### The cap is four

Above four, a named set is `@team` with extra steps and the sender should be made to say so. But the
load-bearing reason is that the cap **bounds the escalation tail** increment 2 would walk: at a
5-minute hold, four seats is ~20 minutes and at most four `wake_cost` charges. Uncapped, both the
latency and the spend of a serial walk are unbounded. The cap is what makes that cost statable in
advance.

### Validation is two-layer, by structure

`actMetaRules` receives `{act, thread, meta}` — no `from`, no roster handle — so it can enforce
**shape** and nothing more. "These seats exist, none has left, none is an observer, and none is the
sender" is necessarily a server-side check in `routeEnvelope`. It **rejects rather than dropping**: a
question addressed to a seat that cannot answer it is worse than a rejected send, because the sender
goes on believing someone owes them a reply. An observer is rejected on the same grounds — it cannot
send, so it could never discharge the act, and naming it would strand the act by construction.

### Storage, and what ADR 090 costs here

One INSERT per envelope, unchanged. `to_kind='team'`, `to_member=NULL`, and the set rides in the
existing open JSON `meta` column.

The enumeration is the only thing stored rather than derived, and that is unavoidable: every existing
recipient form is a _rule_ (`member` → one row; `team` → "live non-observer roster minus sender"),
whereas a named pair is an arbitrary enumeration. ADR 090's objection was to N _status_ rows per
broadcast; status stays fully derived, so the doctrine holds.

**One correction to the original design, found in implementation.** Any-of discharge does _not_ fall
out of the existing `answerBy`, which is scoped to a single recipient (`from_member = recipientId`) —
right for a directed act, wrong for "either of you". Without a second clause, one seat answering left
the others owing the act forever, and the ledger would have contradicted the primitive's whole promise
while every test about _recipients_ passed. The ledger therefore gains `anyAnswer(db, msg)`: the first
`accept`/`decline` naming the act **from anyone**, applied only when an eligible set is present. A
plain team act keeps per-recipient answering, because there "someone replied" genuinely does not mean
everyone else is off the hook.

### Stand-down tells you who took it

The second seat's obligation ends the moment the first answers, **and it is told who answered**.

Silent retirement was rejected: the reader may be mid-draft, and killing that work with no explanation
also denies them the chance to disagree with the answer that landed. A stand-down that does not tell
you is the same class of defect as an instrument that goes quiet.

This could not be folded off the party-scoped team timeline the way the existing `answered` list is.
The discharging `accept` is a DM to the asker, so a second eligible seat is not a party to it and
need-to-know scoping hides it — the trace is underivable client-side at any price, which is exactly
why the server owes it. `GET /inbox` carries `discharged: [{id, by}]`, and `team_inbox_check` renders
it under the act it retires.

### The obligation is inbox-class, not interrupt-class

`pendingInterrupts` admits only `urgent`, `steer`, and obligation-class acts. An eligible-set
`message` therefore lands in both seats' **inboxes** as something they owe, and does not interrupt
them mid-task — the right default for "either of you know?", which is a question, not an emergency. A
sender who needs it now still has `meta.urgent` + `urgent_reason`.

An eligible set also **narrows** `request_help`, which is otherwise interrupt-class for every seat on
the team.

### Surface: `to` accepts an array

| `to`                        | Result                            | Status   |
| --------------------------- | --------------------------------- | -------- |
| omitted / `[]`              | `{kind:'team'}`                   | existing |
| `'stanley'` / `['stanley']` | `{kind:'member'}`                 | existing |
| `['stanley','izzo']` (2–4)  | `{kind:'team'}` + `meta.eligible` | **new**  |
| 5+ names                    | rejected, pointing at `@team`     | **new**  |

The first two rows are exactly what `coerce.ts` already did, so this is additive — the only behaviour
that changes is that its 2+ bounce becomes a real path. CLI takes the same set as `--to a,b`.

**The array is sugar; the envelope stays canonical.** A multi-name send is persisted and audited as
`to_kind='team'` with `meta.eligible`, never as an array-shaped recipient, so nothing downstream of
`routeEnvelope` learns a new wire shape. An `@team`/`@broadcast` alias inside a list is **refused, not
dropped** — dropping it would send to a narrower audience than the caller asked for.

## Consequences

**The paid rail is untouched, and that was a constraint, not an accident.** `pendingInterrupts` is
shared with `claimWakeLeases`, which spends real `wake_cost`; widening its obligation predicate widens
both rails. This is safe only because the interrupt gate still requires `urgent`/`steer`/obligation,
so a plain eligible-set message never reaches the paid rail. A regression test on the residency suite
guards it.

**Increment 2 — the wake gate — is deliberately unbuilt.** An _urgent_ eligible-set act to sleeping
seats currently wakes each of them: `claimWakeLeases` iterates per enrolled member. The gate ("wake
one, hold the rest") is gated on increment 1 producing enough traffic to measure, because the hold
window's justification is a duplicate-wake rate that does not exist until the primitive is in use.
Shipping it blind would be tuning a 5-minute window against zero observations. If eligible-set acts
turn out to be almost never `urgent`, increment 2 may never be worth building — a real possible
outcome that measurement (3) below decides.

**A trap worth recording for whoever builds increment 2.** Lease expiry is **not** an "unanswered"
signal. A wake lease is discharged by the seat _reporting the wake_, not by answering it, so
`lease_expired` means _the wake never landed_ (host died, seat never came up). Anything building
escalation on `lease_expired` will escalate on the wrong signal and stay silent on the right one. The
three cases separate: expired ⇒ escalate immediately (that seat is unreachable); reported-but-unanswered
⇒ hold (they are on it), which needs an act-scoped window that **outlives** the 120s lease; declined ⇒
escalate immediately, because "not me" is positive information.

**What this does not do.** No new recipient kind — if a case later demands a subset genuinely _hidden_
from the team, that is a different feature with a different justification. No role-addressed sends;
ADR 227's deferral stands, though if role-routing later lands it can resolve a role to an eligible set
and reuse this whole mechanism. No all-of ("both of you must answer") semantics — no demand observed,
and it would require the per-recipient status rows ADR 090 rejected.

**The ledger's departed-seat behaviour improves here.** For a plain team act, recipients are
"approximated by the roster of now." An eligible set pins the names in the envelope, so a seat that
later leaves is still visibly the one who was asked. The eligible branch deliberately has no
`left_at IS NULL` filter: dropping a departed seat would rewrite history into "we never asked them".

## Observability & Evaluation

**Traces.** No new emitter is needed for the send: `meta.eligible` rides the envelope, so every
eligible-set act is self-describing in the append-only log, the audit trail, and the ADR 061 firehose,
and is already dimensioned by the ADR 101 per-act model stamp. `GET /inbox`'s `discharged: [{id, by}]`
makes stand-down observable per reader, and the ADR 090 ledger reports the narrowed recipient list on
`GET /messages/:id/delivery`. The one _deliberate_ gap: `residency.wake_held` belongs to increment 2
and is not claimed here, so nothing in this ADR pretends to observe the paid rail.

**Eval.** Dataset: the live `revive` message log — every act with `meta.eligible`, joined to the
`accept`/`decline` rows naming it via `meta.in_reply_to`. Baseline: **directed acts on the same log
over the same window**, which is the fair comparator because it is what a seat does today when two
teammates could each answer (send twice). Four pre-registered measures, all derivable from the log
alone with no new instrumentation:

1. **Adoption.** Eligible-set acts per week, and the `coerce.ts` 2+ bounce rate — which should fall
   toward zero as the surface stops rejecting what agents were already trying to send. Baseline: the
   current bounce count, which is strictly positive.
2. **Duplicate answers avoided.** Distinct seats producing an `accept`/`decline` per eligible-set act.
   Design predicts ~1.0; baseline is the 2.0 implied by sending two directed acts and both answering.
3. **Urgency share.** Fraction of eligible-set acts carrying `meta.urgent`. Baseline: the urgent share
   of directed acts. This is the number that decides whether increment 2 is worth building at all.
4. **Strand rate.** Eligible-set acts with no answer from any named seat, against the directed-act
   strand rate on the same window. If eligible sets strand _more_, diffusion of responsibility has
   followed us into the named set and the primitive is not working.

**Experiment.** None run for increment 1, deliberately, and the reason is the finding itself: the
demand is already evidenced by the `coerce.ts` bounces, so an A/B against "no eligible sets" would
measure a surface agents are provably already reaching for. The measures above are an **observational
pre-registration on the live log** instead — the ADR 051 posture for a primitive whose adoption is the
question, not its efficacy. Increment 2 _does_ warrant an experiment (wake-one-and-hold against
wake-all, on `wake_cost` and time-to-answer), and (3) is the gate on whether there is enough urgent
traffic to run one.

**Reopening triggers.** (2) sustained above 1.3, or (4) above the directed-act baseline ⇒ reopen; the
likely fix is making stand-down interrupt-class rather than inbox-class. (3) materially non-zero ⇒
build increment 2.
