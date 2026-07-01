# 079 — Live isometric office (replaces the constellation on `/live`)

- Status: accepted — 2026-07-01 (M1 landed: office scene + presence/act wiring + panel modes)
- Date: 2026-07-01

## Context

The live dashboard (ADR 061) renders the team firehose as a split canvas: a decorative three.js
**constellation** (members = glowing ring nodes, messages = arcs; `aria-hidden`) on the left, the roster rail
(ADR 073), and the legible stream console on the right. The constellation reads as _ambient motion_ but it
doesn't convey **what a team is doing** — who's heads-down, who's idle, who's away, or the _shape_ of an act
(a request for help vs a handoff vs a broadcast). Over a long design pass we produced a full Figma vision
(file `b6zXGHxG9CnCa8tFgpQWx2`) for a warmer, more legible metaphor: a **2D isometric co-work office** where
every teammate sits at a desk, presence decides who's in the room, and coordination acts play as
choreography — with **travel-intensity == notification tier** (ambient stays at the desk; needs-attention
walks over; urgent runs).

The whole visualization is a swappable rendering layer: `ConstellationGL` (React wrapper) mounts a scene
behind a `ConstellationHandle { update; emit; dispose }` interface, fed by `useLiveStream` (roster +
firehose). Nothing in the data path needs to change.

## Problem

Replace the constellation with the live office **without** touching the firehose/roster/presence plumbing,
keep the calm-at-rest / energetic-in-motion feel, and ship incrementally. Two constraints shaped the
approach: the web app is entirely three.js today (no Rive/Pixi), while the Figma character spec assumes
**Rive** state-machine avatars; and the character `.riv` asset must be authored in the Rive editor (a manual
design step) — engineering can't be blocked on it.

## Decision

### Renderer — Rive characters over a code-drawn floor, two stacked layers

The office is composited from two pixel-aligned layers inside the same panel (mirroring the existing
`.lc-gl-canvas` + `.lc-gl-labels` pair):

1. **Floor layer — one code-drawn 2D `<canvas>`.** The isometric floor, desks, break nook, entrance, and
   furniture are drawn in code from the Figma projection `S(lx,ly) = [OX+(lx−ly)·0.7071, OY+(lx+ly)·0.35355]`,
   painter-ordered back-to-front by `(lx+ly)`. Code-drawn (not a baked PNG) so seat anchors are exact and
   desks appear/empty as the roster changes — the anchor map is the single source of truth shared by
   drawing, seating, and depth-sort.
2. **Character layer — Rive (M2) / code-drawn placeholder (M1).** One avatar per member, driven by the
   parametric rig (`isHuman`, `accentColor`, `skinTone`, `accessory`, `hair`, `direction S·E·N·W`, `state
idle·working·walking·thinking·away·help`). The M1 placeholder is a code-drawn iso figure behind the same
   `Actor` seam, so M2 swaps placeholder→Rive without touching the data wiring.

New module `packages/web/src/live/office-scene/` implements `mountOffice(host, labelHost, reduced)` returning
the **same** `ConstellationHandle` shape — a drop-in. Pure, unit-tested sub-modules: `iso` (projection),
`layout` (desk slots / nook / entrance), `seating` (assignment), `mapping` (act→event). `format.memberColor`
is reused verbatim as the signature `accentColor`.

### Data → scene mapping

- **Presence decides placement, activity decides state.** `offline` → exited (empty desk); `online` +
  `working` → seated, screen-glow; `online` idle → seated idle; `away` (or `availability` away/dnd) → break
  nook. Overflow past the 12 desks queues on an entrance strip.
- **Seat assignment is deterministic and order-independent** (`hash(name)` → linear probe), so avatars don't
  teleport between reloads/presence pings.
- **Act → choreography** carries an intensity tier: `status_update` = screen pulse (ambient); `message`
  direct = note / to-team = megaphone; `request_help` = walk-over (`meta.urgent` → run + red `!`); `handoff` =
  carry labeled box; `accept`/`decline`/`wait`/`resolve` = sender-anchored cues. In M1 every event renders as
  a lightweight cue (tinted ring + glyph, coloured by `format.actTone`); M2 plays the real motion.

### Panel modes

The office keeps its split-panel slot but gains a **collapse/expand** toggle and a **companion** toggle (the
office fills the browser window — roster/stream tuck away — _not_ OS fullscreen), persisted in `localStorage`.

### Milestones

- **M1 (this ADR)** — code-drawn office from live data + lightweight act cues + panel modes + placeholder
  avatars. No Rive dependency; genuinely shippable. Unit tests for `seating` + `mapping`.
- **M2** — add `@rive-app/canvas` + the authored `public/office/character.riv`; per-member Rive instances;
  walking choreography (walk-over, carry-box, megaphone, resolve, enter/exit).
- **M3** — overflow polish, `away`/nook refinement, urgent run, reduced-motion parity, perf.

## Consequences

- The visualization changes; the firehose/roster/presence contract does not. `constellation-scene.ts` is left
  in-tree (dead) until the office ships, then removed.
- M2 introduces the first Rive dependency and a manually-authored `.riv` asset (design task, tracked
  separately). M1 does not depend on it.
- Out of scope / noted: the web **observer** connection now fails against a v0.3 P3.2 daemon with "send a
  claim frame first" — the claim-handshake (ADR 077/078) the observer client hasn't adopted. Pre-existing in
  `client.ts`/`provisionObserver`; unrelated to this visualization, but it gates seeing live data end-to-end.

## Alternatives considered

- **Three.js orthographic** (reuse the existing stack) — rejected: heavier setup than 2D canvas for a flat
  2.5D scene, and avatars still need baking; Rive is the locked character decision.
- **Baked floor PNG + anchor map** — rejected: can't add/remove desks as the roster changes; the code-drawn
  floor keeps anchors authoritative.
- **Rive for the whole scene** — rejected: authoring a full floor + N walking characters in the Rive editor
  is a bottleneck; Rive for characters + code floor keeps engineering unblocked.

## Observability & Evaluation

n/a — a human-facing visualization of the existing firehose/roster/presence data (a `/live` dashboard
re-skin), not an agent-facing coordination surface. It emits no new coordination acts, joins no team, and
adds no spans to the team-task timeline — it only _renders_ signals other ADRs already emit. There is no
agent behavior to eval or experiment on here; the underlying data's own observability lives with the
firehose/presence ADRs it consumes.
