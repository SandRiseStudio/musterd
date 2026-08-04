# 228 — Broadcast audio and the asks reel

- **Status:** accepted
- **Date:** 2026-08-04
- **Owner:** miley
- **Supersedes / relates to:** ADR 157 (broadcast mode + capturer, whose silent-audio input this
  replaces when armed), ADR 147/149/222 (the ask stream and its /live rail, which gain a read-only
  stream surface), ADR 151 (the perf contract the reel lives under), ADR 155 (presence safety, which
  the reel inherits by never taking input)

## Context

Nick, watching the Twitch stream (2026-08-04): the act cues and the office room tone aren't there,
and neither is the asks rail that sits over the office on /live.

The two halves of that report have opposite shapes.

**The sound was never off — there was no audio path.** The ADR 157 capturer is frames only: CDP
screencast → JPEG pipe → ffmpeg. Its audio input is `anullsrc`, synthetic silence muxed in solely
because RTMP ingests reject video-only streams. Chrome runs headless in a Fly container with no
sound device, so the page's WebAudio graph — had it even been enabled — would have rendered into
nothing. Two engines exist on the page (`firehoseSound`, per-act cues; `roomTone`, the ambient bed),
both default OFF, both requiring a user gesture a stream never gets, both persisting their toggle to
`localStorage`.

**The asks rail was omitted on purpose, but the purpose over-reached.** `OfficeScene`'s `topSlot`
doc said "/broadcast passes nothing: a stream cannot answer an ask." True of the _answering_ —
`AsksStrip` is ~460 lines of answerability (sendAct, sign-in, a sheet, `document.title`) — but it
threw the _reporting_ away with it: a stream viewer could not see that thirteen asks were waiting on
a human.

There is also a legibility constraint that shaped everything in part 2: the 1080p stage streams at
720p (×0.667), so /live's 11.5px rail lands near 7.7px before Twitch's encoder touches it. Ported
as-is it would be present and unreadable — worse than absent.

## Decision

