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

| Rung | Frames | Aligned phase | Worst-case phase |
|---|---|---|---|
| `--lc-dur-1` 120ms | 3 | 86.8% | **56.6%** |
| `--lc-dur-2` 200ms | 5 | 98.7% | 83.2% |
| `--lc-dur-3` 280ms | 7 | 100% | 91.2% |
| `--lc-dur-4` 400ms | 10 | 98.7% | 95.6% |
| `--lc-dur-5` 600ms | 15 | 98.7% | 98.1% |

**Both columns matter, and the first version of this file printed only the first.** "Aligned" assumes
the transition starts exactly on a capture frame. It does not: a user-triggered transition begins
whenever the user acts, so the capture grid sits at an arbitrary phase against it, and the sample
nearest the peak can be up to half a frame away. The worst-case column is the minimum over every
phase offset.

Two rejected alternatives behave the same way — `(0.34, 1.4, 0.5, 1)` and `(0.2, 0.9, 0.25, 1.08)`
retain 97–100% and 91–100% respectively at aligned phase.

**Why the premise was wrong:** a cubic-bezier's overshoot is a broad, smooth maximum, not a spike. A
sample taken anywhere near it captures most of it, and the curve's shape makes a narrow peak
impossible — there is only one control-point pair, so it cannot oscillate. The failure mode the spec
imagined belongs to spring physics with a stiff constant, which produces genuinely narrow peaks and
which this codebase does not use.

**Where that stops being comfortable:** `--lc-dur-1`. Three frames across the whole transition means
at worst one sample near the peak, and 56.6% of a 9.8% overshoot is a 5.5% one — visible as a
weaker pop, not as no pop. This is the honest limit of the claim, and the reason the earlier
phrasing *"no cubic-bezier can fail it"* was an overclaim rather than a result.

**Conclusion:** `--lc-ease-pop` keeps `cubic-bezier(0.34, 1.56, 0.64, 1)`. No retune — and, verified
in the stylesheets, `pop` is used on `--lc-dur-2` through `--lc-dur-5` and **never on
`--lc-dur-1`**, which is where the margin would be thin. At the rungs it is actually used on, the
overshoot survives capture at any phase (83.2% worst case and rising with the rung).

The falsifier the spec proposed is still retired, but for the narrower and defensible reason: at the
rungs where `pop` is used, no cubic-bezier overshoot is narrow enough for a capture to miss, so the
test could not have failed and would have manufactured confidence. **If `pop` is ever put on
`--lc-dur-1`, this analysis no longer covers it** — recompute before assuming it does.

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
