# 086 — Ambient office life: a two-tier render architecture for a live-at-rest office

- Status: proposed — 2026-07-02
- Date: 2026-07-02

## Context

The live isometric office (ADR 079) plays each musterd act as choreography — walks, carries, a megaphone
sweep, and (ADR 079 follow-up) ephemeral speech bubbles. It reads well **in motion**. At rest it does not.

Two things put it there, and the second is self-inflicted:

1. **All life lived on one path.** Everything animated through the same expensive step: a full
   depth-sorted canvas redraw (`renderScene`) plus a Rive `advance()` per member, in `index.ts`'s `tick()`
   RAF loop. There was never a cheap way to be "a little alive."
2. **The idle-park perf fix (ADR 079 M3) then froze it.** `tick()` now parks the RAF loop the moment no
   walk or cue is in flight, holding the last Rive frame. Correct for CPU — an unattended office used to
   redraw at 60fps forever — but it turned *calm at rest* into *dead at rest*. Between acts (which, on a
   small team, is most of the time) nothing moves at all.

The office should feel **inhabited and calm** between acts — plants swaying, monitors breathing, someone
drifting to the coffee nook — without reintroducing the always-on 60fps redraw the idle-park fix removed.

## Problem

Make the office continuously alive at rest **without** regressing the idle-park perf win, without adding
latency to real-act choreography or the speech bubbles, and while degrading gracefully on weak hardware and
under `prefers-reduced-motion`. The naive fix (un-park the loop) is exactly the regression we must avoid.

## Decision

### The core move: split "life" from "the canvas" into two rendering tiers

The dead-at-rest problem is an architecture problem: perceived life and the expensive canvas redraw were the
same thing. Separate them.

- **Tier A — cheap, always-on, GPU-composited.** A sibling DOM/CSS overlay layer (`.lc-gl-ambient`, a peer
  of the existing `.lc-gl-labels`), holding positioned sprites that animate purely via CSS
  `transform`/`opacity`/`filter`. The compositor thread runs these; **no per-frame JS, no canvas touch, no
  Rive advance.** This carries the *feeling* of continuous life at ~zero main-thread cost.
- **Tier B — expensive, on-demand.** The existing canvas path (`renderScene` + Rive advance in `tick()`).
  It exists to do **occlusion** — a body walking behind/in front of desks — and nothing else needs that. It
  stays parked (idle-park fix intact) and only wakes for actual walking: a real act, or an ambient
  micro-choreography beat. Rare, brief, preemptable.

The key realization: **most ambient life needs no occlusion**, so it belongs in Tier A and is nearly free.
Tier B only wakes for genuine movement, which is inherently sparse.

### The five behaviours, mapped to the cheapest tier

| # | Behaviour | Tier | Implementation |
| - | --------- | ---- | -------------- |
| 3 | **Environmental drift** — plant sway, coffee-machine steam, a slow day-cycle light | **A** | CSS-animated overlay sprites positioned at projected floor coords (rebuilt on `bake`/resize, like labels). Plants sway via `transform: rotate`; steam is a CSS particle loop; the day-cycle is one full-panel gradient overlay lerped every ~30s (not per frame). |
| 2 | **Working-desk pulse** — a monitor glow that breathes | **A** | A soft radial-glow element over each `working` member's monitor, CSS `opacity`/`filter` breathe. Added/removed at `bake` time on activity change. (A "typing" burst is an optional Tier-B accent, not required.) |
| 5 | **Afterglow** | **B (extended)** | After a real act, delay the park by a few seconds so the member settles rather than hard-cutting to a freeze. Reuses the existing loop; near-free. |
| 1 | **Ambient micro-choreography** — coffee runs, stretches, glances, plant-watering, desk-to-desk drift | **B (rare bursts)** | An idle *scheduler* (timer-based, not RAF) injects a gentle beat every ~15–25s when the room is quiet, via the existing `actors.walk()` / cue system. 60fps only *while* the beat plays, then re-park. |
| 4 | **Audio bed** — low room tone + occasional distant keys | — | Event-driven via the existing `sound.ts`; negligible cost, gated by the existing sound toggle. |

On a quiet room this means: Tier A gives swaying plants, breathing monitor glows, drifting light, and the
odd puff of steam **continuously, for free**, while Tier B sleeps and wakes only ~2–4×/min for a slow
coffee-walk.

### Cross-cutting performance mechanisms (the real wins)

1. **Idle FPS cap.** When Tier B wakes for an *ambient* beat it runs at ~20fps (accumulate `dt`, redraw on
   an interval), not 60. A coffee stroll is visually identical at 20fps and ~3× cheaper. Real-act
   choreography keeps 60fps — smoothness reads there. The walk carries an `ambient` flag that selects the
   cap.
2. **Rive idle sprite-cache.** A seated idle character does not need `advance()` every frame. Render it once
   to a cached bitmap and blit that; re-advance only occasionally, or when it starts moving. Advance *live*
   only the 0–1 characters actually walking. This is the single largest Rive cost saver. (Phase 3.)
3. **Real acts always preempt.** A pending or in-flight ambient beat is cancelled the instant a real act
   arrives. Ambient never delays real choreography or a speech bubble. The real feed is priority; ambient is
   filler that yields.
