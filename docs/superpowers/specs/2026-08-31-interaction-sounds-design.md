# Interaction sounds — the room answers your hand

**Date:** 2026-08-31 · **Author:** miley, from the E2 design conversation with nick
**Status:** spec for review (acceptor: wanderer, per lane 01M1CFKMQVR63FZWM86CWTG3CY)
**Lane:** Delight E4 · **Goal:** office-delight · **Builds on:** E2 (90a8b331), E3 (58d26b39)

## 1. The problem

E2 made the ambient bed honest and E3 gave the room its moments — but the viewer's own
hand is still silent. Expanding a nameplate, opening the board, watching a directed act
trace to a desk: each is a felt interaction with a physical-looking room that answers
with nothing. Tiny sounds here are what "sleek, responsive" sounds like — at gains where
they register as texture, not events.

Scope, agreed with nick 2026-08-31 (three interactions):

1. **Nameplate expand/collapse** — a soft felt tick, panned to the plate; a slightly
   lower tick on collapse, so open/close are siblings, not twins.
2. **Board overlay open/close** — a quiet paper lift on open, a settle on close.
   Centre-panned: the overlay is chrome over the room, not in it.
3. **Directed-act whoosh** — the A1 light-trace to an addressee's desk gets a quiet
   airy sweep whose pan *moves* from sender to addressee over the trace's duration.

**Consent and gating:** these play only when **room tone is on** — the toggle is the
existing consent, and these are part of the room, not a new channel. No new toggle, no
new preference key. The hidden-tab gate applies as always (an unfocused tab's UI cannot
be interacted with anyway; the gate is belt-and-braces).

## 2. The plumbing — the E3 `moment` path, extended

`roomTone.moment(name, pan)` already exists (E3): preference-gated, drop-never-queue,
throttled, engine-owned ×0.75 squeeze. E4 adds four moment names rather than a new
mechanism:

```ts
type Moment = /* E3 */ 'fanfare' | 'door' | 'askbell'
            /* E4 */ | 'plateOpen' | 'plateClose' | 'boardOpen' | 'boardClose' | 'whoosh';
```

- **Throttle:** interaction moments share the E3 400ms gate. A viewer rapidly toggling a
  nameplate hears the first tick, not a typewriter — same coalesce-don't-queue rule.
- **Whoosh pan:** `moment` takes a single pan; the whoosh variant takes the *start* pan
  and the engine sweeps it toward a second value. Signature grows one optional argument:
  `moment(name, pan, panTo?)` — ignored by every other voice, so E3 call sites are
  untouched.

Emit sites (all existing interaction handlers, none new):

| Moment | Hook | Pan |
| --- | --- | --- |
| `plateOpen` / `plateClose` | the nameplate expand toggle (`index.ts` `applyExpandDom`'s caller, where `st.expanded` flips) | the plate's head x via `screenPan` |
| `boardOpen` / `boardClose` | `live.tsx` where the BoardOverlay open state flips (both directions) | `0` (chrome, centre) |
| `whoosh` | the tether emit in `showSpeech` (`addressee?.tether` with a live target) | sender's head x → addressee's head x, both via `screenPan` |

Reduced-motion: the plate and board sounds are feedback for an action the viewer *chose*
— they play under reduced-motion like the E3 moments. The whoosh accompanies a motion
effect (the tether): **when the tether does not draw, the whoosh does not play** — a
sweep describing motion that is not happening would be the dishonesty this program
exists to remove. That means the whoosh emit lives beside the tether draw, inside its
motion-gated path, deliberately — the one E4 sound that follows the visual's gate.

## 3. The voices — quieter than everything

Three shapes in `soundEngine.ts`, at or under the keystroke's level (these are under the
viewer's own hand — closer than the room, so *smaller* than the room):

- **plate tick** — one short filtered click (the felt-pad shape `tap` uses) with a small
  upward pitch offset on open, downward on close. ~50ms.
- **board paper** — a brief noise swell through a bandpass, rising on open, falling and
  shorter on close — the `drawer` family, softer.
- **whoosh** — ~350ms of lowpassed noise with a gentle amplitude arc, its `StereoPanner`
  ramped from `momentPan(pan)` to `momentPan(panTo)` over the duration. The only voice
  that animates its pan node.

All parameter-jittered per play like every voice in the file. No assets; all bytes on the
lazy engine chunk. The total-JS budget was raised to 252,000 B for E3 with ~2.6 KiB of
headroom — E4's voices are smaller than E3's; if CI disagrees, the remedy is the same
ritual, not a silent squeeze.

## 4. Files and testing

| File | Change |
| --- | --- |
| `packages/web/src/live/soundLife.ts` | widen `Moment`; no other logic (the throttle is shared). |
| `packages/web/src/live/sound.ts` | `moment` gains the optional `panTo`, forwarded. |
| `packages/web/src/live/soundEngine.ts` | three voices + dispatch; pan ramp for whoosh. |
| `packages/web/src/live/office-scene/index.ts` | plate emit at the expand flip; whoosh emit beside the tether draw. |
| `packages/web/src/routes/live.tsx` | board open/close emits at the state flip. |

Tests (pure half + façade): the widened `Moment` names dispatch (type-level); façade
forwards `panTo` and still drops before load; throttle shared across E3/E4 names (a
fanfare then an immediate plate tick coalesces). Manual: expand a nameplate, open/close
the board, send a directed message with sound on — and under reduced-motion, confirm
plate/board still sound while the whoosh stays silent with its tether.

## 5. Rollout

One PR on `miley/e4-interaction-sounds`. Spec accepted by wanderer before code. This is
the last rung of the sound arc as designed 2026-08-31; anything further (incident tone,
ask-resolution pairing, calibration retune) is a new conversation.
