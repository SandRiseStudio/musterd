# 107 — Steering acts in the office & stream: rendering steer / challenge / defer

- Status: proposed
- Date: 2026-07-07
- Builds on: ADR 103 (the `steer` / `challenge` / `defer` acts on the interrupt line), ADR 102 (lane
  events in the stream — the precedent this applies to a second act family), ADR 105 (clobber-guard
  honours reclaim grace — the `reclaimable` field surfaced here), and the `/live` office/stream surface
  (ADRs 079 / 086 / 096 / 097)

## Context

ADR 103 appended three acts to the protocol vocabulary — `steer` (a directive that supersedes prior
direction), `challenge` (an epistemic "justify this or reconsider"), and `defer` (a plan mutation on a
Goal). The protocol, delivery, SPEC, and architecture docs were all synced for those acts. **The web
surface was not.** `/live` — the browser console a human (or a teammate) watches the team through —
dropped all three:

- **The office dropped them entirely.** `office-scene/mapping.ts` `actToEvent` had `default: return
null` for any unlisted act, so `steer` — the _flagship_ interrupt-class act, the one thing the office
  most wants to make loud — produced **no choreography at all**. It was invisible in the marquee view.
- **The stream rendered them degraded.** `Stream.tsx` fell back to the `message` glyph, `format.ts`
  `actTone` returned `neutral`, and `actLabel` printed the raw token. A `steer` read as quietly as a
  stray note.

This is the same shape of gap ADR 102 fixed for lane events: a new act family that the protocol models
but the `/live` render seam (`format.ts` / `mapping.ts` / `Stream.tsx` / the office `emit`) does not yet
key on distinctly. This ADR applies that established pattern to the steering trio.

Two adjacent observations rode in with the work:

1. **A latent `toneColor` gap.** The office palette (`office-scene/render.ts` `toneColor`) had no
   `lane` case, so lane-tinted cues fell through to the peach `default` — mismatching the indigo
   `--lc-lane` badge the stream already used. Lane events (ADR 102) had been rendering the wrong colour
   in the office since they shipped.
2. **`reclaimable` was invisible on the roster.** ADR 105 added `MemberSummary.reclaimable` (a seat
   held within its reclaim grace reads `offline` but may be reconnecting). The roster drew it as a cold
   offline seat, indistinguishable from a genuinely-gone one.

## Problem

Make the steering acts legible in `/live` without eroding the act discipline or the office's
"travel-intensity == notification tier" grammar:

- **`steer` must read as interrupt-class** — as salient as an urgent `request_help`, because it always
  interrupts and the newest steer supersedes prior direction (ADR 103 / ADR 017). An invisible steer is
  the worst failure: the office exists to make exactly this reachable.
- **`challenge` is epistemic, not urgent** — a "justify?" that interrupts only when flagged. It should
  read as a question, distinct from a directive.
- **`defer` is a plan mutation**, not a seat-local event — its target is a Goal (`meta.goal_id`), so it
  belongs to the lane / work-moving family, not to per-seat chatter.
- **No protocol, schema, or MCP-tool-shape change.** This is a pure render-seam change, web-only.

## Decision

Four changes, all on the web side of the seam. The act enum, delivery, and daemon are untouched.

### 1. Tones — steer and challenge get their own weight; defer joins the lane family

In `format.ts` `actTone` / `ActTone`:

- **`steer` → a new `steer` tone** (`--lc-steer`, magenta-rose): the loudest steering colour, so an
  interrupt-class directive reads above status chatter and above an ordinary help.
- **`challenge` → a new `challenge` tone** (`--lc-challenge`, cyan): a distinct questioning colour,
  calmer than steer.
- **`defer` → the existing `lane` tone**: a plan mutation is work moving on the board, the same family
  as the lane transitions (ADR 102).

The steering acts are already clean single words, so `actLabel` renders them verbatim through its
default (unlike the underscored `lane_*` sub-types, which needed relabelling).

### 2. Office choreography — the act → motion projection

In `office-scene/mapping.ts` `actToEvent` and the scene's `emit` (new `OfficeEvent` kinds `steer` /
`challenge` / `defer`):

- **`steer` is interrupt-class:** a room-wide sweep every present member feels, plus — when the steer
  names a member — an **urgent redirect run** over to them (reusing the urgent help-walk travel, so no
  new walk kind in `actors.ts`). A team-wide steer, or one whose target has left, carries on the sweep
  plus a bold urgent marker at the sender.
- **`challenge`** raises a question-mark cue over the challenger's head, mirrored over the challenged
  party when directed; urgent only when flagged.
- **`defer`** pulses out across the room in the lane colour (a board-wide "the plan shifted" cue) rather
  than sitting as a single-seat marker.

### 3. Glyphs, colours, and sound

