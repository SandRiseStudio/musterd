# Milestone punctuation — the room reacts to what just happened

**Date:** 2026-08-31 · **Author:** miley, from the E2 design conversation with nick
**Status:** spec for review (acceptor: wanderer, per lane 01M1CFK7NQX0JA7Q7076X092M9)
**Lane:** Delight E3 · **Goal:** office-delight · **Builds on:** E2 (90a8b331)

## 1. The problem

E2 made the ambient bed honest — the room sounds like the work that is happening. But the
room still says nothing at its *moments*: an acceptance throws confetti in silence, the
door "opens" (a visual pulse) without a sound, and an ask lands with no acoustic weight in
the room itself.

This is **not** the firehose act chimes again. The firehose layer already plays a per-act
cue (accept arpeggio, ask doorbell, …) on its own toggle — abstract, unplaced, a
notification voice. E3 is the *room's* reaction on the room-tone layer: placed in the
scene, panned to where the moment happens, part of the diegetic office. The two layers
remain independently toggleable; a viewer with both on hears a notification *and* the
room reacting, which is how a real office sounds when good news lands.

Scope, agreed with nick 2026-08-31 (three moments):

1. **Acceptance fanfare** — paired with the existing confetti burst, panned to the
   celebrant: a warm rising triad plus a soft paper-flutter.
2. **Door + steps** — the existing door pulse gets a click-and-sigh and a few placed
   footsteps from the door's side of the room, for arrivals and departures alike.
3. **Ask bell** — when an ask speaks in the room, one gentle held tone panned to the
   asked member's desk (directed asks) or soft-centre (team asks). Stateless.

**Declined for now**, recorded so the decision is visible:

- *Incident drone* — a standing tone in an ambient bed reads as an alarm; if ever, it
  needs its own design.
- *Ask-resolution figure* ("the room audibly relaxes") — pairing a resolution to its ask
  requires ask-state tracking (`asks.ts` territory) that this one-way, stateless sound
  path deliberately does not have. The answering act already lands as its own moment.

## 2. The plumbing — a placed one-shot, same one-way contract as E2

One new façade method, mirroring `setOccupancy`'s discipline (scene → sound, never read
back, callable before the engine exists):

```ts
// sound.ts (façade) → soundEngine.ts (engine)
type Moment = 'fanfare' | 'door' | 'askbell';
roomTone.moment(name: Moment, pan: number): void;
```

- Gated on the room-tone preference and the hidden-tab rule exactly like the bed
  (broadcast excepted, ADR 228) — the engine's existing gates, no new ones.
- A moment that arrives before the engine chunk lands is **dropped, never queued** — the
  same rule as the firehose cues, for the same reason (a queued burst lands as a chord).
- `pan` is the E2 screen convention: raw [-1, 1]; the engine applies the ×0.75 stereo
  squeeze, in the one place that already owns it.

Emit sites in `office-scene/index.ts`, all existing hooks — **with the emits split from
the visuals where the visuals are motion-gated**:

| Moment | Trigger | Pan |
| --- | --- | --- |
| `fanfare` | the directed-accept branch (`ev.of` live) — **emitted before the `reduced` gate**, so the confetti stays motion-gated but the sound plays | the celebrant's head position, converted to [-1, 1] |
| `door` | `takeDoorPulses() > 0` — **the pulse is read regardless of `reduced`**; only `pushDoorCue()`'s visual stays behind the motion gate | the entrance position, converted to [-1, 1] |
| `askbell` | the speech branch, `ev.act === 'ask'` (already plays under reduced-motion) | addressee's head position converted, `0` softened for team asks |

Audio is not motion — moments play under reduced-motion, matching E2 and the speech
branch. The two motion-gated hooks (`pushConfetti`, `pushDoorCue`) therefore **cannot be
the emit sites as-is**: the accept branch sits after `if (reduced) return`, and the door
pulse read is wrapped in `!reduced`. The emits move above those gates (reading
`takeDoorPulses()` exactly once for both consumers); the visual calls stay where they are.

**Pan units.** `heads.get(...)` and the entrance are **canvas pixels**; occupancy already
converts with `toX(...)` into [-1, 1]. Moments convert the same way, and the ×0.75 stereo
squeeze is applied in exactly one place — the engine, which already owns it for life
events — so callers pass raw [-1, 1] and nothing is squeezed twice.

No visual changes and no new scene events: `ask` stays unmapped in `actToEvent` (its
visual is the speech bubble it already gets).

## 3. The voices — synth only, calibrated relative

Three new leaf synths in `soundEngine.ts`, on the LIFE bus so they inherit the E2
calibration and the one-number retune story (`LIFE_GAIN`):

- **fanfare** — a quick rising major triad (the pentatonic ladder the cue set already
  uses) at slightly above keystroke gain, plus a short noise flutter (the paper). Under a
  second end to end; a celebration you notice, not a jingle.
- **door** — a low click (the latch) then a short filtered noise sigh (the closer arm),
  followed by 3–5 of the existing `footsteps` clicks panned near the door's side.
- **askbell** — one soft held sine with a slow decay (~1.2s), quieter than the firehose
  doorbell; weight, not alarm.

Every voice jitters its parameters per play, like every other synth in the file. Burst
safety: moments are act-driven and sparse by nature; the only plausible burst is a
megaphone-adjacent flood of accepts, and the façade throttles moments to one per 400ms
(pure gate, `shouldPlayMoment`, same shape as `shouldChime`).

## 4. Guardrails (all inherited)

Opt-in stays; both toggles unchanged; broadcast path works via the existing
`enableForBroadcast`; no audio assets (`public/office/` stays empty); no new timers; all
new bytes ride the lazy engine chunk except the small façade method — eager JS budget
respected (151.6/152.3 KB after E2's split leaves headroom).

## 5. Files and testing

| File | Change |
| --- | --- |
| `packages/web/src/live/soundLife.ts` | `momentFor` mapping helpers if any pure logic emerges; `shouldPlayMoment` throttle gate. |
| `packages/web/src/live/sound.ts` | `moment()` on the room-tone façade (forward-or-drop). |
| `packages/web/src/live/soundEngine.ts` | three voices + `moment()` dispatch. |
| `packages/web/src/live/office-scene/index.ts` | three one-line emits at the existing hooks. |

Tests (pure half + façade, no AudioContext): throttle gate math; façade drops (not
queues) before load and respects the preference; ask pan chooses addressee-vs-centre;
pixel→[-1, 1] pan conversion (a right-edge head must not become pan 1 squared to the
edge twice); and the reduced-motion emit split — a directed accept and a door pulse under
`reduced` still emit their moments while the visual calls stay gated.
Manual: a directed accept on `/live` with room tone on (confetti + fanfare together), a
join/leave for the door, a directed ask for the bell.

## 6. Rollout

One PR on `miley/e3-milestone-punctuation`. Spec accepted by wanderer before code. E4
(interaction sounds, lane 01M1CFKMQV) follows separately on the same plumbing.
