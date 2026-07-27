# Broadcast capture-pipeline baseline — `musterd broadcast`

**Date:** 2026-07-25 · **Commit:** _harness landed; numbers pending_ · **Author:** miley

The capture pipeline is the one musterd surface with no measured margin. On a quiet machine it holds
~0.99× real time; under the load this box routinely carries it falls behind until the ADR 159 stall
watchdog ends the stream. This is the baseline log for it, in the house shape used by
`web-live-baseline.md`: **reproducible method → baseline tables → dated optimization log → an
explicit "deliberately not done" list.**

Plan: `docs/superpowers/plans/2026-07-25-broadcast-capture-perf.md`. Prior art: ADR 157 (broadcast
mode), ADR 159 (stop path + stall watchdog).

> **Status: the harness is built, the numbers are not taken.** The tables below are deliberately
> empty. Every measurement in the session that produced this plan was contaminated — load swung
> between 5 and 63 as other sessions built — and a contaminated baseline is worse than no baseline,
> because it looks like data. Fill these in from a quiet machine.

## Method (reproducible)

```sh
pnpm build
node scripts/perf/broadcast-baseline.mjs --label "1080p30 (today)" --fps 30 --secs 60
```

The harness sets `MUSTERD_BROADCAST_PERF=<scratch>.jsonl`, runs a real `musterd broadcast` to a temp
`.mp4` it then deletes, and summarizes the samples with the recorder's own tested code
(`packages/cli/dist/commands/broadcast-perf.js`) so the harness cannot drift from the numbers. It
**refuses to run above load average 2.0** (`QUIET_LOAD_MAX`); `--force` overrides, and the summary is
stamped `contaminated` either way. It exits non-zero on a contaminated run.

The instrumentation ships inert: with `MUSTERD_BROADCAST_PERF` unset there are no CDP round-trips, no
per-second `ps` fork, and no file handle — the `?beat=` precedent. Per-sample fields are documented on
`PerfSample` in `packages/cli/src/commands/broadcast-perf.ts`.

### Read the queue, not `speed=`

**`speed=` is pinned at ≈1× by construction for a live source.** The pump feeds ffmpeg on a wall
clock, so `speed=` reports only whether the encoder kept up, never by how much it _could_ have.
Captures at 30/20/15 fps all returned ~1.0×, which reads like "fps makes no difference" and means
nothing of the sort. **Queue growth rate (KB/s) is the margin metric** — a pipeline with headroom
holds a flat queue, one without grows one.

## Baseline numbers

_Pending a quiet machine._ Run each row with the command above; `--secs 60` minimum, and re-run
interleaved rather than trusting a single capture.

| Config                   | delivered fps | draw fps | draws/delivered | queue growth | peak queue | chrome %CPU | load1 |
| ------------------------ | ------------- | -------- | --------------- | ------------ | ---------- | ----------- | ----- |
| 1080p30 (today)          | —             | —        | —               | —            | —          | —           | —     |
| 1080p30, draws capped 30 | —             | —        | —               | —            | —          | —           | —     |
| 720p30                   | —             | —        | —               | —            | —          | —           | —     |
| 1080p15                  | —             | —        | —               | —            | —          | —           | —     |

**What the first row is expected to show,** from #369's spot measurement: delivered ~35 fps at
~181 KB/frame, canvas drawing at ~60, so **draws/delivered ≈ 1.7–2.0**. If that holds, the page is
being painted roughly twice for every frame that reaches the encoder, and the plan's candidate #1 is
live. If it does not hold, candidate #1 is dead and the next lever is 720p.

## Rented hardware (Increment 0 run D — Fly `performance-4x`, sjc, 2026-07-27)

Full context and verdict in the hosting spec
(`docs/superpowers/specs/2026-07-26-broadcast-hosting-design.md`). Method: the same harness against
a 6-seat synthetic fixture (`scripts/perf/broadcast-bench-fixture.sh`), daemon local to the box, all
runs quiet.

| Config | delivered fps | draw fps | encoded | queue growth | chrome % | ffmpeg % | pipeline % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fly 1080p30 libx264 | 10.2 | 19.2 | 30.0 | 0.5 KB/s | 177.4 | 80.7 | 267.9 |
| fly 1080p30 repeat | 10.6 | 20.8 | 30.0 | −1.1 KB/s | — | — | — |
| fly 1080p30 `--disable-gpu` | 10.3 | 20.2 | 30.0 | −0.3 KB/s | 186.5 | 85.4 | 282.1 |

Readings: `libx264` on a dedicated x86 core is ~0.85 core with a flat queue (fine); the compositor
holds ~20 Hz, not 60, because one Chrome thread pegs a core while three idle (fatal — delivery is
~10 fps padded to 30 with duplicates). Single-thread speed, not cores, is the capture's real
requirement; more/bigger cloud does not help, and `--disable-gpu` moves nothing.

(The Air's own opportunistic `libx264` arm was contaminated — other processes 266% — and is recorded
only directionally: ffmpeg ~102%, queue +502 KB/s, delivered 22.4. The Air cannot software-encode
1080p30 either.)

## Hypotheses already measured and rejected

Recorded so nobody re-chases them. Three died before this harness existed, two of them after being
half-believed.

| Hypothesis                       | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lower the JPEG quality**       | **Dead.** 177 KB → 84 KB, visually identical, no improvement — arguably worse. Decode cost is set by **pixel count, not file size**: 177 KB vs 67 KB moved ffmpeg only 175 → 182 fps.                                                                                                                                                                                                                                              |
| **ffmpeg is the bottleneck**     | **Dead.** Fed from a file it sustains ~175 fps, ~6× what the pipeline needs.                                                                                                                                                                                                                                                                                                                                                       |
| **Deduplicate unchanged frames** | **Dead on its premise, not its mechanism.** The mechanism works (3 JPEGs → 91 frames at exactly 30 fps CFR; 50 frames over 10.24 s → 301 frames / 10.033 s, which would even fix #367 drift). But broadcast disables the ambient FPS cap so every rAF tick draws, and the screencast captures the _page_, where the CSS overlay animates continuously. **~0% of frames are duplicates during a real stream.** No code was written. |

## Optimization log

_Empty. Nothing has been changed yet — that is the point of the plan._

## Deliberately not done

- **Reducing what the office animates.** The dust motes, string lights, fan blades, nook steam,
  fireflies, breathing and monitor aurora are the brief — magical, warm, alive. They are not a perf
  budget line item.
- **Trusting `speed=`.** See above.
- **Single-run comparisons.** Interleaved A/B under matched load is the standard; it is what caught
  the JPEG-quality hypothesis.

## Known gap in the plan's candidate #1

The plan proposes capping the broadcast draw rate by making `ambientFrameBudgetMs` return `1000/fps`
instead of `0`. **That alone caps only ambient-only stretches.** The budget is consulted behind the
`capped` predicate at `packages/web/src/live/office-scene/index.ts:614`:

```ts
const capped = noRealMotion && cues.length === 0 && !inAfterglow;
```

During a walk, a cue, or the afterglow tail — i.e. whenever the office is most expensive to draw —
`capped` is false and the loop paints every rAF tick regardless of the budget. Capping the draw rate
to the capture fps therefore needs the `capped` predicate itself to be broadcast-aware, not just the
budget it consults. Measure first; the draws/delivered ratio will say how much this is worth.