- **`Stream.tsx` `ActIcon`** gains a glyph per act: a redirecting arrow (`steer`), a raised pennant
  (`challenge`), a skip-forward chevron (`defer`).
- **`Live.css`** gains the `--lc-steer` / `--lc-challenge` tokens and badge variants; `defer` reuses
  `--lc-badge--lane`.
- **`office-scene/render.ts` `toneColor`** gains the office colours for `steer` / `challenge` **and the
  missing `lane` case** — fixing the pre-existing lane-cue-is-peach bug in the same pass.
- **`sound.ts`** gains a cue per act: `steer` an assertive rising triad (loudest), `challenge` a
  questioning lift, `defer` a gentle downward settle.

### 4. The reclaimable "reconnecting" hint (ADR 105)

In `RosterPanel.tsx` / `Live.css`: a seat that reads `offline` but is `reclaimable` (held within its
reclaim grace) now shows a **"reconnecting"** hint — a slow-breathing amber dot plus a tag — instead of
a cold offline row. It is distinct from both online and gone, honest about a seat that is coming back.

### 5. What we are explicitly _not_ doing

- **Not** adding a new walk kind to `actors.ts` — the urgent steer run reuses the existing help-walk
  travel; the steering distinction is carried by tone, glyph, sweep, and speech, not by a new gait.
- **Not** touching the protocol, DB, or MCP tool shape. The steering acts are already first-class in the
  vocabulary (ADR 103); this only teaches the render seam to key on them.
- **Not** rendering a `reclaimable` seat as _present_ — it still reads offline (grace is hidden from
  display, ADR 010); the hint is a reconnecting annotation, not a presence change.

## Consequences

- `/live` becomes fully legible for steering: a `steer` is now the most salient thing on screen (as it
  should be — it always interrupts), a `challenge` reads as a question, and a `defer` reads as the plan
  moving. The "steer is invisible in the office" failure is closed.
- The office act-vocabulary reference (`docs/architecture/08-web.md` §"Act rendering vocabulary") now
  covers the full act set; lane events (ADR 102) and steering acts (this ADR) are documented as the two
  families layered on the base acts.
- A latent bug is fixed as a side effect: lane cues render their intended indigo in the office, matching
  the stream badge.
- Small, reversible blast radius: `format.ts` (+2 tones), `mapping.ts` (+3 cases), the office
  `types.ts`/`emit` (+3 `OfficeEvent` kinds), `Stream.tsx` (+3 glyphs), `Live.css` (+2 tokens/badges +
  the reconnecting styles), `render.ts` `toneColor` (+3 cases), `sound.ts` (+3 cues), `RosterPanel.tsx`
  (the hint), and `office-preview` controls. No non-web file changes. Reverting restores the prior
  (degraded) render with no other effect.

## Observability & Evaluation

- **Traces:** this is a pure client render change — it emits no new server spans, and it must not. The
  acts it renders are the ADR 103 acts, already instrumented server-side (`musterd.model`/act spans, the
  interrupt-check counter naming the raise class `steer` vs `urgent`). The web observer is a read-only
  firehose consumer; the only client-side signal is the existing `useLiveStream` chime/dedup path, which
  keys on envelope id. Nothing to add here — the observability lives at the act's source (ADR 103).
- **Eval:** the signal is _stream/office legibility of a change of direction_. Dataset: a captured
  `/live` transcript carrying at least one `steer`, `challenge`, and `defer` (this ADR's live
  verification run below is one). Baseline: the pre-#158 render (steer invisible in the office, neutral
  in the stream). Score: watching only `/live`, can a reader tell a `steer` from a status update at a
  glance, and is it as loud as an urgent help? Baseline fails on all three acts; the change passes.
- **Experiment:** run that before/after on the captured transcript — the same envelopes replayed against
  the pre-#158 and post-#158 builds — and confirm each steering act renders with a distinct tone class,
  glyph, and (for `steer`) interrupt-class choreography in the post build and does not in the baseline.
- **Verified live against the daemon (2026-07-07, seat `miley`, PR #158).** With a browser subscribed to
  the team-all firehose on the running daemon (:4849), real `steer` / `challenge` / `defer` envelopes
  were sent and observed to render end-to-end: each appeared in the stream with the correct tone class
  (`lc-badge--steer` / `lc-badge--challenge` / `lc-badge--lane`), the correct glyph path, and the
  verbatim label (confirmed by DOM inspection, not pixels alone), and `defer` animated a live speech
  bubble in the office. The daemon was confirmed to persist all three (`musterd.db`).
- **Incidental finding (unrelated, filed for follow-up):** the `/live` HTTP backfill is capped at 200
  messages and returns the oldest of an over-cap history, so on a busy team the newest acts appear only
  via the live socket, not the backfill. Out of scope here; a paging fix for deep-history scroll.