4. **Visibility + intersection gating.** Already pause on a hidden tab; add: pause/throttle when the office
   panel is `collapsed`, `companion`-hidden, or scrolled out of view (`IntersectionObserver`).
5. **Adaptive frame budget.** Sample frame time; if it exceeds budget, shed ambient density and drop idle
   FPS automatically. Self-tuning for weak hardware. (Phase 3.)
6. **`prefers-reduced-motion`** stays fully honoured: ambient off, a single static frame — the existing
   reduced-motion model, unchanged.

### Graphics-quality touches (that also help perf)

- The floor/furniture stay **baked once** to the offscreen buffer (already the case) — never in the animated
  path.
- **Integer-align** canvas blits to avoid subpixel blur; drop the Rive offscreen supersample from 2× to 1×
  for idle blits (keep 2× only for active characters).
- `will-change: transform` / `contain: paint` on the Tier-A layers so each gets its own compositor layer.
- DPR stays capped at 2 (`DPR_CAP`).

### Milestones

- **Phase 1 — Tier A + afterglow (this ADR's core).** The `.lc-gl-ambient` CSS overlay: environment (#3) +
  monitor glow (#2) + afterglow (#5). Biggest life-per-CPU, zero canvas-path risk. This is the phase that
  makes the room feel alive.
- **Phase 2 — Ambient micro-choreography (#1)** with the idle-FPS cap and real-act preemption. Introduces
  a coffee-walk beat (reuses walks) and an idle scheduler; in-place "gesture" poses (stretch/glance) need a
  small Rive state and can follow.
- **Phase 3 — Deep render optimisation.** Rive idle sprite-cache, adaptive frame budget, supersample tiering,
  plus the audio bed (#4).

## Performance budget & verification

Targets (desktop baseline; the office panel is one pane of `/live`):

- **At rest (Tier A only):** **0 office-canvas rAF/sec** (the idle-park invariant holds); only the compositor
  is active. No measurable sustained main-thread work from the office.
- **An ambient beat:** a single Tier-B wake, **≤ ~4s**, at **≤ 20fps**, then re-park. At most one beat at a
  time.
- **A real act:** full 60fps choreography, **unchanged** by ambient — an ambient beat in flight yields
  immediately.
- **Reduced-motion / hidden tab / collapsed panel:** no ambient work at all.

Verification (reuses the ADR 079 M3 harness): headless Chrome with `requestAnimationFrame` instrumented to
count office-canvas frames per second (proved the idle-park fix; re-used here to prove Tier A adds **zero**
canvas rAF at rest and ambient beats are bounded), Chrome performance traces for main-thread vs compositor
split, and screenshots for the visual states. A frame-budget assertion in the harness guards against
regressions.

## Consequences

- The office gains a second render layer. `mountOffice` now owns three DOM layers (canvas, labels, ambient)
  plus the offscreen buffer; `dispose` must tear down the ambient layer and cancel the idle scheduler's
  timers (same discipline as the speech bubbles).
- **The idle-park invariant is preserved and now load-bearing** — Tier A exists precisely so we never have to
  break it. Any future "make it move" request routes to Tier A first, the canvas path second.
- Ambient beats are *self-generated* motion. They are visual-only: they emit **no** musterd acts, touch no
  roster/firehose data, and must never be mistaken for real activity (they animate the body, never a speech
  bubble or an act cue). The presence/act data path is untouched — same drop-in `ConstellationHandle`.
- Environmental sprites (plants, glow, steam) become DOM/CSS instead of (or layered over) their baked-canvas
  forms; the baked floor stays authoritative for occlusion and seat anchors.
- Extends the "Live isometric office (Rive)" roadmap item (ADR 079); ships behind the same `/live` office
  panel, no new surface.

## Alternatives considered

- **Just un-park the RAF loop at rest.** The regression this ADR exists to avoid — back to 60fps-forever for
  ambient breathing that the compositor can do for free.
- **Run everything on the canvas but at a low idle FPS.** Cheaper than 60fps, but still burns the main
  thread continuously and still redraws the whole depth-sorted scene for a swaying plant. Tier A moves that
  work to the compositor entirely; the idle-FPS cap is reserved for the rare case where the canvas genuinely
  must run (an ambient walk needing occlusion).
- **Bake ambient into the Rive character (always-on breathing in the rig).** Forces a continuous Rive advance
  per member — the exact cost the sprite-cache and Tier A avoid. The rig's idle breath is kept for *active*
  frames; at rest we hold a frame and let Tier A carry the life.
- **A prerendered looping video/GIF ambient layer.** Cheap to play but static in content (can't reflect who's
  actually present/working), heavy to ship, and it fights the live data. Rejected — the office must stay a
  projection of the real roster.

## Observability & Evaluation

n/a — a human-facing visualisation of the existing firehose/roster/presence data (a `/live` office render
change), not an agent-facing coordination surface. It emits no coordination acts, joins no team, and adds no
spans to the team-task timeline; the ambient motion is self-generated visual filler, deliberately carrying no
act semantics. The client-side **render** performance this ADR is about is budgeted and verified under
"Performance budget & verification" above (headless rAF-count + frame-budget traces), which is the right
instrumentation for a rendering change — distinct from the coordination telemetry the obs-evals gate governs.
The underlying data's own observability lives with the firehose/presence ADRs it consumes (ADR 061/057).
