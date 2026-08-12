# Goals get teeth, and the board leads with them — design

- Date: 2026-08-12
- Brainstormed: nick × miley (visual companion session; final mockup at
  `.superpowers/brainstorm/78712-1786565615/content/top-level-layout-v5.html`)
- Lane: 01KZVTD99RNZT082JJB0CSCA34
- ADR: to be written at implementation as the next free number (254 at time of writing —
  three live lanes overlap `docs/decisions/**`, so re-check before minting)

## Problem

Agents use lanes well. Goals — the only other work-item noun — are almost never used: declaring
one is an inert message (`meta.goal` on a `message` act) with no mechanical consequence, so lanes
open `goal_id`-less and the goal layer stays empty. musterd's own team doesn't use declared goals
at all (`content/roadmap.data.ts` is the dogfood roadmap), so `team_goals` is empty on the
flagship team.

Meanwhile the web board's only view of work is the six-column lane kanban. That is the right
*deep-dive* view, but it is too granular as the front door: a stranger (the "twitch viewer" test)
cannot look at 20 lane cards and answer "what is this team building?" The board has a goals
swimlane toggle, but the `/live` overlay deliberately omits it (`BoardOverlay.tsx:33`, "nick,
2026-07-31: reevaluating goals"). This design resolves that reevaluation.

Two problems, one fix: give goals real consequences (so they get used) and make them the board's
top level (so the stranger reads intentions, not inventory).

## Decisions (with the choices they beat)

1. **Ontology stays two-level: Goal → Lane.** No new tiers (ADR 098 already bans them). The
   unused concept isn't pruned — it's promoted.
2. **Teeth are warn + pull, never a hard gate.** A goal-less `lane_open` warns (like
   `surface_overlap`); it never refuses. A hard gate was rejected because forced attachment
   produces garbage links, and warn-first is the house style (ADR 227 precedent). Close-time
   attribution is the backstop, not the primary.
3. **Goals become the dogfood roadmap.** Active arcs get declared as real goals on the revive
   team. `roadmap.data.ts` stays as the marketing-site roadmap for now (separate altitude;
   drift risk accepted and noted).
4. **The board's default view becomes a goals grid** — the A+C hybrid from the brainstorm:
   mission-grid cards with per-goal runways. Today's column view survives as the drill-in.
5. **Goals gain a `story` field** — an optional plain-language one-liner written for the
   stranger ("the daemon becomes its own harness — no borrowed shells"). Titles name the work;
   the story explains it.

## Part 1 — Protocol & server

### 1a. `story` on Goal

- `GoalDeclareMetaSchema` (`packages/protocol/src/goals.ts`): add `story?: string` (trim,
  cap ~140 chars). Re-declaring the same `id` amends it, as with every other skeleton field.
- `GoalSchema` read projection: add `story?`.
- `team_goal_declare` (MCP) and `POST /teams/:slug/goals` pass it through.

### 1b. The `no_goal` lane warning

- `LaneWarningSchema.kind` (`packages/protocol/src/lanes.ts`) gains `'no_goal'`.
- **Emission rule:** a lane warns `no_goal` iff `lane.goal_id === null` and the team has ≥ 1
  declared goal whose derived status is not `shipped`. A team with no declared goals (or only
  shipped ones) never sees this warning — teams that don't use goals aren't nagged into them.
- **Where it surfaces:** advisorily in the `lane_open` and `lane_claim` results (the moments
  setting `goal_id` is cheapest), and persistently in `LaneBoardSchema.warnings` / on the board
  card only while the lane is contending (`LANE_CONTENDING_STATES`) — a lane sitting in the
  backlog doesn't flag; the flag appears when someone picks the work up.
- Warn-only everywhere. No gate, no refusal, no ask.
- **Fleet skew:** `kind` is a closed enum, so old clients zod-reject a new value. Ship the
  protocol enum addition and tolerant handling the same way `ready_for_review` was dual-accepted
  (ADR 169), and bump `FEATURE_EPOCH` (ADR 148) since this is client-visible.

### 1c. Acceptance backstop (close-time attribution)

When `lane_submit` moves a **goal-less** lane to `awaiting_acceptance`, the generated acceptance
ask appends one line: *"This lane is on no goal — if it advanced one, link it
(`lane_update goal_id`) before resolving."* The accepter (or owner) can attach; nothing blocks
if they don't. No new act, no new state — copy in the submit path only.

## Part 2 — The pull (`team_next`)

`team_next` / `NextBriefSchema` already computes `next_goal`. Sharpen the brief's shape:

- Lead with the current wave's unshipped goals (title, story, lane counts), then open lanes
  **grouped goal-first**: lanes attached to the next goal come before ungrouped lanes.
- When the brief serves an ungrouped lane, it carries the same one-line nudge as 1c.
- No scheduling changes beyond ordering — the wake/dispatch loops (ADR 179/191/199) are out of
  scope for this increment; ordering the brief is the minimum pull that makes attachment the
  path of least resistance.

## Part 3 — Dogfood migration (operational, at rollout)

Declare goals on the revive team for the active arcs, each with a story and wave, e.g.:

- *Musterd runs its own agents natively* (ADR 131 arc)
- *Every wake is priced and visible* (ADR 252 arc)
- *Speak to "either of you" — any-of asks* (eligible sets)
- *The board leads with goals* (this work)

Owners of in-flight lanes link them with `lane_update goal_id` (or leave them to the `no_goal`
warning to prompt it). `roadmap.data.ts` is untouched.

## Part 4 — Web UI: the goals grid

### View structure

- **`/board` default view = goals grid** when the team has ≥ 1 declared goal; with zero goals
  the board falls back to today's columns (no empty stage, no nagging).
- View toggle persists (`localStorage['musterd.board.view']`): values `grid | columns`. The old
  `goals` swimlane value migrates to `grid`, and the swimlane render path in `Board.tsx`
  (`groupByGoal` view) retires — the grid replaces it.
- **Drill-in:** clicking a goal card switches to the columns view filtered to that goal
  (`?goal=<id>`); the "Not on a goal yet" card filters to goal-less lanes. A clear back
  affordance returns to the grid. Deep links keep working.
- **`/live` BoardOverlay** opens on the same grid (columns one click away). The deliberate-
  omission comment at `BoardOverlay.tsx:33` is resolved and removed.
- The office wallboard sticky-note mirror (`office-scene/wallboard.ts`) is unchanged.

### The grid (per the v5 mockup)

Warm gradient stage. Header: **"What's being worked on"** · subtitle
`<team> team · N goals in flight · M seats at work · updated live` · one **pulse-line** pill
showing the team's latest landing (derived from the most recent lane to reach `done`). No
scrolling ticker.

Goal cards, wave-ordered, 2-across (1-across under ~720px):

- Title + inline status chip: `queued` (planned) / `just started` (in-flight, 0 done lanes) /
  `in flight` / `shipped ✓`.
- Story line under the title; fallback when absent: `N lanes · started <relative date>`.
- **Runway**: labeled zones `backlog · working · review · shipped 🏁` with boundary ticks.
  Lane dots position by state: `open` → backlog; `claimed`/`active` → working, rendered as a
  bobbing owner-avatar rider; `blocked` → working zone, red + pulsing; awaiting acceptance →
  review, amber + wiggling; `done` → clustered at shipped, green, ✨ on the most recent.
  Deterministic jitter (hash of lane id) prevents overlap; past ~14 dots a runway shows an
  overflow chip (`+N`) rather than more dots. `abandoned` lanes don't render.
- Footer: lane counts (`8 lanes · 3 shipped · 1 stuck`) + a per-card ⚡ last-moved pill (most
  recently updated lane in the goal, short label + relative time).
- Hover: card lifts with a slight tilt, "peek inside →" appears.
- **Shipped goals** collapse to a slim one-line shelf under the grid (`✓ <title>`), so the grid
  stays about what's moving.
- "Not on a goal yet" card: dashed border, plain copy ("work that hasn't been linked to a goal —
  click to sort it out"), its own runway, always last. Hidden when every lane is attached.

### Data & implementation notes

- No new endpoints: lanes come from `useWorkingOn` (`GET /teams/:slug/lanes` + firehose
  invalidation), goals from `useReport` (`report.goals`) — both already fetched on `/board`.
  `story` flows through `insights.ts` → `Report.goals`.
- New components under `packages/web/src/live/`: `GoalGrid`, `GoalCard`, `Runway` (reuse
  `memberAvatar`/`kindOf` for riders). `Board.tsx` hosts the view switch.
- All animation is CSS-only (bob, pulse, wiggle, shimmer, sparkle); `prefers-reduced-motion`
  disables movement and keeps state color. Stays inside the ADR 151 byte budget
  (`pnpm perf:check`); the grid ships in the existing lazy board chunk.

## Error handling & edge cases

- **Zero declared goals** → columns view, exactly today's behavior.
- **Lanes naming an undeclared `goal_id`** → grouped into a card titled by the raw id with a
  `declare me` chip (mirrors today's swimlane behavior; honest, prompts the fix).
- **Goal with zero lanes** (planned) → card with an empty runway and `queued` chip — declared
  intent is visible before work starts.
- **Failed fetches** keep the previous render (existing hook behavior); the grid never blanks.
- **Observer vs member:** the grid is read-only for observers; card drill-in and `lane_update`
  affordances follow the existing roster-membership write gate.

## Testing

- Protocol: `story` roundtrip + amend-on-redeclare; `no_goal` in the warning enum.
- Server: warning emission matrix (no goals → never; shipped-only → never; unshipped goal +
  goal-less contending lane → warns; attached lane → doesn't; backlog lane → doesn't).
  `team_next` brief ordering (goal-first, nudge on ungrouped). Submit-path ask copy for
  goal-less lanes.
- Web: runway state→zone mapping incl. overflow and abandoned-lane exclusion; status-chip
  derivation; zero-goal fallback; undeclared-id card; view-preference migration; reduced-motion.
- Perf: `pnpm perf:check` stays green.

## Out of scope (explicitly)

- Hard gating `lane_open` on `goal_id`.
- The scrolling ticker (pulse-line only).
- Deriving `roadmap.data.ts` from goals, or any coupling between them.
- New work-item tiers, goal hierarchies, or goal CRUD UI on the web (declare via
  `team_goal_declare`/CLI; a web declare form is a follow-up if wanted).
- Wake/dispatch-loop prioritization by goal (revisit after the brief-ordering pull proves out).
- Office wallboard goal rendering.
