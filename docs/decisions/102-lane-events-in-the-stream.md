# 102 — Lane events in the stream: distinct rendering of noteless transitions

- Status: proposed
- Date: 2026-07-06
- Builds on: ADR 083 (lane events ride `act: 'message'` + `meta.lane_*`, no new act token), ADR 098
  (canonical work-item vocabulary — Lane is the entity), the orientation spine (Goal/Lane), and the
  `/live` office/stream surface (ADRs 096/097)

> **Amendment (2026-07-06, same day, pre-implementation).** The first cut of this ADR proposed
> broadcasting the `lane_update` free-text note as a stream event ("surface the note"). That conflated
> two distinct board affordances — a **transition** (assign / move column / done), which is structural
> and noteless, and a **comment**, which is a separate deliberate thing. On an agile board you don't
> type a note when you drag a card to Done; the activity feed writes it for you. This ADR is corrected
> to that model: **lane transitions are noteless, daemon-composed structural events**; `detail` stays
> the card _description_ (a board field, not broadcast); free text about a lane is the separate
> `message` act, never bolted onto a move. The title and Decision §2 below reflect the correction.

## Context

Lanes are the unit of owned work: a seat `lane_open`s, `lane_claim`s, `lane_update`s as it goes,
`lane_handoff`s to pass it, and `lane_resolve`s to close it. The `/live` stream is where a human (or a
teammate) watches the team's work move. So the lane lifecycle is arguably the highest-signal thing the
stream can carry — it is the story of the work itself, not chatter about it.

A dogfood observation kicked this off: lane acts "look like status updates" in the stream. Tracing the
code, the premise is half-right in a way that sharpens the fix.

**What actually happens today:**

- Lane ops are _not_ sent as the `status_update` act. ADR 083 deliberately minted no new act token:
  `lane_open` / `lane_resolve` / `lane_handoff` ride as **`act: 'message'`** with the real payload in
  `meta.lane_*`. The daemon composes the body string (`[lane] opened "…"`) in the HTTP transport
  (`deliverLaneTeamAct` / `deliverLaneAct`).
- The web layer already recovers this: `laneEvent(env)` in `packages/web/src/live/format.ts` reads the
  `meta` and returns a synthetic `lane_open|lane_resolve|lane_handoff` kind, and `Stream.tsx` keys the
  badge/glyph/tone on that recovered kind — so a resolve renders as "lane done", not as a raw message
  or a status update.

So they are already modeled and rendered as a separate thing. Two real gaps explain the perception,
and they are the actual problem worth fixing:

1. **Tone proximity.** `status_update` maps to the `status` tone and `lane_open` to `info` in
   `actTone` — two muted, low-alarm greys sitting side by side. A lifecycle event that starts/ends a
   unit of work reads with the same weight as "still poking at the CSS." The visual hierarchy does not
   reflect that a lane event is higher-signal.
2. **Half the lifecycle is invisible.** Only `lane_open`, `lane_resolve`, and (directed) `lane_handoff`
   emit a stream envelope. **`lane_claim` emits nothing** (the transport guards the handoff branch on
   `owner_seat !== self`, so a self-claim is silent), and a plain **state move** (`active`↔`blocked`)
   emits nothing. So the stream shows a lane blink into existence and later resolve, with no "who took
   it" and no "it's blocked" in between. The surviving events look like isolated blips precisely
   because the connective transitions are missing.

That second gap — and the "should agents have open text for lane acts?" question raised alongside it —
resolves cleanly under the **board model**. A lane is a card; its lifecycle ops are _transitions_
(assign / move column / done), which are **structural and noteless** — the board's activity feed
composes their line, you don't type one. `detail` is the card _description_ (a persistent board field),
not a per-move note. So the answer to "open text on lane acts" is **no**: transitions carry no free
text. If an agent has something to _say_ about a lane, that is the separate `message` act (a future
card-comment-style lane thread is possible, and out of scope here) — never bolted onto a move.

## Problem

Make the lane lifecycle legible in the stream without eroding the act discipline:

- **Keep the fixed act vocabulary.** The eight-act enum (ADR 083 / `packages/protocol/src/acts.ts`)
  stays closed; lane events keep riding `message` + `meta.lane_*`. We are not promoting `lane_*` to
  protocol acts, and we are not giving agents a general free-text act — that would undo the
  "use the acts, don't narrate" contract the whole model rests on.
- **Transitions are noteless, daemon-composed.** Like a board activity feed: the daemon writes
  "claimed X" / "moved X to blocked" from structured fields. No agent free text rides a transition;
  `detail` remains the card description, shown on `lane_board`, never broadcast.
- **No regression** for clients that do not recover `meta` (they still see a sane `message`).

## Decision

Two changes, one on each side of the seam. No protocol/schema change; the act enum is untouched.

