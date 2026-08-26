# Motion under 720p25 capture

**What this file is for:** the motion scale (spec `2026-08-25-motion-scale-design.md`) pins every
duration to a whole number of frames at the `/broadcast` capture rate. This is where the evidence for
that lives, and where a frame count gets re-measured when the capture settings change.

**Capture rate:** 720p25 with a capped draw rate. **One frame = 40ms.**

## The rungs, in frames

| Token | Value | Frames @25fps |
|---|---|---|
| `--lc-dur-1` | 120ms | 3 |
| `--lc-dur-2` | 200ms | 5 |
| `--lc-dur-3` | 280ms | 7 |
| `--lc-dur-4` | 400ms | 10 |
| `--lc-dur-5` | 600ms | 15 |

Enforced by `pnpm tokens:check` (rule 3): a duration that is not a whole multiple of 40ms fails the
build, because its last rendered step on the stream is a partial frame.

## The overshoot question, and why the spec was wrong about it

**Date:** 2026-08-25. **Method:** `--lc-ease-pop` sampled at 40ms intervals across each rung, the
sampled maximum compared against the curve's true peak.

The spec (§3, §7) asserted that overshoot was the riskiest easing family at 25fps, on the reasoning
that *"an overshoot peak can fall between two captured frames and simply not exist on the stream."*
**That reasoning does not survive contact with the curves.**

`--lc-ease-pop` = `cubic-bezier(0.34, 1.56, 0.64, 1)` has its true peak at y=1.0978 (a 9.8%
overshoot) at x=0.573. Sampled at capture cadence:

| Rung | Peak lands at | Falls between frames | Overshoot captured |
|---|---|---|---|
| 200ms (5f) | 115ms | 2 and 3 | **99%** |
| 280ms (7f) | 160ms | 4 and 5 | **100%** |
| 400ms (10f) | 229ms | 5 and 6 | **99%** |
| 600ms (15f) | 344ms | 8 and 9 | **99%** |

Two rejected alternatives behave the same way — `(0.34, 1.4, 0.5, 1)` retains 97–100%, and
`(0.2, 0.9, 0.25, 1.08)` retains 91–100%.

**Why the premise was wrong:** a cubic-bezier's overshoot is a broad, smooth maximum, not a spike. A
sample taken anywhere near it captures nearly all of it, and the curve's shape makes a narrow peak
impossible — there is only one control-point pair, so it cannot oscillate. The failure mode the spec
imagined belongs to spring physics with a stiff constant, which produces genuinely narrow peaks and
which this codebase does not use.

**Conclusion:** `--lc-ease-pop` keeps `cubic-bezier(0.34, 1.56, 0.64, 1)`. No retune. The falsifier
the spec proposed cannot fail for any cubic-bezier, so it is not a useful gate — this analysis
replaces it.

**What remains genuinely at risk at 25fps** is short *durations*, not easing shape: below three
frames (120ms) a transition has too few samples to read as motion regardless of curve. That is what
rule 3 and the scale's floor exist for, and it is the constraint that earned its place.

## Reproducing

The sampling analysis is arithmetic on the control points and needs no capture — evaluate the bezier
at `t = frame × 40ms / duration` for each frame and compare the maximum to the curve's true peak.

A visual confirmation on the live stream is worth doing **after merge**, and only after: the hosted
capture renders `http://${AIR_IP}:4849`, which is the daemon's build of `main`. A branch's motion is
not on the stream until it lands, so a pre-merge capture measures the previous scale and tells you
nothing about the change under review.
