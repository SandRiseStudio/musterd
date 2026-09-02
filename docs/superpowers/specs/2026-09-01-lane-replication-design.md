# Federation: the lane-replication slice — lane state reaches the hub

Lane `01M1G2J80CQGX9H3MBQYKJ70HA`, owner stanley. Builds on increment 3b-ii (`01M1FAD24JM5`, merged
`44dd3977`). Unblocks 3c (`01M12FKHB0`, hub claim CAS + seat→node residence binding).

## Why this increment

3b-ii ended with `messages` crossing machine boundaries and nothing else. ADR 331 §Decision 5 scoped
the origin stamp to `messages` deliberately — "the remaining tables follow in their own slices,
against a substrate already proven by this one" — and that substrate is now proven. This is the
`lanes` slice.

It is the slice 3c is waiting on, and the reason is not sequencing preference. A hub-authoritative
claim CAS arbitrates "exactly one holder". A hub cannot arbitrate over lanes it has never seen, and
today it sees none: lane claims stay local (`deployment-topology.md` §"Not yet true"). 3c's CAS
would guard an empty table.

## The authority split this slice must respect

ADR 325 §Decision splits lane state across two residences, and the split is the whole design
constraint:

- **Residence 1, hub-authoritative (linearizable CAS):** lane *ownership* and the transitions that
  decide it — claim, release, handoff acceptance, terminal close. "These are the facts where two
  machines must never both be right." **This is 3c, not this slice.**
- **Residence 2, locally-authoritative and replicated (append-only events):** **lane-transition
  events**, named explicitly, alongside messages and the audited verbs. "Each machine appends
  locally and syncs; nothing here requires agreement, only eventual delivery and stable order."

So this slice ships residence 2 for lanes and stops at the line. It makes lane history *arrive*. It
does not arbitrate anything, and it must not quietly acquire an arbitration rule — the moment two
machines both decide who holds a lane, this slice has become 3c and skipped the CAS.

One more sentence from the same ADR governs the shape: **"Mutable current-state replicates as events
folded locally, not as row sync."** With two named exceptions, `inbox_cursors` and
`tool_call_stats`, and `lanes` is not one of them. Row sync is out before we start.

## Finding 1 — lane transitions are ALREADY on the replicated log, and already crossing

Every lane transition emits an ordinary `message` act to `@team` carrying structured meta.
`route.ts:856-871` mints it through `routeEnvelope` beside the real mutation:

```ts
{
  body: `[lane] "${lane.title}" → ${lane.state}`,
  meta: { lane_state: { lane: lane.id, title: lane.title, state: lane.state } },
}
```

with `lane_open` and `lane_resolve` as the sibling shapes. These are `messages` rows. 3b-ii
replicates `messages`. **Therefore lane transitions already cross the wire today** — a joiner
folding the canonical order is already receiving them, and has been since `44dd3977`.

This inverts the increment. The wire is not missing. What is missing is that nothing on the
receiving side does anything with them: they land in `messages` as prose for a human to read, and
the local `lanes` table never learns.

**The trap this finding sets, and it must not be walked into:** it is now tempting to declare the
work done and just project lane state off these notes. They are not sufficient, and the reason is
concrete. `meta.lane_state` carries `{lane, title, state}` — three fields. A lane row also has
`owner_seat`, `scope`, `depends_on`, `branch`, `goal_id`, `stakes`, `detail`, `project`, and its
timestamps. A peer receiving only the announcement can render a sentence about a lane; it cannot
reconstruct one, cannot evaluate a surface overlap against it, and cannot hand 3c anything to
arbitrate. The announcement is a *notification derived from* the transition, not the transition.

## Finding 2 — the precedent ADR 325 names for the fold is a projection, not a table

ADR 325 says daemons "fold pulled events into their local store the way `goals.ts` folds today".
Read what `goals.ts` actually does (`store/goals.ts:100-126`): there is **no goals table**.
`listGoals` scans `messages` for declarations carrying `meta.goal` plus the direction-changing acts,
and derives every Goal — status, epoch, wave, outcome notes, retractions — as a read-side
projection, "both derived, never stored".

That is the named precedent, and it points away from the design this lane's own description
sketched. Stamping `lanes` with `(origin_node, origin_seq)` and folding rows into it is row sync
wearing an event's clothes: it is the thing ADR 325 excluded, and it would give `lanes` a second
insert path with all of ADR 331 §Consequences' hazards, to reach a state the log can already
express.

## Finding 3 — increment 1 already built a transition log FOR this slice, and it has three holes

