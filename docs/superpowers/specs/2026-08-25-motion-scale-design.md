# Delight C — the motion scale

**Date:** 2026-08-25
**Lane:** 01M0GVP9KV4J4S4P21EGGDQH0M
**Goal:** office-delight
**Parent:** `2026-08-20-office-delight-program-design.md` §6 (Increment C — feel)
**Status:** draft

## 1. The problem

The parent program scopes C as "motion craft: easing, transition quality, micro-interactions, hover
and click feedback." Before adding any of that, the existing motion has no shared vocabulary. Three
namespaces are live at once:

- **Global tokens** — `--ease-out`, `--ease-in-out` in `packages/web/src/styles/tokens.css`.
- **Local tokens** — `--lc-ease`, `--lc-ease-quart`, `--lc-fast` (140ms), `--lc-med` (220ms),
  declared inside `Live.css` itself.
- **Raw literals** — 8 distinct `cubic-bezier()` values written inline, bypassing both.

Measured on `Live.css` + `Broadcast.css` at 4f3d916e: **25 distinct `ms` durations** and 18 distinct
second-scale values. The clusters are accidental rather than intentional — `120/140/160` (13 uses),
`180/200/220/240/260/280` (24 uses), `300…480` (13 uses), `520…700` (6 uses). Nothing distinguishes
a 220ms transition from a 240ms one except which day it was written. (Cluster counts: 13, 24, 13, 6.)

The canvas scene is a fourth vocabulary that cannot reach any of the above: `office-scene/actors.ts`
hand-rolls `easeIn` / `easeOut` / `easeInOut` as quadratics, and `render.ts:4198` inlines a bare
`1 - Math.pow(1 - t, 2)`.

**This is the cause of inconsistent feel.** Adding micro-interactions on top of it would add a 9th
and 10th bezier. The scale comes first; spending it is a follow-up lane.

## 2. The constraint that gives the scale its numbers

`/broadcast` runs at 720p25 with a capped draw rate. **One frame is 40ms.**

A duration that is not a whole multiple of 40ms lands mid-frame on the stream: the final rendered
step is a partial one, which is the judder the lane brief warns about. This converts "pick nice
durations" from taste into arithmetic.

It also produces a hard floor. Three durations in the codebase are **below three frames** and cannot
render as motion at all on the stream — they are snaps that merely cost a repaint:

| Value | Frames @25fps |
|---|---|
| `45ms` | 1.1 |
| `50ms` | 1.25 |
| `90ms` | 2.25 |

These are the only values in the two stylesheets this spec calls outright defects rather than
inconsistencies.

## 3. The scale

Five rungs. Every rung is a whole number of frames at 25fps.

| Token | Value | Frames | Role |
|---|---|---|---|
| `--lc-dur-1` | 120ms | 3 | hover, press, focus feedback |
| `--lc-dur-2` | 200ms | 5 | the default transition |
| `--lc-dur-3` | 280ms | 7 | enter/exit of small elements |
| `--lc-dur-4` | 400ms | 10 | panels, layout shifts |
| `--lc-dur-5` | 600ms | 15 | sweeps, traces, one-shot flourishes |

Three easing roles replace the eight literals:

| Token | Value | Absorbs |
|---|---|---|
| `--lc-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | `(0.22, 1, 0.36, 1)` — 9 uses across two near-identical strong ease-outs |
| `--lc-ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | the `(0.4, 0, 0.2, 1)` literal **and** the global `--ease-in-out`, which is a *different* curve — `(0.65, 0, 0.35, 1)` |
| `--lc-ease-pop` | one tuned overshoot | `(0.34,1.56,0.64,1)`, `(0.34,1.4,0.5,1)`, `(0.2,0.9,0.3,1.4)`, `(0.2,0.9,0.25,1.08)` |

`--lc-ease-quart` and the two global easings in `tokens.css` collapse into these, ending the
three-namespace split.

**Overshoot is the riskiest family at 25fps** and deserves its own note: the peak of an overshoot can
fall between two captured frames and simply not exist on the stream. One overshoot whose peak is
tuned to land on a frame is more likely to survive capture than four untuned ones. Picking that
control point is an implementation task with a falsifier (§7), not a value this spec asserts.

## 4. Source of truth: mirror and gate

`packages/web/src/live/office-scene/motion.ts` becomes the single source:

```ts
export const DUR = { d1: 120, d2: 200, d3: 280, d4: 400, d5: 600 } as const;
export const EASE = { out: [0.16, 1, 0.3, 1], inOut: [0.4, 0, 0.2, 1], pop: [...] } as const;
```

It exports numbers (the canvas needs ms, not CSS strings) plus sampling functions. `actors.ts`'s
three quadratics and the inline expression in `render.ts` re-point at it.

