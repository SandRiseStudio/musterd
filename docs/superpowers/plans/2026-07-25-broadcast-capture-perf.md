# Broadcast: measure the capture pipeline, then make it hold real time

Plan, 2026-07-25. Approved by nick, **not started** — it is queued deliberately, because every
number in it has to be taken on a quiet machine and nick is arranging that separately.

Prior art: ADR 157 (broadcast mode + its three stutter defects), ADR 159 (the stop path, the stall
watchdog, and the Experiment section this plan answers).

## Context

`musterd broadcast` streams the isometric office by piping a headless-Chrome CDP screencast into
ffmpeg. It has no margin: on a quiet machine it holds ~0.99× real time; under the load this box
routinely carries it falls behind until the ADR 159 stall watchdog ends the stream.

**Three optimization hypotheses have now died, two of them after I'd already half-believed them.**
That record is why this plan measures before it changes anything.

- **"Lower the JPEG quality."** 177 KB → 84 KB, visually identical. Interleaved A/B: no improvement,
  arguably worse. Decode cost is set by **pixel count, not file size** (177 KB vs 67 KB moved ffmpeg
  175 → 182 fps).
- **"ffmpeg is the bottleneck."** Fed from a file it sustains ~175 fps, ~6× what we need.
- **"The office is mostly static, so send only changed frames and let ffmpeg duplicate."** I proved
  the _mechanism_ works — 3 JPEGs over 2.5 s produced 91 frames at exactly 30 fps CFR, and 50 frames
  over 10.24 s produced 301 frames / 10.033 s, so wall-clock stamps even fix the #367 drift class.
  **Then exploration killed the premise.** See below. No code was written.

**Outcome:** a repeatable harness that says where the time actually goes, and — if the data supports
it — a pipeline that holds real time at 30 fps with margin.

**Run this on a quiet machine.** Every measurement in the previous session was contaminated; load
swung between 5 and 63 as other sessions built. That contamination is what made one lucky run look
like a win.

---

## Why "deduplicate frames" is dead

Two facts from the office render code, both load-bearing:

1. **Broadcast disables the ambient FPS cap.** `ambientFrameBudgetMs(broadcast, capMs)` returns `0`
   under broadcast (`packages/web/src/live/office-scene/broadcast.ts:51-53`), so the skip branch at
   `index.ts:616` is dead code and **every rAF tick draws**. With any seat `activity === 'working'`,
   `living()` (`index.ts:588-592`) stays true and the loop never parks.
2. **The screencast captures the page, not the canvas.** The Tier-A CSS overlay — dust motes, string
   lights, fan blades, nook steam, the daylight wash (`index.ts:164-186`, `260-297`) — animates
   continuously on the compositor regardless of what the canvas does.

Add the always-animating canvas elements (a firefly wisp over _every_ member's head,
`character.ts:468-484`; breathing, `skeleton.ts:431`; monitor aurora and code-typing,
`render.ts:1888-1930`) and during a real stream **~0% of frames are pixel-identical**. There is
nothing to deduplicate. ADR 157's own headless test had to arrange a working seat for exactly this
reason, and hashes the _canvas_ rather than a page screenshot "whose topbar clock always moves".

**Do not "fix" this by animating less.** Those elements are the brief — magical, warm, alive.

---

## The lead this hands over instead

