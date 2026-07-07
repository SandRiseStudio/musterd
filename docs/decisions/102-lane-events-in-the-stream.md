# 102 — Lane events in the stream: distinct rendering, and surfacing the note

- Status: proposed
- Date: 2026-07-06
- Builds on: ADR 083 (lane events ride `act: 'message'` + `meta.lane_*`, no new act token), ADR 098
  (canonical work-item vocabulary — Lane is the entity), the orientation spine (Goal/Lane), and the
  `/live` office/stream surface (ADRs 096/097)

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
   `owner_seat !== self`, so a self-claim is silent), and **`lane_update` emits nothing** — its
   free-text `detail`/note is written to the lane row and never reaches the stream. So the stream shows
   a lane blink into existence and later resolve, with no "who took it" and no progress in between. The
   surviving events look like isolated blips precisely because the connective tissue is missing.

That second gap is also the answer to the open question raised alongside this: _"should agents have
open text for lane acts?"_ They already do — `lane_update(detail)` is free text. It just never surfaces.

## Problem

Make the lane lifecycle legible in the stream without eroding the act discipline:

- **Keep the fixed act vocabulary.** The eight-act enum (ADR 083 / `packages/protocol/src/acts.ts`)
  stays closed; lane events keep riding `message` + `meta.lane_*`. We are not promoting `lane_*` to
  protocol acts, and we are not giving agents a general free-text act — that would undo the
  "use the acts, don't narrate" contract the whole model rests on.
- **Lane free text stays bounded to a lane.** The open-text channel agents want already exists as the
  `lane_update` note. Surfaced, it is legible _because_ it is anchored to a Lane entity with an owner
  and a lifecycle — structured enough to not become a narration firehose.
- **No regression** for clients that do not recover `meta` (they still see a sane `message`).

## Decision

Two changes, one on each side of the seam. No protocol/schema change; the act enum is untouched.

### 1. Render lane events as a distinct, higher-weight class — not a quiet grey

Lane lifecycle events get their own visual tier in the stream, above generic `status_update`:

- Give `lane_open` / `lane_claim` / `lane_update` / `lane_resolve` / `lane_handoff` a shared **lane
  accent** (keyed off the existing `--lc-handoff` violet family already used for `lane_handoff`, or a
  dedicated `--lc-lane` token) so the eye groups them as "work moving" rather than reading each as an
  isolated status note. `status_update` keeps its muted `status` tone — the point is contrast.
- Keep the per-kind glyphs already in `ActIcon` (open / done / handoff) and add glyphs for the two
  newly-surfaced kinds (claim, update).
- Optional, deferred: collapse a run of same-lane events under the lane title (a lane "thread") so a
  busy lane reads as one moving item instead of N rows. Called out as a follow-up, not built here, to
  keep this increment to tone + the two missing events.

### 2. Surface the two silent events — including the `lane_update` note

Emit a team-stream envelope (same `message` + `meta.lane_*` pattern, same `deliverLaneTeamAct` helper)
for the two ops that are currently silent:

- **`lane_claim`** → `meta.lane_claim: { lane, title }`, body `[lane] claimed "…"`. This is the "who
  took it" the stream is missing; it flips the lane from unowned to owned in the visible record.
- **`lane_update`** → `meta.lane_update: { lane, title, note }`, body `[lane] "…": <note>`, emitted
  **only when the update carries a human-facing note** (a bare state/dep/surface edit stays silent to
  avoid noise). This is the open-text channel, now visible, and scoped to its lane.

Both render via the same `laneEvent()` recovery, so a non-recovering client still sees a coherent
`message`. The daemon still composes the body; the agent's only free text is the `note` it already
passes — no new input surface, no new act.

### 3. What we are explicitly _not_ doing

- **Not** adding `lane_*` to the act enum (ADR 083 stands — the meta-on-`message` seam is the right one).
- **Not** giving lane acts a general free-text field beyond the existing `lane_update` note.
- **Not** routing lane events through `status_update` (they never were) or letting them flip the roster
  `working` label — that derives from `status_update` server-side and stays a separate mechanism.

## Consequences

- The lane lifecycle becomes fully legible in `/live`: open → claim → update(s) → handoff → resolve,
  each visually distinct from status chatter. The "isolated blips" perception goes away because the
  connective events are present.
- Agents get the open-text outlet they wanted (`lane_update` notes) _without_ a new act or a narration
  escape hatch — the free text is anchored to a Lane, which is what keeps it signal.
- More stream volume: a chatty lane now emits update rows it did not before. Mitigated by the
  note-only gate on `lane_update` and the deferred same-lane collapse; if volume is still high in
  dogfood, the collapse thread becomes the next increment.
- Small blast radius: the transport gains two `deliverLaneTeamAct` calls, `format.ts` gains two
  `laneEvent` kinds + labels/tones, `Stream.tsx`/`ActIcon` gain two glyphs and the lane accent. No
  protocol, DB, or MCP-tool-shape change. Reversible (ADR 010 spirit): drop the two emits and the tone
  and the baseline is unchanged.

## Observability & Evaluation

- **Traces:** the new emits reuse the lane act spans; add a `lane.event` attribute
  (`open|claim|update|handoff|resolve`) so stream composition and per-event volume are queryable, and
  the note-gated `lane_update` emit rate is visible (how often agents actually attach a note).
- **Eval:** the signal this serves is _stream legibility of the work lifecycle_. Cheap proxy in
  dogfood: after the change, can a human reading only the stream reconstruct who owns each open lane
  and its last progress note — without opening `lane_board`? Before, no (claim + notes are absent);
  after, yes. Secondary: lane-event volume per active lane, to tune the note gate / decide whether the
  same-lane collapse is needed.
- **Experiment:** the reconstruct-from-stream check above run as a before/after on a captured dogfood
  session — dataset = one real multi-lane `/live` transcript (this session's run of PRs #137–#140),
  baseline = today's stream (opens/resolves only, no claims or notes). Score: can a reader name the
  owner + last note of each open lane from the stream alone. Baseline fails; the change should pass.
  A second cut tunes the `lane_update` note gate on observed volume.
- **Live signal that motivated this:** a dogfood session (seat `miley`, 2026-07-06) reading its own
  `/live` stream during a multi-PR run — the lane opens/resolves were present but read as
  indistinguishable status blips, and the claims + progress notes that would have told the story were
  simply not there.