`Live.css` **mirrors** the same values as custom properties. The two are kept honest by a check
rather than by a build step or a runtime read — this is how every other invariant in this repo is
held (`vocab:check`, `tokens:check`, the guidance snapshot, `roadmap-truth:check`), and it costs
zero bytes, which matters under Delight 0's remaining initial-JS headroom.

`scripts/check-css-tokens.ts` grows a motion arm. It already exempts non-colour values by design
(its header names `--lc-mote-delay` as exactly that case), so this extends its existing contract
rather than adding a gate. It fails on three things:

1. A motion token in CSS whose value disagrees with `motion.ts`.
2. A raw `cubic-bezier()` or bare `ms` literal in a transition/animation outside the exemption list.
3. A duration that is not a whole number of frames at 25fps.

## 5. Exemptions, and why they are a rule rather than a list

Two classes are exempt from the rung scale. Neither is exempt from §6.

**Ambient loops.** 13 animations in `Live.css` are `infinite` — 0.5s to 8s. These are ambient life
(clock sheen, breathing, drift), not interaction feedback. They are not on the same scale as a hover
transition and forcing them onto rungs would be a category error. **Rule: an `infinite` animation is
exempt.** This is checkable, so the gate enforces the rule rather than trusting a list.

**Deliberate one-shot outliers.** Six non-infinite second-scale durations remain: `0.42s`, `0.5s`,
`1.4s`, `1.5s`, `2.8s`, `3.6s`. These get a short, named allowlist in the gate, each entry carrying a
one-line reason. An allowlist that must be edited by hand is the point: it makes an exception cost a
sentence.

Two of these (`0.42s`, `0.5s`) are close enough to rungs that the implementation should test whether
they are deliberate at all, or simply the same accidental drift as the `ms` clusters. If they are
drift, they snap and leave the allowlist.

## 6. Parity — the part most likely to go wrong

Three suppression paths already exist and they are **not** the same mechanism:

| Path | Where | Count |
|---|---|---|
| `prefers-reduced-motion` | `Live.css` | 17 blocks |
| `prefers-reduced-motion` | `Broadcast.css` | **0 blocks** |
| `stillMode()` (ADR 285) | scene, overlay, asks-strip, clock | 4 call sites |
| `reduced` flag | threaded through the scene | — |

Collapsing durations onto tokens touches all of these, so the gate must also assert that a rung used
in a transition has a reduced-motion answer.

**`Broadcast.css`'s zero blocks stay as-is, documented.** `/broadcast` is a capture surface with no
human viewer to hold a preference; the capture harness, not a person, decides what it renders.
Adding 17 blocks there under cover of this lane would be scope creep into a surface that cannot want
them. This is a deliberate asymmetry, recorded here so the next reader does not file it as a gap.

`stillMode()` determinism is non-negotiable: the contrast gate depends on it. Any motion this lane
touches must still resolve to a fixed, frame-independent state under still mode, or the a11y gate
goes nondeterministic — a failure this repo has already paid for twice (lanes 01KZZ7RYW6, 01M08WR97S).

## 7. Verification

Unit tests for `motion.ts` and for each of the gate's three rules.

The lane brief says *checked on the actual stream, not just locally*, so the falsifier is a capture,
not an assertion:

> Capture `/broadcast` at 720p25 and step frame-by-frame through (a) one hover, (b) one panel open,
> and (c) one accept-confetti. Each must occupy the expected whole number of frames, and the
> `--lc-ease-pop` overshoot must have a visible peak in at least one captured frame.

If the overshoot peak is absent from every frame, `--lc-ease-pop`'s control point is wrong and §3's
tuning task is not done.

**Dependency:** the hosted stream was stopped on 2026-08-25. This falsifier needs it up, or a local
720p25 capture run standing in for it.

## 8. Non-goals

- **New micro-interactions.** Hover/click feedback that does not exist yet is a follow-up lane that
  spends this scale. Landing both at once would mean tuning new motion against a vocabulary being
  rewritten underneath it.
- **Increment D (beauty) and E2 (sound).** Separate lanes, separate specs.
- **Retuning accepted motion.** The night work, receptionist welcome and accept-confetti keep their
  feel except where a near-duplicate collapse moves them (§3), which is the agreed cost.
- **`Broadcast.css` reduced-motion blocks** (§6).

## 9. Open questions

1. **Does the gate arm want an ADR?** `change-adr:check` does not require one — it gates protocol
   schemas and new runtime dependencies, and C touches neither. But every other CI gate here carries
   one (ADR 151 perf budgets, ADR 285 measurement mode), and a gate outlives the lane that added it.
   Recommendation: yes, written at implementation time.
2. **`--lc-ease-pop`'s control point** — chosen against the §7 capture, not asserted here.
