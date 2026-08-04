# Broadcast gets a voice — page audio on the stream, and the asks rail on /broadcast

**Date:** 2026-08-04 · **Seat:** miley · **Lane:** 01KZ7A7H7NC0HT2K6AYPYNKRQ5
**Branch:** `feat/broadcast-audio-and-asks` · **ADR:** 228

## The problem

Two gaps on the Twitch stream, reported by nick 2026-08-04. They read as one request and are not.

**1 · The stream has no audio path at all.** Not "audio that is turned off" — no path. The capture
pipeline is frames only: CDP screencast → JPEG → `ffmpeg -f image2pipe`. Input 1 is
`-f lavfi -i anullsrc=r=44100:cl=stereo`, synthetic silence, present solely because "RTMP ingests
reject a video-only stream" (`packages/cli/src/commands/broadcast.ts`). Chrome runs `--headless=new`
in a container with no sound device. Forcing the page's two sound engines on would therefore change
nothing that reaches Twitch: WebAudio would render into a device that does not exist, and the ingest
would still receive `anullsrc`.

**2 · `/broadcast` deliberately omits the asks rail.** `/live` passes `AsksStrip` as `topSlot` to
`OfficeScene`; `/broadcast` passes nothing, on the stated grounds that "a stream cannot answer an
ask" (`OfficeScene.tsx`). The reasoning is sound for the _answering_, but it threw away the
_reporting_ with it: a viewer cannot see that thirteen asks are waiting on a human.

## Decisions taken (nick, 2026-08-04)

| Question                                           | Decision                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| How does audio reach the encoder?                  | **Virtual sound card in the container** (PulseAudio null sink + `-f pulse`), not in-page `MediaRecorder`.                             |
| Which arms get audio?                              | **Hosted (Linux) only.** The local `h264_videotoolbox` arm stays silent; no BlackHole/avfoundation work.                              |
| What does the stream sound like?                   | **Both engines, act cues rate-limited.** Room tone as a continuous bed, act cues over it, throttled so a burst is not a slot machine. |
| Multiple open asks with nobody to click "see all"? | **Cycle the lead** — one ask at a time in a single-line rail, rotating by urgency.                                                    |

## Non-goals

- Audio on the local macOS capture arm.
- Changing `/live`'s sound behaviour in any way. The cue throttle is broadcast-only; `/live`'s
  tuning has been signed off twice and is not in scope.
- Making the broadcast rail answerable. It reports; it never accepts input.
- Any change to `AsksStrip` itself.

---

## Part 1 — Audio on the wire

### 1.1 Container (`scripts/broadcast/hosted.Dockerfile`)

Add `pulseaudio` and `pulseaudio-utils` to the existing apt block. No other image change; chromium
and ffmpeg already ship with the Pulse support this needs.

### 1.2 Entrypoint (`scripts/broadcast/entrypoint.sh`)

Before the capture loop, and after the existing tailnet/daemon preflight:

1. Start the daemon with a null sink named `musterd` and make it default, so Chrome plays into a
   device that exists and `musterd.monitor` is a capturable source.
2. **Verify the sink, and fail loud if it is absent.** This is the load-bearing part. PulseAudio as
   root in a container is the likeliest thing here to break, and its failure mode is silent: the
   stream goes live and carries silence, indistinguishable to the operator from a working stream
   until someone listens. The entrypoint already holds the precedent — it refuses to start when the
   tailnet is down or the daemon is unreachable, on the stated grounds that "failing loud _before_
   going live beats a stream that opens on a black stage." The sink joins that block.

> **Correction to the brainstormed design.** This check was first proposed for
> `musterd stream doctor`. It cannot live there: every `doctor` check runs on the operator's
> machine (tailscale, flyctl, app, secrets, image digest), and the sink exists only inside the Fly
> container. The entrypoint preflight is the correct home.

Implementation note, to be verified rather than assumed: PulseAudio refuses to run as root under its
default invocation. System mode with `--disallow-exit` is the expected form. If it proves fragile,
the fallback is a non-root user for the Pulse daemon — decided at implementation time, against a
real container, not here.

### 1.3 Capturer (`packages/cli/src/commands/broadcast.ts`)

