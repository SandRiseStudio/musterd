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

It also produces a hard floor: **below three frames (120ms) a transition has too few samples to read
as motion at all** — it is a snap that merely costs a repaint.

**Corrected 2026-08-26.** This section listed `45ms`, `50ms` and `90ms` as three such durations and
called them defects. They are not durations: all three are `transition-delay` / `animation-delay`
values (`Live.css:1509`, `4855`). A delay shifts *when* motion starts, so the whole-frame rule does
not apply to it, and the claim survived into ADR 329, the PR body and a commit message before
ryder's acceptance review caught it. The floor is a property of the capture rate and needs no
example from the tree to be true.

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

`--lc-ease-quart` collapses into these, and `/live`'s uses of the two global easings in `tokens.css`
re-point at them — ending the three-namespace split **for this surface**.

The global `--ease-out` / `--ease-in-out` stay declared: `components/GetStarted.css` and
`components/Footer.css` use them, and those are the public site, outside this lane's scope
(`live/**`, `Live.css`, `Broadcast.css`). Deleting a token the site depends on from inside a `/live`
lane would be a change nobody reviewing this lane is looking at. The residue is one namespace on one
surface this lane does not own — worth its own lane if the site ever wants the scale.

**This spec originally claimed overshoot was the riskiest family at 25fps** — that an overshoot's
peak could fall between two captured frames and not exist on the stream. **Measured 2026-08-25, that
is false**, and the measurement is in `docs/perf/motion-capture.md`: the overshoot survives capture
at every rung `pop` is used on (d2–d5; 83.2–98.1% at worst-case phase, and d1 — where it drops to
56.6% — is never used with `pop`). A cubic-bezier's overshoot is a broad smooth
maximum, not a spike, and with one control-point pair it cannot oscillate — the narrow-peak failure
belongs to stiff spring physics, which this codebase does not use.

`--lc-ease-pop` therefore keeps `cubic-bezier(0.34, 1.56, 0.64, 1)` and needs no tuning. What is
genuinely at risk at 25fps is short *durations*, not easing shape — which is what the scale's
three-frame floor already answers.

## 4. Source of truth: mirror and gate

`packages/web/src/live/office-scene/motion.ts` becomes the single source:

```ts
export const DUR = { d1: 120, d2: 200, d3: 280, d4: 400, d5: 600 } as const;
export const EASE = { out: [0.16, 1, 0.3, 1], inOut: [0.4, 0, 0.2, 1], pop: [...] } as const;
```

It exports durations as numbers (the canvas needs ms, not CSS strings), the easing roles as control
points for the CSS mirror, and the canvas's quadratic approximations of the same three roles. It
deliberately does **not** sample the beziers: a solver in the initial bundle would cost the bytes
Delight 0 bought, for a difference no viewer can name. **The engines share durations, not curve
math.** `actors.ts`'s three quadratics and the inline expression in `render.ts` re-point at it.

`Live.css` **mirrors** the same values as custom properties. The two are kept honest by a check
rather than by a build step or a runtime read — this is how every other invariant in this repo is
held (`vocab:check`, `tokens:check`, the guidance snapshot, `roadmap-truth:check`), and it costs
zero bytes, which matters under Delight 0's remaining initial-JS headroom.

`scripts/check-css-tokens.ts` grows a motion arm. It already exempts non-colour values by design
(its header names `--lc-mote-delay` as exactly that case), so this extends its existing contract
rather than adding a gate. It fails on three things:

1. A motion token in CSS whose value disagrees with `motion.ts`.
2. A raw `cubic-bezier()` or bare duration literal in a transition/animation outside the exemption
   list.
3. A duration that is not a whole number of frames at 25fps.

