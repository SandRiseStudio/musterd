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

## The design question this slice exists to settle

Two candidates, and the increment's real work is choosing with evidence rather than taste.

**A. Complete the event, project the state.** Make the lane-transition event carry the whole
transition rather than a three-field announcement, and derive lane state on every daemon by folding
the log — `goals.ts`'s posture, ADR 325's named precedent. `lanes` becomes a cache of a projection
rather than an authority. No new wire kind, no new migration for origin stamps, no second insert
path. The costs are real and must be measured, not waved at: every lane read becomes a scan unless
the projection is materialised, the corpus is 541 lanes against 5,518 messages today, and `goals.ts`
is already the slowest read on the board.

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
