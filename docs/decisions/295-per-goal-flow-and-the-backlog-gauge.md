# 295 — Per-goal flow and the backlog gauge: the report answers "which goal", not just "the team"

- Status: accepted
- Date: 2026-08-21
- Builds on: ADR 050 (the insight engine — derived projections, "queries not instrumentation"),
  ADR 084 (engine placement server-side; lanes carry `goal_id`), ADR 048 (declared Goals, status
  derived and never stored), ADR 104 (the web board + insight rail — whose Consequences named this
  gap and left it open), ADR 256 (goals are the board's front door — the grid a stranger reads
  first), and ADR 258 (a shipped goal carries an outcome note)

## Context

ADR 104 shipped the board and its insight rail, and closed with an honest note in its own
Consequences:

> Gap noted, not closed: `report` surfaces `blocked` lanes and `goals` but not the `open` backlog
> column (that lives in `/lanes`), and flow metrics are team-wide, not per-goal. Increment 1 reads
> `/lanes` for the full board; per-goal analytics, if wanted, is a later insight-engine increment.

This ADR is that increment. Two things happened since that made it worth building rather than
leaving parked. ADR 256 made **goals the board's front door** — `/board` now opens on a grid of goal
cards, and the individual lanes read as work underneath them. ADR 258 then gave a shipped goal an
**outcome note**, so a card can say what the goal promised and what it delivered.

What a goal card still cannot say is how the goal is *moving*. The rail reports that the team's mean
cycle time is two days and its oldest work-in-progress is eleven days old; it cannot say which goal
that eleven days belongs to. The board's front door is organised by goal, and the analytics behind it
are organised by team — so the one question the layout invites, *"which of these is dragging?"*, is
the one question the projection cannot answer.

The backlog half is smaller but the same shape: `report` lists `blocked` lanes as its exception list
and every declared Goal with derived status, but never the `open` count. Any surface wanting the
queue must also fetch `/lanes`, which the web board does — and which the CLI and MCP report, having
no second fetch, simply go without.

## Problem

Dimension flow by Goal under the invariants ADR 050 set and ADR 104 restated:

- **Nothing stored.** The numbers are projections over lanes, computed at read time, exactly as the
  team-wide block is. No new table, no new column, no counter incremented on write.
- **No second goal list.** `report.goals` is already the declared roster with derived status. A
  per-goal analytics block that also enumerated goals would be a second source of the same truth,
  free to drift from the first.
- **No new endpoint.** `GET /teams/:slug/report` is the one projection every surface renders. This
  adds to it rather than beside it.
- **A strictly-validating client cannot be broken.** Both clients parse the response against the
  schema and fail closed — `packages/cli/src/client.ts` calls `ReportSchema.safeParse` and throws a
  `CliError` when it fails, and `packages/web/src/live/client.ts` calls a bare `ReportSchema.parse`.
  So a *required* new field would make an updated CLI or browser refuse to read an older daemon
  outright. Every block added to the report since ADR 131 carries the same mitigation, and this one
  must too.

## Decision

Add one field and one block to the report projection, derive both in the insight engine, and render
them on the two surfaces where the question is actually asked.

### The shape

`FlowMetricsSchema` gains an optional queue gauge:

```ts
/** Lanes in `open` — the backlog queue. Optional for back-compat with pre-295 daemons; the
 *  server always sets it. */
backlog: z.number().int().optional(),
```

and the report gains a per-goal block that reuses that same type whole:

```ts
export const GoalFlowSchema = z.object({
  /** The Goal these lanes name; `null` is the goal-less pool. */
  goal_id: z.string().nullable(),
  flow: FlowMetricsSchema,
});

// on ReportSchema:
/** Per-goal flow (ADR 295) — the same FlowMetrics, grouped by `lanes.goal_id`. Optional for
 *  back-compat with pre-295 daemons; the server always sets it. */
goal_flow: z.array(GoalFlowSchema).optional(),
```

Reusing `FlowMetrics` rather than defining a narrower per-goal type is deliberate: one type means one
derivation, one renderer, and no possibility of the two blocks disagreeing about what "cycle time"
means.

### The derivation

`goalFlowMetrics(db, teamId, now)` mirrors `flowMetrics` — the same three aggregate reads, each with
`GROUP BY goal_id` instead of a single row. `lanes.goal_id` and its index
`idx_lanes_goal(team_id, goal_id)` already exist from ADR 084's v12 migration, so no schema change is
needed and the grouping is indexed.

**One entry per distinct `goal_id` present on the team's lanes, plus a `null` entry when goal-less
lanes exist.** A declared Goal that has no lanes gets no entry — it has no flow to report, and its
status is already `planned` in `report.goals`. This is what keeps the block from becoming a second
goal list: it enumerates *lane groupings*, and the goal roster stays where it was. Entries are sorted
oldest-WIP first, so the first row is the one worth reading.

### The renders

- **The goal cards** (`/board`, the ADR 256 grid): each card gains a flow line under its runway
  carrying **time and the queue only** — oldest age, cycle time, queued count. This is the payoff;
  it puts the numbers on the object they describe, where a human is already asking how the goal is
  going. What it deliberately omits is lane *composition*: the card's foot already says how many
  lanes, how many shipped, how many in review, how many stuck, and a `wip` count beside it read as
  a second slightly-different count of the same lanes rather than as new information. The line's
  job is the axis the card had no way to show — how long.
