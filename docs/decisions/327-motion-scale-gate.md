# 327 — Motion has one vocabulary, pinned to capture frames and held by a gate

- Status: accepted
- Date: 2026-08-25
- Lane: `01M0GVP9KV4J4S4P21EGGDQH0M` (Delight C)
- Relates to: [ADR 151](151-web-perf-budgets-gate.md), [ADR 285](285-deterministic-measurement-mode.md),
  [ADR 313](313-css-budget-splits-by-surface.md)

## Context

`/live` and `/broadcast` had no shared motion vocabulary. Three namespaces were live simultaneously:
global `--ease-out` / `--ease-in-out` in `tokens.css`, local `--lc-ease` / `--lc-ease-quart` /
`--lc-fast` / `--lc-med` in `Live.css`, and eight distinct `cubic-bezier()` literals written inline
that bypassed both. Measured at 4f3d916e: **25 distinct `ms` durations** in the two stylesheets, in
clusters that were accidental rather than intentional — `120/140/160` (13 uses),
`180/200/220/240/260/280` (24), `300…480` (13), `520…700` (6). Nothing distinguished a 220ms
transition from a 240ms one except which day it was written.

The canvas scene was a fourth vocabulary that could not reach any of the others: `actors.ts`
hand-rolled `easeIn` / `easeOut` / `easeInOut` as quadratics and `render.ts` inlined a bare
`1 - Math.pow(1 - t, 2)`.

The Delight C lane brief asked for "motion craft: easing, transition quality, micro-interactions."
Adding micro-interactions on top of this would have added a ninth and tenth bezier. The vocabulary
had to come first.

## What gives the numbers their authority

`/broadcast` captures at 720p25, so **one frame is 40ms**. A duration that is not a whole multiple
lands mid-frame and its final rendered step is a partial one — the judder the lane brief warns about.
This converts "pick nice durations" from taste into arithmetic, and it produces a hard floor:
`45ms`, `50ms` and `90ms` were below three frames and could not render as motion on the stream at
all. Those three were defects, not inconsistencies.

## Decision

**Five rungs, each a whole number of frames at 25fps** — `--lc-dur-1` 120ms (3), `--lc-dur-2` 200ms
(5), `--lc-dur-3` 280ms (7), `--lc-dur-4` 400ms (10), `--lc-dur-5` 600ms (15) — and **three easing
roles**: `--lc-ease-out`, `--lc-ease-in-out`, `--lc-ease-pop`.

**`office-scene/motion.ts` is the single source of truth; `Live.css` mirrors it; `pnpm tokens:check`
fails on drift.** A mirror rather than codegen or a runtime read: both of those cost initial-JS bytes
that ADR 313 bought, and every other invariant in this repo is already held by a gate.

**The engines share durations, not curve math.** The canvas keeps its quadratics. Sampling a bezier
per frame would ship a solver into the initial bundle for a difference no viewer can name; the
durations are what read as consistency.

**Ambient loops are exempt by rule, not by list.** An `infinite` animation is ambient life (clock
sheen, breathing, drift), not interaction feedback, and is not on the same scale as a hover. A rule
the gate checks beats a list someone must remember to update.

**`Broadcast.css` gets no `prefers-reduced-motion` blocks.** It is a capture surface; the harness,
not a person, decides what it renders, and there is no viewer there to hold a preference. Recorded so
the next reader does not file it as a gap.

**The collapse is scoped to `/live`.** The global `--ease-out` / `--ease-in-out` stay declared because
`components/GetStarted.css` and `components/Footer.css` use them — public site, outside this lane.
Deleting a token the site depends on from inside a `/live` lane would change files nobody reviewing
the lane is looking at.

## Consequences

- A new duration or easing now costs a gate conversation. That is the intent: an exception should
  cost a sentence.
- Nine transitions changed slightly where two near-identical strong ease-outs merged, and where
  `--lc-fast` (140ms) and `--lc-med` (220ms) snapped to 120ms and 200ms. This was the agreed cost of
  collapsing near-duplicates rather than preserving accidental differences.
- The gate governs the `--lc-dur-*` / `--lc-ease*` namespace. A duration hidden under another name is
  invisible to rules 1, 3 and 4 — deliberately, rather than closing it with a value-sniffing
  heuristic, because rule 2 catches the *uses* regardless of what the token is called.
- Two defects surfaced during the migration and became permanent rules. Rule 5 (phantom refs) exists
  because deleting `--lc-fast` left four references in `ApprovalCard.css` pointing at nothing, and a
  transition whose duration does not resolve silently stops animating with nothing to say so. Rule 4
  found that the same file animated three things and answered for none of them under
  `prefers-reduced-motion`.

## Observability & Evaluation

- **Traces:** `pnpm tokens:check` (already in the `format:check` chain, so it runs in CI) prints one
  summary line per run and names every violation with its file, line, rule and remedy. Five rules:
  disagreement with `motion.ts`, raw literals in transitions, off-frame durations, a rung with no
  reduced-motion answer, and a motion `var()` declared nowhere. `docs/perf/motion-capture.md` holds
  the frame counts and the overshoot analysis.
- **Eval:** dataset is the stylesheets themselves at 4f3d916e — 25 distinct `ms` durations, 8
  distinct beziers, 3 namespaces, 72 literals inside transitions. Baseline: the gate found exactly
  those 72 on its first run, and the migration took them to 0. The standing falsifier is that a
  hand-edit reintroducing a bare `240ms` or an inline `cubic-bezier()` into a transition must fail
  CI; verified by injecting both and watching the gate name them.
- **Experiment:** n/a — the overshoot question was settled analytically rather than A/B-tested (see
  the falsified claim below), and the failure paths were exercised directly by reintroducing each
  defect and confirming the gate caught it.

**One claim in the design spec was falsified by measuring it.** The spec asserted overshoot was the
riskiest easing family at 25fps, on the reasoning that its peak could fall between captured frames
and vanish. Sampled at 40ms across every rung, 97–100% of the overshoot survives for all three
candidate curves: a cubic-bezier's overshoot is a broad maximum, not a spike, and one control-point
pair cannot oscillate. `--lc-ease-pop` needed no tuning, and the capture falsifier the spec proposed
was retired — no cubic-bezier can fail it, so it was not a gate. The constraint that earned its place
was the opposite one: short durations, not curve shape.
