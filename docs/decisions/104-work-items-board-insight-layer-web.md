# 104 — Work-items board + insight layer (web): a view over the act log, no second store

- Status: accepted — increment 1 (the `/board` work-items surface) shipped (#151)
- Date: 2026-07-07
- Builds on: ADR 050 (insight engine — derived projections, "queries not instrumentation"), ADR 083
  (lanes — the work-item primitive), ADR 084 (server-side placement + `deriveGoalStatus`), ADR 048
  (declared Goals — the one stored planning noun), ADR 061 (team firehose), ADR 102 (lane events on
  the stream — the transitions this board animates), ADR 063/077 (read-only observer seat + claim
  handshake — the web auth this reuses), and `docs/design/human-agent-dynamics.md` §4 (the philosophy:
  a board is a view over the act log, never a second store)

## Context

The roadmap item `insight-dashboard` — "Work items, board & insight layer (web)" — is the browser
surface the insight engine never got. The engine itself shipped: `deriveReport`
(`packages/server/src/store/insights.ts`) and `GET /teams/:slug/report` already derive the whole
projection (flow metrics, waiting-on, coordination density, the delivery ledger, MAST detectors), and
`GET /teams/:slug/lanes` returns the full lane board with live warnings. Three surfaces already consume
these — the `musterd report` CLI, the report MCP tool, and the CLI HTTP client. **The web tier has
none of it**: `packages/web/src/live/client.ts` has no fetch for `/lanes` or `/report`. So a human
watching `/live` sees the team _move_ (roster, stream, office) but has no board of the _work_ and no
analytics over it.

Two things make now the right time. First, `docs/design/human-agent-dynamics.md` §4 already settled the
shape: **a board is a view over the act log** — a lane's `state` _is_ its kanban column, `handoff` is a
reassign, a blocked lane is the blocked flag — and analytics are **queries, not a second instrumented
store**. Second, ADR 102 just made lane transitions first-class stream events (`lane_open` / `claim` /
`state` / `handoff` / `resolve`), which is exactly the event set a live board consumes to move cards
without a refresh. The substrate is complete; this ADR is the surface.

## Problem

Render the work board and its analytics in the web console under the invariants the philosophy doc set:

- **No second store.** The board renders what the daemon _derives_ — lane state, goal status, flow
  metrics. No board CRUD, no stored columns, no `progress` field invented on the client. A card moves
  because a lane's `state` changed server-side, never because the browser mutated a local model.
- **No new auth.** Both endpoints are member-authed (any seat on the team, not admin). The read-only
  observer seat (ADR 063/077) the web already provisions is sufficient — the board is one more
  read-only route, mirroring `audit.tsx`.
- **Goodhart + surveillance, already baked in.** The engine measures **outcomes and queues, never
  message volume** (flow metrics derive from lane timestamps, not chat count — insights.ts). The board
  must not reintroduce a vanity metric on the client. Derived _human_ metrics (waiting-on, load) follow
  the same need-to-know visibility the daemon projects; the board renders the projection, it does not
  compute a new one.

## Decision

Build the board + insight layer as a **read-only web surface over the two existing endpoints**, phased
so the smallest useful thing ships first. New route `/board`; new fetches `fetchLaneBoard` and
`fetchReport` on `client.ts`; render mirrors the `audit.tsx` read-only pattern (observer credential,
connect form or reused watch link, refresh). No protocol, server, or store change — the server already
returns everything.

### The column mapping — lane state _is_ the column

`LaneState` is `open | claimed | active | blocked | done | abandoned`. That enum is the board:

| Column          | Lane state(s) | Meaning                                          |
| --------------- | ------------- | ------------------------------------------------ |
| **Backlog**     | `open`        | declared, unowned — the one stored planning noun |
| **Claimed**     | `claimed`     | owned, not yet underway                          |
| **In progress** | `active`      | work underway                                    |
| **Blocked**     | `blocked`     | flagged stuck (rendered hot, not a dead column)  |
| **Done**        | `done`        | resolved                                         |
| _(collapsed)_   | `abandoned`   | shown muted under a "dropped" fold, not a column |

`claimed` and `active` stay separate columns to start; if dogfood shows `active` is rarely set
explicitly (a claim that goes straight to work), increment 1 may collapse them into one "In progress"
column with a treatment distinguishing assigned-vs-working — a rendering decision, not a data one.

### Increment 1 — the board (this ADR freezes it)

A read-only kanban at `/board`, columns as above, one card per lane. Data: **`GET /lanes` only** (the
full board with warnings; `report` is increment 2). Scope frozen:

- **Card** = lane `title`, owner avatar (reuse `memberColor`), a Goal chip (`goal_id`), a branch chip,
  age (from `claimed_at` / `updated_at`), and a warning marker when the lane carries a
  `LaneWarning` (unmet dependency / surface overlap — advisory, warn-never-block, rendered as a quiet
  flag not an error).
- **Columns** in state order, each with a count. Empty columns render as a calm placeholder, not
  hidden (the shape of the board is information).
- **Swimlanes by Goal are deferred to increment 2** — increment 1 is a flat board plus a Goal chip on
  each card, so the goal join (`?goal=` / `deriveGoalStatus`) lands with the analytics it belongs to.
- **Auth + fetch**: add `fetchLaneBoard(cfg)` to `client.ts` (`GET /teams/:slug/lanes`, observer
  credential, `x-musterd-surface: web`), reuse the `live.tsx` observer provisioning / watch-link.
- **Static-safe**: the route SSR-prerenders an empty connect state like `audit.tsx`; data loads
  client-side. No board state in the URL beyond the team.

### Increment 2 — the insight layer + Goal swimlanes

Add `fetchReport(cfg)` (`GET /report`) and render the derived analytics as a header rail + an
exceptions panel over the board:

- **Flow tiles**: throughput (7d), mean cycle time, WIP, oldest-WIP age — the `FlowMetrics` block,
  drawn as stat tiles (per the `dataviz` guidance, outcomes not volume).
- **Waiting-on** and the **MAST exceptions** (time-to-unblock, stalled threads, ignored help, circular
  handoffs) as a compact "needs attention" list — the coordination smells the engine already detects.
- **Goal swimlanes**: group the board rows by Goal with the derived `planned | in-flight | shipped`
  status, using the `goals` + `goal_id` join. An "unassigned" swimlane holds goal-less lanes.

### Increment 3 — live-tail (deferred, the ADR 102 payoff)

Subscribe the board to the firehose (ADR 061 `team-all`) and move cards on the lane events ADR 102 now
emits — `lane_claim` moves a card to Claimed, `lane_state`→Blocked flags it, `lane_resolve` slides it
to Done — so the board is live like `/live`, no refresh. This is why ADR 102 came first; it is called
out here but **not** built in increments 1–2 (which are fetch-and-refresh), to keep the first ship
small.

### What we are explicitly _not_ doing

- **No board CRUD.** No create-card, no drag-to-move, no stored columns. Moving a card is done through
  the lane verbs (`lane_claim` / `lane_update` / `lane_resolve`) in the agent's tool — the board is a
  window, not an editor. (A future "act from the board" affordance is a separate ADR.)
- **No new `progress` field.** The design doc floats `meta.progress` as a column signal; `LaneSchema`
  has none and this ADR invents none. State is categorical; a progress bar, if ever wanted, sources
  from the message log, not a new lane column — out of scope.
- **No second store, no new server endpoint.** If the board wants data the engine doesn't derive
  (per-goal cycle time, lane↔thread linkage), that is an _insight-engine_ change (ADR 050 lineage),
  authored server-side and consumed here — never computed on the client.

## Consequences

- The insight engine gets its browser surface: a human sees the work as a board and its health as
  derived analytics, not just the live stream. The `insight-dashboard` roadmap item moves from reserved
  toward shipped, one increment at a time.
- Small, additive blast radius for increment 1: one new route + two `client.ts` methods; zero server,
  protocol, or store change. Reversible — delete the route.
- The board inherits the engine's discipline for free: because it renders derived projections, it
  cannot drift from the daemon's truth, and it cannot smuggle in a message-volume metric — the
  numbers are the ones `report` already computes.
- The live-tail payoff (increment 3) is real but sequenced last, so the first ship is a plain
  fetch-and-refresh board — the cheapest thing that answers "where is the work."
- Gap noted, not closed: `report` surfaces `blocked` lanes and `goals` but not the `open` backlog
  column (that lives in `/lanes`), and flow metrics are team-wide, not per-goal. Increment 1 reads
  `/lanes` for the full board; per-goal analytics, if wanted, is a later insight-engine increment.

## Observability & Evaluation

- **Traces:** the board issues plain reads; tag the web fetches with `surface=web` (already sent) and a
  `board.fetch` span carrying `{lanes, columns_nonempty}` so board loads are attributable and the
  `/lanes` vs `/report` read split is visible per increment.
- **Eval:** the signal is _does the board let a human answer a work question the live stream can't_.
  Dataset = a captured multi-lane team state (this project's own lanes). Baseline = today (no board;
  the human runs `musterd report --altitude ic` in a terminal or scans `/live`). Score: from the
  `/board` route alone, can a human name (a) how many lanes are in flight, (b) which are blocked, and
  (c) who owns the oldest WIP — without a terminal? Baseline requires the CLI; increment 1 answers
  (a)/(b), increment 2 answers (c).
- **Experiment:** increment 1 vs increment 2 on the same team state — does adding the flow tiles +
  waiting-on change how fast a human spots the bottleneck (time-to-answer the "oldest WIP owner"
  question)? A/B the analytics rail on/off over dogfood sessions.
- **Live signal that motivated this:** this session shipped four lane-bearing PRs (#137, #139, #140,
  #142) and the only way to see that board of work was `lane_board` in a terminal — the web console,
  which the human was already watching, showed the stream but not the board.