**Corrected 2026-08-26 (second pass).** Rules 2 and 3 both said `ms` and both meant it — each parsed
milliseconds only, and a duration written in seconds was invisible to the gate. Rule 2's blindness
let three live violations onto main (ryder's REQUIRED 1 on #1079). Rule 3's outlived that fix by one
review: it still parsed `/^(\d+)ms$/`, so a **new rung** declared as `--lc-dur-6: 0.18s` was counted
by nothing — rule 2 does not scan `:root` declarations, and rule 1 only knows tokens already in
`motion.ts` (ryder's REQUIRED 1 on #1082). 4.5 frames, rule 3's own defect class, on the scale
itself. Both rules read either unit now. **The unit a duration is spelled in was never the point;
the number of frames it occupies is** — and any future rule that parses a duration must go through
`durationMs`, not its own regex, which is the mistake that got made twice.

**Corrected again, same review.** Widening the parse fixed the listed forms and left the shape
intact: rule 3 still *skipped* whatever it could not read, so the parser's blind spots stayed the
gate's blind spots. `0.18S`, `180MS`, `+0.18s` and `1.8e-1s` all left the gate green, and all four
are 4.5 frames — the same sentence, one round later (ryder's second REQUIRED on #1082).

**So rule 3 now fails closed: a `--lc-dur-*` value it cannot read is a finding, not a skip.** The
case-insensitivity fix is real, because CSS units are case-insensitive. The rest are reported rather
than parsed, and that is the point — a third widening would have been beaten by a form nobody
listed, whereas "count the frames or say you could not" has no unlisted forms. A gate must never be
silent in a way a reader will mistake for having checked and been satisfied.

**Corrected a third time, third review round.** The paragraph above told rule 3's story and left
rule 2 holding the same defect, in the same file, next to the sentence saying the class was closed:
rule 2 kept its own literal pattern, case-sensitive and innocent of signs and exponents, so
`0.18S`, `180MS` and `1.8e-1s` rode a green gate as real declarations while `180ms` failed (ryder's
REQUIRED on #1082, round 3 — and `180MS` was one form wider than the report, found by exercising all
of them). Two more private grammars were hiding in the same rule: the zero-duration test and the §5
allowlist, both matching characters rather than values, so `0S` and `1S` meant nothing to either.

**Rule 2 now has no duration grammar at all.** It splits a declaration into words, asks of each only
"does this look like a duration" — has a digit, ends in an s unit — and hands every one that does to
`durationMs`: counted if it reads, reported as UNREADABLE if it does not, on rule 3's shape. Zero
and the allowlist compare milliseconds, not spelling. **The invariant, which names no forms:** for
any value a motion declaration can hold, the gate either counts its frames or says it could not —
never neither. That sentence is now true of both rules, and `durationMs` is the only thing in the
file that decides what a duration is.

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

Each entry is keyed on value **and** file **and** CSS property **and** the token naming the site
within it (an animation name, or the animated property) — not value and file. The reasons name a
specific declaration ("the expiry bar is a countdown"), so the check enforces that declaration:
exempting `1s` for the countdown must not also exempt `1s` in any hover transition in the same file
(ryder's non-blocking (a) on #1082, round one), and matching the site as a bare substring must not
let `max-width` inherit `width`'s exemption (round two).

**What the exemption is NOT keyed on: the selector.** An entry names a declaration, not a rule, so
moving `transition: width 1s linear` to a different selector in the same file keeps it exempt. That
is the honest description of the match, and it is written here because the earlier draft of this
paragraph claimed the exemption "binds to the declaration that earned it" while the code bound it to
file plus a substring — and the sentence in the doc is the thing that gets cited, not the regex.

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

**The overshoot half of this was run analytically on 2026-08-25** — see
`docs/perf/motion-capture.md`. At the rungs `pop` is used on (d2–d5) it could not have failed, so it
is retired rather than performed; the frame-count half stands and is now enforced continuously by the
gate's rule 3 rather than by a one-off capture. (Amended 2026-08-26: the original wording here,
"cannot fail" for *any* cubic-bezier, overclaimed — d1 is outside the covered range.)

**A note on when a capture is even meaningful.** The hosted capture renders
`http://${AIR_IP}:4849` — the daemon's build of `main`. A branch's motion is not on the stream until
it lands, so a pre-merge capture measures the *previous* scale and says nothing about the change
under review. Visual confirmation belongs after merge.

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