A new `--audio` flag on `musterd broadcast`, **off by default**. The hosted entrypoint passes it;
nothing else does, which is what keeps the local arm and every existing invocation byte-identical.

When set:

- **`chromeArgs`** adds `--autoplay-policy=no-user-gesture-required`. This is what lets the page's
  `AudioContext` start without a click — a stream never gets one.
- **`ffmpegArgs`** swaps input 1 from `anullsrc` to `-f pulse -i musterd.monitor`, and adds
  `-af aresample=async=1`.
- `anullsrc` remains the default path. The "ingests require an audio track" guarantee is untouched.

**Why `aresample=async=1` is not optional.** Video timestamps are synthesized by ffmpeg from frame
_count_ (`image2pipe` + `-framerate`); Pulse audio arrives on wall clock. Two clocks, no shared
reference — over a four-hour stream they separate. `aresample=async=1` makes audio the follower and
lets ffmpeg absorb the difference by stretching or dropping samples. The existing drift-compensating
pump keeps video near real time, which keeps the correction small.

**Runtime guard.** With `--audio`, a failed Pulse input must fail the run rather than degrade to
silence. Silence that looks like success is the specific outcome this whole increment exists to
prevent.

### 1.4 Page (`packages/web/src/live/sound.ts`, `routes/broadcast.tsx`)

Three changes, each narrow:

- **Non-persisting enable.** Both `FirehoseSound.setEnabled` and `RoomTone.setEnabled` write
  `localStorage`. A stream must not rewrite the operator's saved preferences, so each engine gains an
  explicit non-persisting enable used only by `/broadcast`. Not a `persist?: boolean` parameter on
  `setEnabled` — a separately named entry point, because the call site should read as what it is.
- **Visibility bypass.** `RoomTone` suspends its context on `document.hidden` and gates its LIFE
  scheduler on the same flag — correct for a viewer, wrong for a capture box. Broadcast bypasses it
  for exactly the reason it already bypasses `prefers-reduced-motion`: there is no viewer here whose
  preference this is. (Non-theoretical: headless and embedded Chrome surfaces have been observed
  reporting `document.hidden === true` throughout their lifetime.)
- **`?audio=0`** disables page audio, for a deliberately silent capture. Default on `/broadcast` is
  audio on.

`RoomTone`'s occupancy feed needs no work: `office-scene/index.ts` already pushes who-is-near-whom
into the engine from the scene itself, on every route.

### 1.5 The cue throttle

A token bucket in front of `firehoseSound.chime`, **broadcast-only**: roughly one cue per 700 ms,
with a burst coalescing to a single cue rather than queueing. A dropped cue plays nothing later —
the visual channel (speech bubble, stream panel) already carries every act, so the audio does not
owe the viewer completeness.

Written as a pure function over `(now, lastFired)` so it is unit-testable without an `AudioContext`.

### 1.6 The mix — a measurement, not a design decision

`ROOM_GAIN = 0.075` against cue gains near `0.1`, tuned for headphones at a desk. Through Twitch's
loudness handling the bed may be inaudible. This spec does **not** guess a number.

One calibration pass at implementation time: capture to a file sink with `--audio`, run
`ffmpeg -af ebur128`, set a single broadcast master gain, and record the measured value here in the
form `LIFE_GAIN` is recorded in `sound.ts` — the number plus what was measured to get it.

> **Broadcast master gain: ×4 (+12 dB) — `BROADCAST_MASTER_GAIN` in `sound.ts`.** Measured
> 2026-08-04 on the real hosted pipeline (Fly performance-4x sjc, session-mode PulseAudio null
> sink → `--audio` → libx264/aac, 120 s file capture of the live revive office): the unscaled mix
> integrated at **−42.8 LUFS, LRA 1.8 LU** — a real signal (silence floor is −70), but ~25 dB
> under where even deliberate ambience should sit on a stream. ×4 lands the bed near −30 LUFS:
> audible at normal viewer volume, still unmistakably background. This is ambience, not program —
> do **not** normalize it toward −14 LUFS speech loudness. The same pass also corrected the Pulse
> invocation: system mode denies root clients (`pulse-access` gating, observed live as the
> preflight refusing to start); a root _session_ daemon warns and works.

---

## Part 2 — The asks rail on /broadcast

