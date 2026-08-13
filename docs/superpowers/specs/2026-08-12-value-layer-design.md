# The value layer — outcome notes, claim-time linking, visible review debt

- Date: 2026-08-12
- Author: stanley
- Status: draft, awaiting nick's review
- Arc goal: `value-layer`
- Lane: `01KZW10CV7XE855CEBE8THGZYR`
- Provenance: the "throughput trap" discussion (leaddev.com article + DORA 2025:
  AI adoption raises throughput while lowering delivery stability). Output, delivery,
  and value are three different measurements; musterd's board today measures the
  first two well and the third only as narrative.

## Problem

ADR 256 made goals the board's front door: the `no_goal` warning, `Goal.story`,
the goal-first brief, and the goals grid all shipped in #763. Three gaps remain,
and each maps to a throughput-trap mechanism:

1. **Linking has friction at the cheap moment.** A seat claiming an existing
   goal-less lane receives the `no_goal` warning in the claim result but cannot
   act on it in the same call — `lane_claim` takes `{id}` only. (The warning's
   prescribed repair, `lane_update {goal_id}`, was also broken at the MCP schema
   layer until wanderer's in-flight fix, lane `01KZW0M4BFGDEH7EMDGP8C7RJH`.
   Baseline adoption when ADR 256 landed: 14 of ~400 lanes carried a `goal_id`.)
2. **A shipped goal carries no evidence.** `status: shipped` is derived from its
   lanes (all terminal, ≥ 1 done) — that is delivery, not value. Nothing on the
   goal answers "what changed for a user, and where's the proof". The goals grid
   is a value narrative sitting beside a delivery metric with nothing joining them.
3. **Review debt is invisible.** `awaiting_acceptance` is our review queue, but
   nothing surfaces how long a lane has waited. The constraint the throughput
   trap describes — generation is cheap, review is the bottleneck — cannot be
   seen on this board.

## Decisions (with the choices they beat)

Everything below is **advisory and derived** — no hard gates, no stored goal
state, no daemon-initiated wakes. That is ADR 256's posture extended one notch,
and each rejected alternative is listed with the decision that beats it.

### 1. `lane_claim` accepts `goal_id`

- `ClaimLaneSchema` (protocol) and the MCP `lane_claim` tool gain optional
  `goal_id: string`. When present, the claim sets `lane.goal_id` atomically with
  the ownership transition — one call, no second round-trip.
- Emission of `no_goal` is unchanged; this only makes the warning actionable at
  the moment the claimer is already looking at the lane.
- **Coordination:** wanderer's lane fixes `lane_update`'s schema in the same
  file (`packages/mcp/src/tools/lanes.ts`). This increment rebases over that
  merge; it does not duplicate it.
- *Beats:* hard-gating claim on `goal_id` (rejected by ADR 256 — "garbage
  attachment"); leaving the two-call flow (measured friction at exactly the
  moment ADR 256 calls the cheapest).

### 2. Goal outcome — a replayed signal act, not a re-declaration

A goal's outcome note is a team-visible `message` act carrying
`meta.goal_outcome`:

```json
{ "goal_outcome": { "goal_id": "value-layer", "outcome": "…what changed for a user…" } }
```

- `GoalOutcomeSchema`: `goal_id` (string), `outcome` (trimmed, 1–280 chars).
  Longer than `story` (140) because an outcome names evidence, not a slogan.
- `listGoals` replays these signals exactly as it replays `defer`/`steer` today:
  latest signal per goal wins; signals arriving before their declaration queue in
  `pending` and replay in order. Derived `Goal.outcome` is
  `{ text, by, at } | undefined` — provenance comes free because the signal is an
  ordinary attributed message.
- Anyone can amend by sending a new signal; the message stream is the history,
  so a clobbered note is always recoverable and "amended by X" is derivable
  later if the grid ever wants it.
- Surface: a new MCP tool `team_goal_outcome {goal_id, outcome}` mirroring
  `team_goal_declare`, and CLI `musterd goal outcome <id> "<text>"`. One more
  tool is a real cost against the tool-surface headroom wanderer flagged on
  #762; paid deliberately, because the ship nudge must name an exact call and
  discoverability is the whole point.
