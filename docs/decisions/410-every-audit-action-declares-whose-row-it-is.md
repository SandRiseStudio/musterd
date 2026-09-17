# 410 — Every audit action declares whose row it is

- Status: accepted
- Date: 2026-09-16
- Accepted: 2026-09-16, on the implementation landing in #1530 (`cb958943`)
- Relates to: [ADR 071](071-v0.3-p2-in-band-enforcement-and-audit.md) (the audit table),
  [ADR 074](074-audit-cli-reader.md) (the reader), [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md)
  (`interrupt.raised`), [ADR 219](219-quiescence-marks-a-busy-wake-candidate.md) (the wake pool reads by actor),
  [ADR 303](303-auditable-review-selection.md) (review selection reads by actor)
- Lane: `01M2P4Z39E08APB7V7WRDC1P0D` (decision), `01M2PB4PTTTKCV58E4GF15D7V6` (implementation)
- Evidence: [audit row attribution](../wiki/audit-row-attribution.md)

## Context

The `audit` table has one shape — `actor`, `action`, `target` — and five conventions for which
column holds the seat a row is *about*. The full census and the measurements are in the wiki page
above; the three facts this decision turns on:

1. **Two conventions collide inside one handler.** `interrupt.refused` (`http.ts:5554`) puts the
   seat in both columns; `interrupt.raised` (`http.ts:5586`) puts it in `target` only. A by-actor
   read of one seat's interrupt history returns its refusals and none of its raises.
2. **Three generic readers sweep every action by `actor`** — the wake pool (`review.ts:273`),
   review-counterpart selection (`review.ts:573`) and `/health`'s bounce signal
   (`quietestBusyMs`). They are not interrupt-aware and were never written to be.
3. **So the misattribution is live, not latent.** `interrupt.raised` credits the *sender* at the
   time the *recipient's* probe fired: mean lag 4.6 h, max 35 days, and seven rows where that row
   alone set a seat's "last acted". It is masked today only because busy seats emit high-frequency
   self-rows that dominate the `MAX(ts)`.

The lane that opened this offered "keep both conventions and document the split" as the cheap
option. Fact 3 removes it: there are wrong numbers now, and documentation does not change a number.

## Problem

Make "which seat acted on this row" answerable from the row itself, without a migration of 190k+
rows, without breaking the two readers that are correct today, and without asserting anything about
replicated rows this daemon did not write.

## Decision

### 1. The convention is declared per action, in one table, next to the writer

A single exported map in `store/audit.ts` — the module that owns `appendAudit` — naming, for every
action this daemon writes, which convention it uses:

```ts
export type AuditSubject = 'actor' | 'target' | 'none';
export const AUDIT_SUBJECT: Record<AuditAction, AuditSubject>;
```

`'actor'` — the acting seat is in `actor` (conventions 1, 3, 4, and most of 2).
`'target'` — the acting seat is in `target`.
`'none'` — no seat acted (machine-written rows: the wake ledger, the reaper, refusals with a null
actor).

This is the smallest thing that makes the question answerable, and it is a fact the codebase already
knows implicitly at all 74 call sites.

#### Which question the map answers

"Whose row is this *about*" and "which seat *acted*" are not the same question, and the first draft
of this section conflated them. They agree on four of the five conventions and diverge on
convention 2 — counterparty-as-actor — where the row concerns the target and was performed by the
actor.

**The map answers the second**, because that is the question its three readers ask: is this seat
working right now? So `grant.issue` is `'actor'`. The row is about the grantee and was acted by the
admin, and declaring it `'target'` would mark the grantee busy for work they did not do — the live
defect mirrored rather than fixed.

`interrupt.raised` is then the one action whose acting seat sits in `target`, and it is why the map
exists: the row is stamped when the *recipient's* tool-boundary probe fires, while `actor` holds the
seat that sent the act, a measured mean 4.6 h earlier. A probe firing IS the recipient working, so
the row is real evidence pointed at the wrong seat — which is exactly the case the three readers get
wrong today.

`'none'` is not "no seat is named". `residency.woke` names a seat in `target` and that seat did not
act; the host reported on it, and the seat's own first action lands as its own row moments later.
Crediting it would ADD attribution where there is none today, which is the opposite of the repair.

### 2. `appendAudit` refuses an action missing from the map

An unknown action throws in development and test. A new audit action cannot be added without saying
whose row it is — which is the only way this does not decay back to five undeclared conventions in
six months. This is the load-bearing half of the decision; the map alone rots.