- **The insight rail**: a per-goal list behind the existing "more" disclosure, beside the MAST
  detectors. The rail stays calm by default; the breakdown is for the reader who wants to compare
  goals in one column rather than scanning cards.
- **CLI and MCP** (`musterd report`, the report tool): the backlog gauge joins the team flow line at
  every altitude, and the per-goal breakdown renders at the `team` and `exec` altitudes — the two
  that already ask about movement rather than about the board.

### The Goodhart position, stated rather than assumed

Per-goal `throughput_7d` invites a reading ADR 050 was built to prevent: *goal X ships more than goal
Y*. We include it anyway, for one reason and with one mitigation.

The reason: ADR 050's guard is **outcomes and queues, never message volume**. `throughput_7d` is an
outcome count that already exists team-wide and already passes that guard; dimensioning an existing
metric by an existing key does not create a new class of measurement, it slices one. Excluding it
would cost a second, narrower type and would leave the per-goal and team-wide blocks structurally
different for a reason no reader could see.

The mitigation is in the rendering, which is where the invitation to misread actually lives, and it
is graded by surface. **The goal cards omit `throughput_7d` entirely.** A grid of cards is the one
rendering that lines goals up side by side at a glance, which is exactly the layout that turns
"which goal is stuck" into "which goal wins" — so the card carries durations and the queue, and no
ship count. The rail and the CLI keep it, because neither lays the goals out for visual comparison,
and both sort **by oldest-WIP, never by throughput**.

Goals are not comparable units: they differ in size, in scope, and in how many lanes a piece of work
is cut into, so a ranking by ship count is a misreading of the number rather than a use of it. That
sentence belongs in this ADR precisely because the number is now easy to rank on — and the card's
omission is what keeps the easiest surface to misread from offering it.

## Alternatives rejected

- **A `flow` field on each `Goal` in `report.goals`.** The natural join, and rejected because
  `GoalSchema` is shared with `GET /teams/:slug/goals` and the `team_goals` MCP tool. Flow numbers
  there would make every goal read heavier for callers that never asked for them, and would have to
  be optional in that schema anyway — so the field would be present-sometimes on a type used in
  three places, which is worse than a block that is either there or not.
- **A new `GET /teams/:slug/goal-flow` endpoint.** Rejected on ADR 050's "one projection" principle:
  a second endpoint is a second thing that can be stale relative to the first, and the report already
  costs one round trip.
- **A narrower queues-only per-goal type (no `throughput_7d`).** The hardest Goodhart guard
  available, and rejected for the reasons in the section above — it buys a guard the rendering
  already provides, at the cost of two types where one does.
- **Deriving the per-goal numbers client-side from `/lanes`.** The board already fetches lanes, so
  this is tempting and cheap. Rejected because ADR 104 froze the opposite rule: if the board wants
  data the engine does not derive, that is an insight-engine change authored server-side and
  consumed here, *never computed on the client*. Client-side derivation is how the CLI and MCP
  surfaces silently lose a metric the web has.

## Consequences

- The board's front door and its analytics finally agree about their unit. A goal card can be read
  end to end — what it promises (ADR 256's story), how it is moving (this ADR), and what it
  delivered (ADR 258's outcome) — without a terminal.
- The CLI and MCP report gain the backlog gauge they never had, because they have no second fetch to
  get it from. `musterd report` stops being blind to the queue.
- Additive and reversible: one optional field, one optional block, one new engine function, and four
  renderers. No migration, no wire-version bump, no server route. An older daemon simply omits both
  and every surface renders as it does today.
- The per-goal block is bounded by the number of distinct `goal_id` values on a team's lanes, which
  is the goal count — small, and the same order as `report.goals`, which the report already carries.
- A goal-less lane is now visible as a group rather than only as an absence. The `null` pool has its
  own flow numbers, which makes "work nobody attached to a goal" a thing you can watch grow — the
  same signal ADR 256's `no_goal` warning raises per-lane, aggregated.

## Observability & Evaluation

- **Traces:** the report read is one span already; tag it with `goal_flow.groups` (the number of
  entries derived, including the null pool) and `flow.backlog` so the projection's new width is
  visible per read without logging the goal ids themselves. No new span — this rides the existing
  `GET /report` handler, and a second span for a sub-derivation of one query set would measure the
  tracing, not the feature.
- **Eval:** the signal is *can a human name the dragging goal from one surface*. Dataset = this
  project's own lane state, which carries five in-flight goals and a goal-less pool. Baseline =
  today: the rail reports a team-wide oldest-WIP of N days and the reader must open `/lanes`, scan
  cards, and attribute that age to a goal by hand. Score: from `/board` alone, can a reader name (a)
  which goal owns the oldest live lane, (b) which goal has the deepest backlog, and (c) whether the
  goal-less pool is growing? Baseline answers none of the three without a second surface; this
  increment answers all three from the card.
- **Experiment:** per-goal numbers on the card versus the rail-only breakdown, over dogfood sessions
  — does putting the numbers *on the object* change time-to-answer for "which goal is dragging"
  relative to a sorted list in a separate column? Both renders ship here, so the comparison is a
  render toggle rather than a rebuild, and the result decides whether the rail breakdown earns its
  place or is redundant with the cards.
- **The counter-signal to watch:** if any surface, message, or standup starts ranking goals by
  `throughput_7d`, this ADR's Goodhart position has failed in practice and the metric should be
  narrowed to the queues-only shape rejected above. That is the falsifier, and it is observable in
  the act log.