- *Beats:* **outcome via re-declaration** (`team_goal_declare {outcome}`) —
  re-declaration replaces the goal skeleton wholesale, so every outcome writer
  would have to resend `story`/`wave`/`depends_on` or silently clear them
  (miley's footgun report, 2026-08-12); **a stored goals table with a
  `goal_shipped` event** — reverses ADR 084/256's derive-don't-store rule and
  adds daemon-initiated wakes, a new actor category with unpriced wake cost
  (ADR 252); **convention only** (outcome as a loose `status_update`) —
  unstructured, unfindable, and grid rendering would become the derived-content
  heuristic ADR 256 rejected.

### 3. The ship nudge — closer is prompted, nobody is woken

- The lane-close path already computes goal context for the acceptance nudge.
  It additionally derives the goal's status **before and after** the close; when
  the close flips a goal to `shipped`, the closer's own result gets an appended
  advisory line:

  > goal "…" just shipped — say what changed for a user:
  > `team_goal_outcome {goal_id: "…", outcome: "…"}`

- Appended, never blocking, never a wake — same contract as ADR 256's
  acceptance nudge. If the closing seat can't speak to user impact, its note can
  say so; anyone can amend.
- A goal that ships with no outcome stays visibly outcome-less. The grid may
  choose to render that absence (miley's call); the protocol does not nag twice.
- *Beats:* waking the goal's declarer (a paid wake to someone without the close
  context in hand); a blocking gate on close (a goal-less ship is information,
  not an error).

### 4. `stale_acceptance` — review debt becomes a board fact

- `LaneWarningSchema.kind` gains `'stale_acceptance'`. Emitted for a lane iff
  `state === 'awaiting_acceptance'` and time-in-state exceeds
  `ACCEPTANCE_STALE_MS` (exported constant, **12 h**). Advisory shape identical
  to `no_goal`: `owner: null`, never a directed wake, deduped per lane. Detail
  names the age and the repair; the repair's exact wording is pinned at
  implementation time to calls that verifiably exist (ryder's #759 lesson: the
  `no_goal` warning shipped prescribing a `lane_update` form the tool rejected).
- Time-in-state comes from the lane's recorded state-transition audit (the same
  source the grid's `lastMoved` reads); the exact accessor is an implementation
  detail of the store, not a new column.
- `team_next`: the brief's candidate-work section lists the **oldest-waiting**
  `awaiting_acceptance` lanes (cap 3, oldest first) ahead of unclaimed backlog —
  review debt becomes the default next unit of work when it exists, without
  anyone being summoned.
- *Beats:* directed nudges via eligible sets (builds daemon-initiated sends on a
  feature merged yesterday; revisit if advisory proves too quiet — pre-register
  the check: median `awaiting_acceptance` age after two weeks); escalation to a
  human ask (heaviest, nags nick, and ADR 217's wait verdict already owns the
  "when does waiting become a problem" question).

### 5. Epoch

`FEATURE_EPOCH` 10 → 11 (ADR 148): `team_goal_outcome`, the claim-time
`goal_id`, and the new warning kind are all client-visible capability.

## Explicit non-goals

- **Any per-seat throughput metric** (lanes closed, PRs, messages per seat).
  Named as an anti-goal: the moment it renders, someone optimizes it — that is
  the trap itself.
- **Web/grid rendering** of outcome, outcome-less shipped goals, or acceptance
  age — miley's surface, handed off with this spec.
- **LoC-delta / deletion observation** — dropped from this arc by nick
  (2026-08-12); revisit only if duplication shows up as a measured problem.
- **Hard gates** anywhere (settled by ADR 256).
- **Eligible-set or to-human escalation** for stale acceptance (see §4).
- **Backfill** of historical goal-less lanes — the grid only renders active
  lanes; history stays as it was.

## Components and data flow

| Unit | Change | Depends on |
|---|---|---|
| `packages/protocol` | `GoalOutcomeSchema`; `Goal.outcome?`; `ClaimLaneSchema.goal_id?`; `'stale_acceptance'` warning kind; `ACCEPTANCE_STALE_MS`; epoch 11 | — |
| `packages/server` store | outcome replay in `listGoals` (incl. pending queue); `stale_acceptance` in `laneWarnings`; claim-time `goal_id` in the claim transition | protocol |
| `packages/server` transport | before/after shipped derivation + ship nudge in the close handler | store |
| `packages/mcp` | `team_goal_outcome` tool; `lane_claim` gains `goal_id`; `team_next` brief lists oldest-waiting acceptances | server |
| `packages/cli` | `musterd goal outcome <id> "<text>"`; claim `--goal` | server |
| `packages/web` | out of scope (miley) | — |

Flow, end to end: a seat claims with `goal_id` (or links later via wanderer's
fixed `lane_update`) → works, submits, another seat accepts → the close flips
the goal's derived status to `shipped` → the closer's result carries the ship
nudge → the closer sends `team_goal_outcome` → `listGoals` replays it →
`team_goals`, the brief, and (later, miley) the grid show the outcome beside
`shipped`. Meanwhile any lane stuck in `awaiting_acceptance` past 12 h warns on
the board and floats to the top of `team_next`.

## Error handling

- `team_goal_outcome` for an unknown goal id: accepted and queued (`pending`
  replay), same as every other pre-declaration signal — ordering cannot drop it.
- Outcome over 280 chars / empty after trim: schema reject at the tool boundary.
- `lane_claim` with a `goal_id` when the claim itself fails: no partial write —
  the link rides the same transition or not at all.
- Clock skew / negative ages in `stale_acceptance`: clamp at 0, never emit.

## Testing

- **Store:** outcome replay matrix — latest-wins, pre-declaration queue, outcome
  survives re-declaration of the skeleton (the footgun test), provenance fields.
  `stale_acceptance` matrix — under/over threshold, non-contending states never
  warn, dedupe, clamp.
- **Close handler:** goal with two live lanes — closing one yields no nudge;
  closing the last yields exactly one; a close that un-ships nothing yields none.
- **What a person sees** (ryder's lesson from #759: every JSON assertion passed
  while the CLI silently dropped the act): assert the rendered claim result,
  `team_next` brief, and `team_goals` output carry the nudge, the age, and the
  outcome — not just the wire shape.
- **MCP/CLI:** schema acceptance for the new args; `goal outcome` round-trip.

## Rollout

1. Land increments in dependency order (protocol → server → mcp/cli), each its
   own lane linked to `value-layer`, rebased over wanderer's `lane_update` fix.
2. An ADR (next free number) records the decision set; this spec is its working
   draft.
3. Dogfood immediately: the several goals miley derived to `shipped` today are
   the first outcome-note candidates; write real notes, see if the grid line
   reads as value or as ceremony — that reading is the review gate for whether
   the mechanism earns its place.
4. Two weeks in, check the pre-registered stale-acceptance question (§4).
