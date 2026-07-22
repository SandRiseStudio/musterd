# Human work identity — the writable board (item 5)

**Date:** 2026-07-22
**Author:** stanley (design); **implementation owner: miley** (all `packages/web`)
**Refs:** ADR 104 (work-items board & insight layer), ADR 145 (human role refounded), ADR 149
(AsksStrip write precedent), ADR 098 (Goal→Lane vocabulary), ADR 151 (web perf gate)
**Roadmap items:** `human-work-identity` (item 5) + `insight-dashboard` (ADR 104 incs 2–3)

## Problem

The record: nick created 5 lanes and owns **0 of ~84 ownerships**; the one work item only he can do —
publish the packages to npm — has sat parked and invisible for weeks. musterd literally cannot say
"the team is blocked on nick's lane." Nothing in the schema stops human-owned work (`owner_seat: nick`
is already legal; lanes already have a backlog state) — the only human claim surface is the CLI he
never opens.

And "the board" itself is one-third built. It is a distinct roadmap item, `insight-dashboard` (ADR
104), scoped as **three increments**, of which only increment 1 shipped:

- ✅ **Inc 1** (PR #151) — read-only `/board` kanban over `GET /lanes` (columns by lane state; cards
  carry owner, Goal, branch, age, advisory warning). Auto-provisions the hidden observer seat.
- ⬜ **Inc 2** — the insight rail (throughput, cycle time, WIP, waiting-on, MAST exceptions) + Goal
  swimlanes, over the already-shipped `GET /report`.
- ⬜ **Inc 3** — live-tail: the board moves cards on ADR 102 lane events instead of on manual refresh.

So rather than bolt a narrow write affordance onto a read-only stub, this design treats **the board as
one coherent surface** — write + insight rail + live-tail — designed together and shipped in reviewed
increments, write first (which ships the nick dogfood early).

## Non-goals

- **No new work-item nouns.** ADR 098 holds (Goal → Lane). The board renders what the daemon derives;
  it is never a second store.
- **No board CRUD backend work.** The backend is already complete: `POST /teams/:slug/lanes`
  (http.ts:2044) and `PATCH /teams/:slug/lanes/:id` (http.ts:2057) are member-authed via `authTouch`;
  `openLane` stamps `owner_seat = creator` when `claim:true` (store/lanes.ts); `GET /report`
  (http.ts:1999) is member-authed. This item is **web write + web render only**.
- **No smoother human sign-in _in this pass_.** See "Deferred / follow-up threads" — nick explicitly
  wants the `mscr_`-paste sign-in improved later, tracked as its own thread, not the headline.
- **No interactive Slack buttons, no multi-human admin** — out of scope, tracked elsewhere.

## The identity model (foundation, Inc A)

The board recognizes two grades of connection, reused verbatim from `/live`:

- **Observer** (default, auto-provisioned via `acquireObserver`, hidden from the roster) → **read-only**.
  This is today's `/board` behavior, preserved. "Enter a team and watch."
- **Real member** (signed in as a specific seat with an `mscr_` credential) → **write controls appear**,
  gated on `roster.some(m => m.name === cfg.as)` — the exact AsksStrip precedent (ADR 149). This is how
  **nick signs in as himself** and creates work as `owner_seat: nick`.

**Sign-in mechanism.** Reuse `/live`'s existing "Advanced — connect as a specific seat" flow (paste
`as` + `mscr_` token). Extract it from `live.tsx` into a shared `<MemberSignIn>` component consumed by
**both** `/live` and `/board` — one sign-in, two consumers, no duplication. The board needs the roster
(`fetchRoster`) to evaluate the membership gate, which it does not fetch today.

## Write: lane operations from the board (Inc A — the dogfood)

Two new client functions in `packages/web/src/live/client.ts`, mirroring `sendAct`:

- `createLane(cfg, input: OpenLane): Promise<Lane>` → `POST /teams/:slug/lanes`
- `updateLane(cfg, id, input: UpdateLane): Promise<Lane>` → `PATCH /teams/:slug/lanes/:id`