### 2.1 A new component, not a mode flag

`AsksStrip` is ~460 lines of _answerability_: `sendAct`, sign-in offers, the Escape/click-outside
sheet, `document.title` mutation. Threading a `broadcast` branch through it makes both jobs harder to
read and couples a stream chyron to a form.

The seam already exists. The derivation lives in `asks.ts` (`deriveAsks`, `byUrgency`, `askIsLoud`)
as pure functions over the envelope timeline. So:

- **`packages/web/src/live/AsksReel.tsx`** — new, read-only, consumes the same `asks.ts`.
- Passed as `topSlot` from `/broadcast`.
- `AsksStrip` does not change. Neither component grows a mode.

### 2.2 Behaviour

- Renders `null` when there are no asks — same as `/live`.
- Shows **one** ask at a time: bell, avatar, name, species verb, gist, tier chip, live clock.
- Cycles every ~6 s through the loud asks in `byUrgency` order, then the deferred.
- Static meta: waiting / deciding / settled counts.
- No buttons, no links, no sheet, no `document.title` mutation, no sign-in offer.
- Keeps the 1 s clock tick, and keeps `/live`'s rule that it stops when nothing is loud — idle cost
  is paid by every viewer forever (`packages/web/AGENTS.md`).

### 2.3 Sized for a 720p stream, not a desk

`.lc-asks__rail` is `font-size: 11.5px`, with several elements smaller again. The stage is 1080p and
the stream is encoded at 720p (×0.667), landing that near 7.7px _before_ Twitch's encoder. Ported
as-is the panel would be present and unreadable — worse than absent, because it costs stage area and
returns nothing.

`AsksReel` therefore carries its own type scale, roughly 1.6× the rail's. This is a second reason it
is a separate component: the two have genuinely different legibility constraints, and one stylesheet
cannot serve both without a mode.

### 2.4 `OfficeScene`

The `topSlot` doc comment states "`/broadcast` passes nothing: a stream cannot answer an ask." That
becomes false. Update it to say what is now true: `/live` seats the answerable rail here,
`/broadcast` seats the read-only reel.

---

## Testing

**Pure units (vitest), all without a browser or an AudioContext:**

- the cue throttle's token bucket;
- `AsksReel`'s cycle-index math over a list of asks;
- `ffmpegArgs` in its audio variant — Pulse input present, `anullsrc` absent, `aresample` present;
- `ffmpegArgs` without `--audio` — byte-identical to today, the regression that matters most;
- `chromeArgs` with and without the autoplay flag.

**Real runs (cannot be faked, and the failure mode is silence):**

- a short hosted capture to a file sink with `--audio`;
- `ffprobe` — a genuine AAC track, and a non-silent one;
- `ffmpeg -af ebur128` — the level, which also produces §1.6's number;
- a 720p screenshot proving the reel is legible after downscale.

**Perf gate.** `/broadcast` gains a component, so `pnpm perf:check` runs. `totalJsGzipBytes` will
move. If it breaches, the remedy is deleting code or dropping a dependency — **not** raising the
budget (ADR 183). `AsksReel` reuses `asks.ts` and adds no dependency, so the expected delta is small.

## Documentation

- **ADR 228**, with its required `## Observability & Evaluation` section (`pnpm gates`).
- `FEATURE_EPOCH` bump — this is a client-visible capability change (ADR 148).
- Update the broadcast hosting spec for the container's new audio stage.

## Risks

| Risk                                                                              | Mitigation                                                                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| PulseAudio-as-root fails, and fails **silently** — a live stream carrying silence | Entrypoint preflight refuses to start without a verified sink; capturer fails the run on a dead Pulse input |
| A/V drift over a multi-hour stream (frame-count vs wall-clock timestamps)         | `-af aresample=async=1`; the drift-compensating pump keeps the correction small                             |
| The mix is inaudible, or too loud, after Twitch's loudness handling               | One measured `ebur128` calibration pass; the number recorded in §1.6, not guessed                           |
| Byte budget breach on `/broadcast`                                                | Reuses `asks.ts`, no new dependency; if it breaches, delete rather than raise                               |
| The reel is unreadable at 720p                                                    | Its own type scale, verified by screenshot at stream resolution before merge                                |