The survey turned up something better than either candidate assumed. Increment 1 (`cf7b7926`, #1071)
did not only make the claim a guarded CAS; it made every lane transition leave an audit row, and it
said why in the code (`transport/http.ts:4226-4231`):

> every lane transition now leaves a durable row — the property a replicating daemon folds history
> back out of

So the substrate this slice needs was deliberately laid a month ago, and it is the **audit** log,
not the message log. Seven verbs cover the edges — `lane.claimed` carrying `previous_owner → owner`
plus a claim/handoff discriminator, `lane.state_changed` carrying `{from, to}`, `lane.released`,
`lane.ready_for_review`, `lane.closed`, and two review verbs — and their emission is exclusive by
construction, with `lane.state_changed` explicitly excluding the four edges that own their own verb.

**Three holes make it insufficient as it stands, and finding them is this increment's real result.**

1. **Two release paths write no event at all.** `releaseInFlightClaimsForSeat` (`store/lanes.ts:749`,
   on `leaveMember`) and `releaseDepartedSeatClaims` (`store/lanes.ts:776`, on the reaper tick) both
   move `claimed|active|blocked → open` and null `owner_seat` with a hardcoded UPDATE that bypasses
   `updateLane`, writes no `lane.released` row, and names no actor. A release that leaves no trace
   cannot replicate under **any** design on this page. A peer folding history would go on showing a
   holder who was released here — which is precisely "building in a lane you do not own", the
   failure ADR 325 says musterd exists to prevent, arriving through the back door.
2. **`lane.updated` records field names, never values** (`http.ts:4239`, diffed by
   `laneFieldChanges`, `lanes.ts:348-352`). Ten audited fields, and the row says only which ones
   moved. History can prove a lane's scope changed; it cannot say to what. Content edits are
   unreconstructable from audit alone.
3. **`appendAudit` swallows its own failures** (`store/audit.ts:393-399`) — "best-effort
   observability, never a gate." That is the correct posture for observability and the wrong one
   for a replication substrate. A log that may silently drop a row cannot carry a fold's
   at-least-once guarantee without that property changing, and changing it makes an audit failure
   able to fail a lane write.

`stakes_provenance` and `kind` are in no audit diff set at all, and incident-driven lane writes are
audited under `incident.*` rather than `lane.*` — two smaller instances of the same shape.

## The design question this slice exists to settle

Two candidates, and the increment's real work is choosing with evidence rather than taste.

**A. Complete the event, project the state.** Make the lane-transition event carry the whole
transition rather than a three-field announcement, and derive lane state on every daemon by folding
the log — `goals.ts`'s posture, ADR 325's named precedent. `lanes` becomes a cache of a projection
rather than an authority. No new wire kind, no new migration for origin stamps, no second insert
path.

It is also the codebase's dominant idiom rather than a novelty. The federation data census
(`wiki/federation-data-census.md:40-45`, measured 2026-08-25) counts **18 store modules that write
nothing at all** — pure read-time derivation — and names ADR 048's "derive everything else" as the
prevailing rule. Two of them are `laneSweep.ts` and `laneClose.ts`, so parts of lane behaviour
already derive rather than store. The census also names the two argued exceptions, `wake_leases` and
`requests`, where ADR 131 allowed stored state to bear correctness. That is the bar B has to clear.

The cost is the open risk and it is **unmeasured**. Every lane read becomes a scan unless the
projection is materialised, against 541 lanes and 5,518 messages at the 2026-08-18 census. No
benchmark for `listGoals` exists, so "projections are affordable here" is an assumption this
increment must test, not inherit.

**B. Stamp and fold the rows.** `lanes` gets `(origin_node, origin_seq)` per ADR 331, drawn from the
same `nodes.next_seq` allocator — never a second counter, because ADR 335 §8 already depends on one
allocator serving every replicated kind and names this slice as the case that breaks a
messages-derived head. A second fold writes lane rows. This is the shape the lane description
sketched before Finding 2, and it is the one ADR 325's row-sync sentence argues against.

**Recommendation, to be falsified rather than assumed: A.** It is what the governing ADR names, it
adds no schema, and it keeps the single-insert-path property ADR 331 called load-bearing. The
measurement that would overturn it is projection cost at a realistic lane count — if folding 541
lanes on every board read is not affordable, B's materialised row stops being a shortcut and starts
being the answer.

## Open questions this increment must answer, not assume

- **Does a joiner fold lane transitions at all, or only the hub?** 3c makes the hub authoritative
  over ownership. A joiner that projects ownership locally from a stale log would show a holder the
  hub has already displaced — the "building in a lane you do not own" failure ADR 325 calls the
  exact thing musterd exists to prevent.
- **What does a transition that arrives after a local one for the same lane do?** Under A this is
  ordering, not arbitration: stable order by `hub_seq`, last writer visible, no refusal. Getting
  this wrong is how a residence-2 slice silently becomes residence 1.
- **Do `goals` and `audit` ride this slice or take their own?** ADR 331 §5 lists all three. Goals
  are already a projection and may need nothing; audit is large and may need its own bound.
- **Does the `unknown_act` tolerance apply?** ADR 335's amendment loosened `envelope.act` to a
  string on the pull wire so a build-skewed act reaches the fold rather than 500-ing the page. A
  lane transition carrying an unknown *state* is the same shape and deserves the same deliberate
  answer, not a reflex copy.

## What Finding 3 does to the choice

Neither candidate survives unamended, and the order of work changes.

**Close the holes first, whichever design wins.** The two silent releases must emit a transition
before anything folds them, and that is a fix worth landing on its own merits — an unaudited
ownership change is a defect in a single-machine musterd too, since `lanes.ts:749` and `:776` are
the only two places a lane changes hands with no record of who did it or why. This is the first
buildable unit of this lane and it does not depend on settling A versus B.

**Then the choice narrows.** With the transition log complete, A stops being "invent a lane event"
and becomes "replicate the events increment 1 already writes" — which is why increment 1 wrote them.
B's remaining advantage shrinks to content edits (Finding 3's second hole), where a row carries
values that an audit row does not. That points at a hybrid the original two candidates missed:
**transitions replicate as events; the lane's declared content rides its `lane.updated` event with
values added.** Whether that is one design or two is the question the implementation settles.