Both member-authed with the signed-in seat's `mscr_` (`authorization: Bearer`, `x-musterd-surface:
web`), both returning the daemon's echo so the board can fold the change in **optimistically** (the
firehose deliberately skips the sender, so the echo is the only copy this client sees — same reason
AsksStrip keeps `localAnswers`). Optimistic apply now, reconcile on the next live-tail event / refresh.

All write controls render **only** when signed in as a real member (observer sees the board unchanged).

| Control | Where | Call |
|---|---|---|
| **New lane** | header button → compact form: title (required); optional Goal, project, surface globs, branch; a **"claim it" toggle, default on** | `POST /lanes` — `claim:true` → `owner_seat = me`, state `claimed`; off → unowned `open` (backlog) |
| **Claim** | on any unowned card | `PATCH {owner_seat: me}` |
| **Advance** | on my owned card (`claimed → active → blocked ⇄ active → done`) | `PATCH {state}` |
| **Hand off** | on my owned card → pick a roster seat | `PATCH {owner_seat: other}` (daemon delivers the handoff w/ branch) |
| **Resolve** | on my owned card | `PATCH {state: 'done' \| 'abandoned'}` |

Lane states (from `LaneStateSchema`): `open` (backlog) / `claimed` / `active` (in-progress) /
`blocked` / `done` / `abandoned`.

**The nick dogfood is the create path alone:** New lane → title "publish packages to npm", claim-it
on → a real `owner_seat: nick` lane in `claimed`, which ages and is nudgeable, so the insight rail's
waiting-on can finally read "the team is blocked on nick's lane." The rest of the lifecycle rounds the
board out so it is not create-only; every operation is a thin `PATCH` the backend already handles.

## Insight rail + Goal swimlanes (Inc B)

**Insight rail** — a collapsible right-hand rail on `/board`, one `GET /report` fetch (member-authed,
so it works for observers *and* members). It renders the projection the engine already computes
(`Report` schema: `flow`, `waiting_on`, `goals`, `blocked`, `coordination`, `mast`, `steering`,
`wake`, `tool_calls`). Calm by default:

- **Flow** — throughput (7d), cycle time, WIP, oldest-WIP age (`report.flow`).
- **Waiting on** — the bottleneck line, e.g. "waiting on nick — 8 threads, oldest 2d"
  (`report.waiting_on`). The thematic payoff of the human-work-identity arc: the board naming a human
  as the blocker.
- **Blocked** — the live exception list (`report.blocked`).
- **Coordination** — the journal-vs-exchange flag, shown only when it trips (`report.coordination`).
- **"More" disclosure** — the denser detectors (MAST exceptions, steering latency, wake) stay behind a
  secondary disclosure so the rail is not a wall of metrics.

**Goal swimlanes** — a **view toggle** on the board: *columns* (by lane state, today's view) ⇄
*swimlanes* (one row per Goal from `report.goals` with its derived status, containing that Goal's
lanes; a "no goal" row at the bottom). Pure reorganization of lanes already fetched + the `goals`
array — no extra fetch.

Both the rail and swimlanes render only what `/report` derives — nothing new stored or computed
client-side.

## Live-tail (Inc C)

The board today is refresh-based. `/live` already has the machinery (`LiveClient`: WS `claim` →
subscribe `team-all` → stream; `useLiveStream`). Inc C reuses it on `/board`:

- Subscribe to the firehose; on **lane envelopes** (the ADR 102 `lane_open` / `lane_claim` /
  `lane_state` / `lane_handoff` / `lane_resolve` meta the daemon already emits), patch the affected
  card in place — move it between columns/swimlanes, no full refetch.
- This **reconciles the optimistic writes** from Inc A: the local echo settles when the authoritative
  lane event arrives (the AsksStrip `localAnswers` converge-on-truth pattern).
- Refresh stays as the fallback when the socket is down.

## Testing

- Client fns (`createLane`/`updateLane`) unit-tested against a temp daemon (the established web-client
  test pattern).
- Write-gating tested observer-vs-member: an observer sees no write controls and the daemon rejects
  its sends; a rostered member sees them and succeeds.
- **Acceptance = the dogfood, end-to-end:** nick, signed in on the web as himself, creates the
  publish-to-npm lane; it appears owned by `nick`; it ages; the insight rail's waiting-on / blocked
  names him.

## Perf (packages/web/AGENTS.md, ADR 151)

Every increment passes `pnpm perf:check`. Budget notes:

- Shared `<MemberSignIn>` extraction is net-neutral (moves existing code).
- The rail is one fetch + light DOM (numbers + short lists, no unbounded rows → no windowing needed).
- Live-tail reuses the existing `LiveClient` (one WS, existing 15s heartbeat) — **no new rAF/interval
  loops**; the board DOM is bounded by lane count, not an unbounded stream.
- Any budget raise is a deliberate same-PR act logged in `docs/perf/web-live-baseline.md`.

## Increments (ship order)

- **Inc A** — shared `<MemberSignIn>` + `/board` roster fetch + `createLane`/`updateLane` + write
  controls (full lifecycle) + optimistic apply. **Ships the nick npm-publish dogfood.**
- **Inc B** — insight rail (`GET /report`) + Goal swimlane view toggle.
- **Inc C** — live-tail on lane events; reconciles optimistic writes.

Each increment is its own PR, perf-checked, owned by **miley**.

## Deferred / follow-up threads (explicitly not this pass)

- **Smoother human sign-in.** nick approved the `mscr_`-paste sign-in "for now" but wants it improved
  later. Candidate directions: a human-credential path into `binding.json` (the folder-live-vs-admin
  friction datum, 2026-07-17), or a friendlier web sign-in than pasting a raw credential. Its own
  increment/follow-up, not the headline.
- **Interactive Slack ask buttons** (needs public ingress; loopback-bind today).
- **insight-dashboard** dependency note: item 5's write only needed inc 1; incs 2–3 are folded in here
  by choice (design the board fully), not by dependency.