Broadcast draws at **full rAF (~60 fps)** while the encoder consumes **30**, and Chrome's screencast
delivers ~**35 fps** (measured in #369: `jpeg@85 35.3 fps @ ~181 KB/frame`). So the page is being
painted roughly twice for every frame that reaches the encoder.

#368 removed the 20 fps ambient cap because 20 fps content resampled onto a 30 fps encode duplicates
every third frame — real cadence judder, correctly diagnosed. But the fix went from _too slow_ to
_uncapped_, when the principled setting is **the capture rate**. Drawing 60 and sampling ~35 is both
wasted work and a plausible beat-frequency judder source in its own right.

**Candidate: cap the broadcast draw rate to the capture fps.** Cheap, invisible if correct, and it
attacks the constraint the evidence actually points at — Chrome's compositor-thread cost. It must be
proven not to reintroduce #368's judder, which is the whole risk.

---

## Phase 1 — Measure (first, on the quiet machine)

No broadcast harness exists (`docs/perf/` and `scripts/perf/` are web/bundle-only). Follow the house
method from `docs/perf/web-live-baseline.md` and `packages/web/AGENTS.md`: **reproducible method →
baseline tables → dated optimization log → an explicit "deliberately not done" list.** Model any
script on `scripts/perf/live-baseline.mjs` (dependency-free, raw CDP, temp Chrome profile).

Instrument, gated behind an env var so it ships inert (the `?beat=` precedent):

| what                                  | why                                                         | how                                     |
| ------------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| screencast delivery fps + bytes/frame | the real input rate — is it still ~35?                      | count `Page.screencastFrame`, sum bytes |
| canvas draw rate in broadcast         | expected ~60 vs 30 consumed — the suspected waste           | rAF/draw counters via `window.__office` |
| ffmpeg queue depth over time          | **the margin metric**                                       | sample `ffmpeg.stdin.writableLength`    |
| CPU per process + load average        | so contamination is visible in the data, not inferred later | `ps -o pcpu` per pid, `uptime`          |

**Baselines to record, all at a quiet load:** 1080p30 (today), 1080p30 with draws capped to 30,
720p30, and 1080p15.

**One trap to avoid.** `speed=` is pinned at ≈1× _by construction_ for a live source — the pump feeds
ffmpeg on a wall clock, so it reports only whether the encoder kept up, never by how much it could
have. Captures at 30/20/15 fps all returned ~1.0×, which reads like "fps makes no difference" and
means nothing of the sort. **Queue growth rate is the margin metric.**

---

## Phase 2 — Optimize (only what Phase 1 justifies)

**1. Cap the broadcast draw rate to the capture fps.** Change `ambientFrameBudgetMs` so broadcast
returns `1000 / fps` rather than `0`, threading the capture fps through
`OfficeOptions.broadcast`. Falsified if delivered fps drops, or if #368's judder returns — verify by
eye on walking members, not only by frame counts.

**2. 720p.** On the table pending data. Roughly halves pixels/second; Twitch treats 720p30 as a
standard tier and flat-shaded isometric art holds up far better than photographic content would.

**3. Frame rate.** The proven lever (30 fps stalled 2/2, 15 fps 0/2 under matched load), kept last
because it visibly costs smoothness. `--fps 15` already works; the default stays 30 unless the others
prove insufficient.

**Not on the table:** reducing what the office animates.

---

## Critical files

| file                                                  | role                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `packages/web/src/live/office-scene/broadcast.ts`     | the four inverted predicates, incl. `ambientFrameBudgetMs`     |
| `packages/web/src/live/office-scene/index.ts:602-664` | the rAF loop, `capped`, the park branch                        |
| `packages/cli/src/commands/broadcast.ts`              | `ffmpegArgs`, `makeFramePump`, `STALL_BYTES`, screencast start |
| `packages/cli/src/commands/broadcast.test.ts:109-217` | pump/drift tests — the recorded #367 lesson                    |
| `docs/perf/`                                          | where the harness and its numbers belong                       |

**Reuse:** the CDP client already in `broadcast.ts`; `scripts/perf/live-baseline.mjs` as the harness
template; `window.__office` / `window.__broadcastReady` as probe surfaces.

**Drive-by worth fixing while in here:** `docs/decisions/157-broadcast-mode.md:141-142` still says
"Backpressure is drop-not-queue", written before #367 and now the exact opposite of shipped policy —
dropping a frame is _not_ invisible, it permanently slows the timeline. The code comments already
contradict it.

---

## Verification

- `pnpm exec vitest run packages/cli packages/web` — pump/timing tests and the broadcast predicate
  regressions (that non-broadcast still parks and still caps DPR).
- **Fidelity over a long run:** a 10-minute capture must produce exactly `fps × seconds` frames and
  10 minutes of media. ADR 159's existing acceptance check is "a 10 s capture → exactly 300 frames at
  30 fps"; ADR 157 adds "timeline within 0.3 s of wall clock over minutes".
- **Judder check by eye.** #368 was invisible in the numbers and obvious to a viewer. Watch a walking
  member and the dog crossing the floor before believing any frame-rate change.
- **Interleaved A/B under matched load**, alternating old/new — the standard that caught the quality
  hypothesis. Never trust a single run.
- Full gates: `pnpm exec vitest run`, `tsc --noEmit`, `pnpm lint`, `pnpm format:check`,
  `pnpm perf:check`.
- Append the numbers to ADR 159's Experiment section, and record the dead hypotheses in
  `docs/perf/` so nobody re-chases them — the house convention for measured-and-rejected levers.