**One correction to the lane's opening description.** It asserted lanes have "a local insert path"
that a fold would double. The survey shows one insert path exactly (`openLane`, `lanes.ts:98-156`) —
the same single-chokepoint property `insertMessage` has — so ADR 331's second-writer hazard applies
in the same shape and is no worse here. It also shows `lanes` has **no** unique index beyond its
primary key, so B would need one before a fold could be idempotent, exactly as v54 added
`idx_messages_origin` once the fold became a second writer.

**One note for 3c, recorded here so it is not rediscovered.** The claim CAS is not a SQL `WHERE`
clause — it is an in-transaction predicate re-reading the row inside the transaction
(`lanes.ts:225-235`), guarded by SQLite's single-writer lock. The handler comment
(`http.ts:4177-4180`) says the guard is "inert while this handler stays synchronous end-to-end;
load-bearing the moment an await (or a second writer) lands between the read and here." Federation
is that second writer. 3c does not add a guard to an unguarded path; it makes an already-written
guard start mattering. And exactly one of the five `updateLane` callers arms it: the PATCH handler,
and only for ownership or state patches. The acceptance path, the sweep and both incident writes all
call the unguarded form.

## Hole 3, decided: the `lane.*` rows move inside the lane write's transaction

*Added 2026-09-02 after holes 1 and 2 landed on #1173.*

Hole 1 was closed by writing the release and its row in one transaction with
`appendAuditRequired`. That is the shape every `lane.*` row needs and none of the others has:
the seven verbs the PATCH handler and `route.ts` emit are written **after** `updateLane` has
committed, through `appendAudit`, which swallows failure. Two consequences, both fatal to a fold:

- A lane can change with no row (the append failed, silently), so history has a gap the reader
  cannot see — the same shape as hole 1, one layer up.
- The write commits first and the append follows, so an append that fails leaves the log
  *behind* the table. A peer folding the log converges on the wrong state, with no signal that
  it has.

**The decision:** a `lane.*` row is not observability, it is the transition. It is written by the
store, inside the same transaction as the row it describes, with `appendAuditRequired`. If the
record cannot be written, the transition does not happen. This is the property `insertMessage`
already has for `messages` (the log *is* the write) and it is what makes the audit spine a
substrate rather than a best-effort shadow.

**The shape:** `updateLane` grows an `actor` argument and emits the verb itself, inside
`updateLaneInTx`, using the same exclusive-edge rules the handler applies now
(`http.ts:4243-4264`) — moved, not duplicated, so the two cannot drift. The handler stops
emitting `lane.*` rows and keeps only the team-visible notes. `recordLaneClose` already owns
terminal edges from three doors and stays where it is; it moves to the required form. The four
unguarded `updateLane` callers (acceptance path, sweep, both incident writes) pass their actor
and get their rows for free, which closes the incident-under-`incident.*` gap named above.

**What it costs:** an audit failure can now fail a lane write with a 500. That is the point. The
alternative — a lane that moved with no record — is the failure this whole slice exists to
prevent, and `messages` has paid the same price since v1 without incident.

**Why it is its own PR:** it changes `updateLane`'s signature at five call sites and moves ~60
lines of edge logic from transport to store. It is mechanical, but it is the kind of mechanical
that deserves a reviewer reading the before and after side by side rather than riding behind two
small fixes.

Falsifier: make `appendAuditRequired` throw inside a lane PATCH and assert the lane row is
unchanged and the response is a 500, not a 200 with a silent gap.

## Falsifier to write first

Per the 3b-ii pattern, the test precedes the design's implementation: **a lane opened and claimed on
a joiner becomes visible, with its owner and scope intact, on the hub** — not merely announced as a
sentence in the message log. Under the current build this fails at the second clause, which is
precisely the gap this slice closes and the reason Finding 1 is not a licence to skip it.

## Out of scope

Everything 3c: hub claim CAS, the seat→node residence binding, and any arbitration of ownership.
`inbox_cursors` and `tool_call_stats` remain ADR 325's direct-merge exceptions and stay untouched.

## Provenance

Opened 2026-09-01 by stanley at nick's direction, after correcting 3c's declared dependencies on the
same instruction. Findings 1 and 2 were discovered while surveying for this spec and both cut
against the lane's own opening description, which proposed B without knowing the transitions already
replicate or that the named fold precedent stores nothing.
