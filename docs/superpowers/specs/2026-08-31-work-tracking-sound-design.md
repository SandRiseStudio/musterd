# Work-tracking sound — the room's audio stops lying about work

**Date:** 2026-08-31 · **Author:** miley, from a design conversation with nick
**Status:** spec for review (acceptor: wanderer, per lane 01M0TSX3SM745SP5VNTSYSRDJF)
**Lane:** Delight E2 — the ambient ladder's last rung · **Goal:** office-delight

## 1. The problem

The office has a two-part audio layer (`sound.ts` / `soundEngine.ts`, both opt-in and
lazy-loaded): a room-tone bed driven by a weighted "life roll", and per-act firehose
chimes. The bed is *statistical*: `keys` is 34% of every roll whether or not anyone is
working, panned to a random side. A room where every seat is offline still types to
itself, and a room in a full sprint sounds identical to a dead one.

This is the sonic twin of the problem presence-honesty (2026-08-19 spec) fixed for the
eyes: the surface asserted liveliness it could not evidence. E2 makes the audio track the
work that is actually happening — the same honesty rule, applied to the ears.

What "work-tracking" means here, agreed 2026-08-31 (nick):

1. **Honest causality** — typing sounds come only from desks of evidenced-`working`
   seats, panned to those desks; an idle room keeps only presence sounds; an empty room
   is near-silent.
2. **Thinking vs. typing texture** — a working desk alternates key bursts with quiet
   pen-taps and chair-creaks, so it reads as a person, not a typing machine.
3. **Work-density bed** — the life-event tempo and work-sound weights scale with how
   much work is in flight.
4. **Day-cycle audio** — the bed follows the existing lighting envelope: birds and
   coffee in the morning, night-air after dark, so sound and window light always agree.

Explicitly **out of scope**, split off as named follow-ups during the same conversation:
*milestone punctuation* (acceptance fanfare, merge ding, ask-resolution cadence,
arrival/departure, incident tone) and *interaction sounds* (nameplate expand, directed-act
whoosh). One lane cannot eat all twelve ideas well.

## 2. Data contract — widen `LifeContext`, keep it one-way

The scene→sound push stays exactly what it is: pushed from the office rAF loop
(`office-scene/index.ts`, the existing `roomTone.setOccupancy` site), never read back.
`LifeContext` grows four fields:

```ts
export interface LifeContext {
  pairs: ReadonlyArray<{ x: number }>;          // existing
  dog: { x: number; walking: boolean } | null;  // existing
  /** Desks of evidenced-`working` seats (screen x in [-1, 1]). Empty = nobody works. */
  working: ReadonlyArray<{ x: number; seed: number }>;
  /** Work intensity, 0..1 — working share of present seats, nudged by recent act rate. */
  density: number;
  /** From the lighting envelope — audio and window light can never disagree. */
  daylight: number;
  /** Office clock, 0..24 PST — same value the wall clock renders. `?light=HH` overrides audio too. */
  hours: number;
}
```

- `working` reuses the scene's per-seat `activity: 'working'` (presence-honesty's
  evidenced state) and each member's stable seed, so a desk keeps its own keyboard voice
  and its own think/type rhythm.
- `density` is computed scene-side: `working / present`, nudged upward by act arrivals the
  scene already observes for speech bubbles. Clamped 0..1. The exact nudge is an
  implementation constant; the contract is only "0 = nobody working, 1 = full sprint".
- `daylight` / `hours` come from the same `lighting.ts` envelope the daylight overlay and
  wall clock read.
- `EMPTY_LIFE` gains the new fields as zeros/empties: an empty office stays the silent
  baseline.

A freebie worth stating: when nobody is working the render loop parks and occupancy stops
updating — and that is *correct*, because the parked room is exactly the room that should
be quiet. No new timer or subscription is needed to make silence happen.

## 3. Honest causality — work sounds become gated and placed

The life roll's events split into two families:

- **Work family** — `keys`, `tap`, `softTap`, `creak`, `drawer`, `stapler`: available only
  when `working.length > 0`, and **panned to an actual working desk** (per-event random
  pick among `working`, via the existing `panFor` mechanism). `keys` uses the picked
  desk's `seed` for `keyboardFor`, so each desk sounds like itself across bursts.
- **Presence family** — `murmur`, `whisper`, `footsteps`, `sip`, `blow`, `water`,
  `eating`, `chime`, dog events: gated as today (pairs / dog / nothing). These are what an
  idle-but-occupied room keeps.