### 1. Render lane events as a distinct, higher-weight class — not a quiet grey

Lane lifecycle events get their own visual tier in the stream, above generic `status_update`:

- Give the lane transitions a shared **lane accent** — a dedicated `--lc-lane` token in the
  `--lc-handoff` violet family (handoff is itself a lane transition) — so the eye groups them as "work
  moving" rather than reading each as an isolated status note. Assign the in-flight transitions
  (`lane_open` / `lane_claim` / `lane_state`) to it; `lane_resolve` keeps `success` (done is
  meaningfully green) and `lane_handoff` keeps its violet — the same family, so the cluster still
  reads as one. `status_update` keeps its muted `status` tone — the point is contrast.
- Keep the per-kind glyphs already in `ActIcon` (open / done / handoff) and add glyphs for the two
  newly-surfaced kinds (claim, state-move).

### 2. Surface the two silent transitions — noteless

Emit a team-stream envelope (same `message` + `meta.lane_*` pattern, same `deliverLaneTeamAct` helper)
for the two structural transitions that are currently silent. Both are **daemon-composed from
structured fields** — no agent free text:

- **`lane_claim`** → `meta.lane_claim: { lane, title }`, body `[lane] claimed "…"`. This is the "who
  took it" the stream is missing; it flips the lane from unowned to owned in the visible record.
- **`lane_state`** (a non-terminal state move, e.g. `active`↔`blocked`) → `meta.lane_state: { lane,
title, state }`, body `[lane] "…" → <state>`. Terminal moves (`done`/`abandoned`) already emit
  `lane_resolve`; opens and handoffs already emit. So this fills the one remaining gap — the "it's
  blocked / unblocked" transition — with no note attached.

Both render via the same `laneEvent()` recovery, so a non-recovering client still sees a coherent
`message`. The `detail` field is untouched: it stays the card description on the lane row, editable via
`lane_update`, shown on `lane_board`, and **never broadcast** — a description edit is not a transition.

### 3. What we are explicitly _not_ doing

- **Not** adding `lane_*` to the act enum (ADR 083 stands — the meta-on-`message` seam is the right one).
- **Not** attaching free text to any lane transition. A lane's free text is its `detail` (description,
  not broadcast); a _comment_ about a lane is the separate `message` act. A card-comment-style lane
  thread is a possible future affordance, deliberately out of scope.
- **Not** routing lane events through `status_update` (they never were) or letting them flip the roster
  `working` label — that derives from `status_update` server-side and stays a separate mechanism.

## Consequences

- The lane lifecycle becomes fully legible in `/live`: open → claim → (blocked/active) → handoff →
  resolve, each a noteless structural row visually distinct from status chatter. The "isolated blips"
  perception goes away because the connective transitions are present.
- The board model is honoured: transitions read like an activity feed, no free text bolted on. The
  "open text on lane acts" question is answered _no_ — a lane's description lives in `detail` (not
  broadcast), and a comment about a lane is a normal `message`.
- Modest, bounded stream volume: at most one extra row per claim and per non-terminal state flip — both
  rare relative to `status_update`. No per-progress-note firehose (there is no such note), so the
  deferred same-lane collapse is likely unnecessary; revisit only if dogfood disagrees.
- Small blast radius: the transport gains two `deliverLaneTeamAct` calls, `format.ts` gains two
  `laneEvent` kinds + labels/tones, `Stream.tsx`/`ActIcon` gain two glyphs and the lane accent. No
  protocol, DB, or MCP-tool-shape change. Reversible (ADR 010 spirit): drop the two emits and the tone
  and the baseline is unchanged.

## Observability & Evaluation

- **Traces:** the new emits reuse the lane act spans; add a `lane.event` attribute
  (`open|claim|state|handoff|resolve`) so stream composition and per-transition volume are queryable.
- **Eval:** the signal this serves is _stream legibility of the work lifecycle_. Cheap proxy in
  dogfood: after the change, can a human reading only the stream reconstruct who owns each open lane and
  whether it is blocked — without opening `lane_board`? Before, no (claim + state moves are absent);
  after, yes. Secondary: lane-transition volume per active lane, to confirm it stays well under
  `status_update` volume.
- **Experiment:** the reconstruct-from-stream check above run as a before/after on a captured dogfood
  session — dataset = one real multi-lane `/live` transcript (this session's run of PRs #137–#141),
  baseline = today's stream (opens/resolves only, no claims or state moves). Score: can a reader name
  the owner and blocked-state of each open lane from the stream alone. Baseline fails; the change
  should pass.
- **Live signal that motivated this:** a dogfood session (seat `miley`, 2026-07-06) reading its own
  `/live` stream during a multi-PR run — the lane opens/resolves were present but read as
  indistinguishable status blips, and the claims + state transitions that would have told the story
  were simply not there.