### 3. The generic readers take a subject argument, not a column name

`lastActionByActor` (renamed `lastActionBySubject`), `quietestBusyMs` and `selectReviewCounterpart`
stop reading `a.actor` directly and read *the acting-seat column for that action*, via a single SQL
expression the map generates (`auditSubjectSql`).

This is a different axis from `selectReviewCounterpart`'s existing `excludeActions` list, and the
two stay separate: the map says WHICH COLUMN holds the seat, the list says WHICH ACTIONS COUNT AS
WORK. A claim is convention 1 and still excluded, because establishing authority is not being busy.
`interrupt.raised` is deliberately NOT added to that list — a probe at a tool boundary is a seat
working, and once it is read by `target` it is evidence about the right seat.

The wake pool then asks what ADR 219 always meant — "has this seat acted" — rather than "does this
seat's name appear in the actor column".

This corrects the three live readers without moving a single stored row.

### 4. Nothing is migrated, and `interrupt.raised` is not flipped

The stored rows stay exactly as written. Flipping `interrupt.raised` to convention 1 would need a
migration plus a cutover date, and would *lose* information: `actor: latest.from` is the only record
of who sent the interrupting act, and ADR 088's "who grabbed the mic, when, at whom" is a coherent
reading. Convention 2 is not wrong; being undeclared is.

### 5. Replicated rows are out of scope, and the map says so

`sync/fold.ts` inserts peer rows verbatim, carrying whatever convention their origin used. The map
describes rows *this* daemon writes. A reader folding a federated timeline cannot rely on it, and the
map's doc comment must say that rather than let a future reader assume otherwise.

Concretely, `auditSubjectSql` falls back to `actor` for an action absent from the map — a replicated
row from a peer running a newer build. That is what every one of these readers does today, so an
unknown verb is no worse off than before this landed.

## Consequences

The `interrupt.refused` / `interrupt.raised` split stops being a trap without either row changing.
Adding an audit action costs one map entry. The three generic readers get the right answer for every
action, including ones added later, instead of being correct only for the actions nobody thought
about.

The cost is a map of 121 entries that must be kept honest. Two things keep it so: the map is typed
`Record<AuditAction, AuditSubject>`, so widening the union without a declaration fails the build,
and decision 2 catches an action that reaches a writer as a plain string. If both are dropped this
ADR is worth nothing and the cheap option should be taken instead.

`lane.released` writes the literal `'musterd'` in the actor column (`store/lanes.ts:993`) — the same
family as the `'?'` / `'daemon'` sentinels, and a seat actually named `musterd` would collide with
it. Left as a follow-on, now visible.

Not addressed here, and left as follow-ons because each is its own decision: `claim.refused` writing
four kinds of target across six sites, `request.decide` writing two target formats, `seed.ingested`
writing two actor conventions, and the `'?'` / `'daemon'` sentinels in the seat column. The map makes
each of them *visible* — a per-action convention that cannot be stated is exactly the signal that a
writer is inconsistent — without requiring them to be fixed first.

## Observability & Evaluation

**Traces** — the map is not itself observable, and should not be: it is a compile-time fact. What is
observable is the thing it repairs. Emit nothing new; instead make the existing
`musterd report coordination` wake-pool and review-selection numbers *derivable per convention*, so
a seat counted busy can be asked which action and which column said so.

**Eval** — the headline number is **misattributed busy-marks**: how many times in a window a seat was
held out of the wake pool, or passed over as a review counterpart, on a row where it was the
counterparty rather than the subject. On today's data that is 7 rows over the table's history
(the not-exists query in the wiki page), which is the pre-change baseline. Target after this lands:
zero, by construction, because the reader consults the map rather than the column.

The guard metric is **map churn**: entries added per week. A map that needs frequent editing for
reasons other than a genuinely new action is a sign decision 1's three-way split is too coarse, and
the right response is to widen the type, not to loosen decision 2.

**Experiment** — none needed; this is falsifiable directly by the three checks below. The honest
caveat is that the live harm is currently masked by high-frequency self-rows, so a before/after
measurement on a busy team will show no difference. That is why the eval counts misattributed marks
rather than wake-pool outcomes: the outcome metric would read as "no change" and be taken as
"no problem".

## Falsify

- A by-actor read of one seat's interrupt history that still returns refusals and no raises after
  this lands.
- An audit action reachable in `packages/server/src` with no `AUDIT_SUBJECT` entry, in a build where
  decision 2 is armed.
- A wake-pool decision that still treats a seat as busy on a row where that seat is the counterparty.