**Audio (hosted arm only — nick's call, 2026-08-04):**

1. The capture container runs a PulseAudio null sink named `musterd` (system mode, root container).
   The entrypoint verifies `musterd.monitor` exists **before going live and refuses to start
   without it** — a missing sink does not look like a failure; the stream opens, animates, and
   carries silence until a human listens.
2. `musterd broadcast --audio` (default off) swaps ffmpeg's `anullsrc` input for
   `-f pulse -i musterd.monitor` plus `-af aresample=async=1`, and adds
   `--autoplay-policy=no-user-gesture-required` to Chrome. `aresample` is load-bearing: video
   timestamps are synthesized from frame _count_, Pulse audio is wall-clock — two clocks with no
   shared reference separate over a four-hour stream, and audio must follow.
3. The page enables both engines on /broadcast via a new `enableForBroadcast()` on each —
   non-persisting (a stream must not rewrite a human's saved preference) and, for `roomTone`,
   bypassing the `document.hidden` gate for the same reason broadcast already ignores
   `prefers-reduced-motion`: there is no viewer here whose preference that is. `?audio=0` opts a
   capture out.
4. Act cues are throttled on broadcast only (`shouldChime`, 700ms floor, bursts coalesce to one
   cue). The cue set was tuned for a person at a desk with sparse arrivals; unthrottled, a busy
   minute on stream is a slot machine. A dropped cue owes nothing later — the visual channel already
   carries every act. /live's tuning is untouched.
5. The local macOS arm stays silent. No BlackHole, no avfoundation — out of scope by decision, not
   omission.

**The asks reel:**

6. A new `AsksReel` component rides /broadcast's `topSlot`: the same `asks.ts` derivation as
   `AsksStrip`, none of its input surface. One ask at a time, rotating every 6s through the loud
   asks by urgency then the deferred; counts (waiting / deciding / settled) on the right; its own
   type scale (~1.6× the rail's) sized for the 720p encode. Null only when the timeline holds no
   asks at all — with everything settled it shows /live's quiet "nothing waiting on a human" row,
   because a bar that blinks out whenever the last ask closes reads as breakage on a video.
7. It is a separate component, not a `broadcast` prop on `AsksStrip`. The strip's job is
   answerability and the reel's is legibility at stream resolution; the shared part — the
   derivation — already lives in `asks.ts` as pure functions, which is the real seam.

## Consequences

- The hosted stream carries the office's actual sound. The container image grows by pulseaudio;
  the capture spend is unchanged (audio encode is noise next to the video encode).
- A hosted launch now has one more way to refuse to start — deliberately. The preflight trades a
  failed launch (visible, diagnosable, cheap) for a silent live stream (invisible, hours of waste).
- `/broadcast` becomes the perf-gate's worst route (initial 133.3 KB of 142.6 KB budgeted) — inside
  budget, no raise.
- The default `musterd broadcast` path is pinned byte-identical by test; every existing invocation,
  including the local arm, behaves exactly as before this ADR.
- The mix level through Twitch's loudness handling is a **measurement, not a design value**, and it
  has not been taken yet: the calibration pass (file capture with `--audio` → `ffprobe` →
  `ebur128`) runs on the capture box and records its number in the spec
  (`docs/superpowers/specs/2026-08-04-broadcast-audio-and-asks-design.md` §1.6). Until then the
  broadcast master gain is the engines' /live tuning.

## Observability & Evaluation

**Traces.** No new span — the capture pipeline is not an agent action. The signals are the machine
log and the artifact itself: the entrypoint's `▸ audio sink up · musterd.monitor` line (or the loud
`✗ no PulseAudio sink` refusal) says whether the sink existed before the stream opened, and ffmpeg's
existing 10s `-stats` heartbeat carries the encode's delivery truth unchanged.

**Eval** — dataset: a `--duration 120 --out` calibration capture taken on the capture box with
`--audio`, probed with `ffprobe -select_streams a:0` and `ffmpeg -af ebur128`. Baseline: the pre-ADR
pipeline, whose `anullsrc` track measures at the −70 LUFS silence floor by construction.

- **Pass:** the capture carries a real AAC stream whose integrated loudness sits well above
  −70 LUFS, and the measured value is recorded in the design doc's §1.6 (the blank it is holding).
  A passing encode with a silent track is this feature's specific failure mode, so this probe is the
  acceptance check for any future change to the audio path.
- **Fail (mix, not mechanism):** audio present but inaudible or hot after Twitch's loudness
  handling — retune the single broadcast master gain and re-measure; never scatter per-synth
  factors (the `LIFE_GAIN` lesson).
- **Fail (mechanism):** no audio stream, or the entrypoint preflight passing while ffmpeg reads an
  empty monitor — the runtime guard must then fail the run rather than stream silence.

**Experiment.** n/a beyond the calibration pass above — the throttle (`shouldChime`) and reel
(`reelIndex`) are pure functions pinned by unit tests (`sound.test.ts`, `reel.test.ts`), the
no-`--audio` argv is pinned byte-identical by `broadcast.test.ts`, and reel legibility at 720p was
verified against a live team before merge (screenshot in PR #647). If cue density on a busy stream
day still reads as noisy at 700ms, the gap is a tuning knob with a measured starting point, not a
redesign.

## Alternatives considered

- **Capture audio inside the page** (WebAudio → `MediaStreamDestination` → `MediaRecorder` → CDP).
  Hermetic, works on both arms — but novel plumbing, and it makes us own A/V sync by hand. The
  PulseAudio route is boring, ffmpeg owns the mux, and the one arm it serves is the one that
  streams. Rejected with the local arm descoped.
- **A `broadcast` prop on `AsksStrip`.** One component, but every branch of a 460-line form would
  need a "unless streaming" clause, and the type scale still forks. Rejected: the derivation is the
  shared part, and it is already a module.
- **Rendering all loud asks as a stack on stream.** Nothing hidden, but it covers the office — the
  thing the stream is _of_. Rejected for the cycling reel (dwell time is cheaper than stage area,
  same trade the WorkStack chyron already made).
- **Unthrottled cues** (exactly /live with sound on). Honest, and unlistenable on a busy day.