The existing renormalisation already handles the gating: when the work family is
unavailable its weight redistributes over what remains, same as chatter today.

**Thinking vs. typing.** Each working desk alternates phases, driven by a pure function of
its seed and the clock — `deskPhase(seed, nowMs): 'typing' | 'thinking'` — with
jittered-per-desk phase lengths on the order of tens of seconds, deterministic in
`(seed, now)` so tests can hold it still. During `typing` the desk is eligible for `keys`;
during `thinking` it is eligible only for `tap`/`softTap`/`creak` (panned to the same
desk). A desk mid-thought that gets picked for `keys` defers to another typing desk, or
converts to the thinking texture if none exists. No new timers: the roll cadence is
unchanged, only eligibility and placement move.

## 4. Continuous state — density bed + day-cycle

**Density.** Two pure functions, both in `sound.ts`:

- `lifeGapFor(density): [min, max]` — scales the engine's `LIFE_GAP` so a full sprint
  schedules life events roughly **2×** as often as a quiet-but-occupied room, monotone in
  `density`, never below a floor that keeps a busy minute from becoming a slot machine
  (the same principle as the broadcast chime throttle). The engine's `armLife()` calls it
  instead of reading the constant.
- Work-family weights scale up modestly with density (a multiplier folded into the
  availability/weight computation); presence-family weights do not. A busy room is busier,
  not louder — per-event gains are untouched.

**Day-cycle.** Two new synthesized events, weight-modulated by the envelope:

- `birds` — soft chirps, available only during the dawn ramp and morning daylight
  (`hours`/`daylight` window), fading out by midday.
- `nightair` — very sparse cricket-adjacent texture, available only after dark **and**
  only when someone is in the room: the late-shift feel, not a nature documentary over an
  empty office.
- Morning additionally up-weights `sip` (the coffee hour).

Both are oscillator/noise synths like every other voice — **no audio assets**;
`packages/web/public/office/` stays empty and the byte budgets are untouched by content.

## 5. Guardrails (all pre-existing, none weakened)

- **Opt-in stays.** Sound defaults OFF, starts only from a user gesture; nothing here
  auto-plays. The two existing toggles remain the mute affordance; no new toggles.
- **Broadcast unchanged.** `enableForBroadcast()` (ADR 228) flows through untouched.
  WebAudio renders independently of the 25fps capture draw cap, so every sound here
  survives capture by construction; the 700ms chime throttle is a firehose concern and
  is not affected.
- **Hidden-tab gate** already lives in the engine (`isHidden()` guards `life()`); new
  events inherit it.
- **Reduced-motion:** audio is not motion; no coupling is added. The quiet room comes
  from honesty, not from a motion preference.
- **Perf:** no new timers, no new eager bytes (all changes ride the existing lazy
  `soundEngine` chunk), no render-loop work beyond assembling four fields at the
  existing push site.

## 6. Files and testing

| File | Change |
| --- | --- |
| `packages/web/src/live/sound.ts` | Widen `LifeContext` + `EMPTY_LIFE`; work/presence family split in availability; density-scaled weights; `deskPhase`, `lifeGapFor`; pan-to-working-desk in `panFor`. All pure. |
| `packages/web/src/live/soundEngine.ts` | `birds` + `nightair` voices; `armLife()` reads `lifeGapFor`; `keys` takes the picked desk's keyboard seed. |
| `packages/web/src/live/office-scene/index.ts` | Assemble the four new fields at the existing `setOccupancy` site (~15 lines). |
| `packages/web/src/live/sound.test.ts` | New cases below. |

`render.ts` is untouched — the known surface overlap with nick's clock-companion lane
(01KZ4MRK20) does not materialise.

Unit tests (all against the pure half, no AudioContext):

- No work-family event is pickable when `working` is empty; presence family unaffected.
- `panFor('keys', ctx)` lands on a working desk's x.
- `deskPhase` is deterministic in `(seed, now)` and both phases occur over a window.
- `lifeGapFor` is monotone, bounded, and `lifeGapFor(0)` equals today's gap.
- `birds` unavailable after dark; `nightair` unavailable in daylight and in an empty room.
- `EMPTY_LIFE` picks nothing from the work family and neither day event.

## 7. Rollout

One implementation lane (this one, 01M0TSX3SM), one PR. Spec is accepted by wanderer
before implementation begins (spec-before-code is the lane's own rule). Verification
beyond unit tests: a listen on `/live` with sound on across a working/idle/empty seeded
team, and a `?light=` sweep for the day-cycle events.
