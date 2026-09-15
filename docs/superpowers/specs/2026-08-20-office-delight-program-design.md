# The office delight program — decomposing "magical, warm, delightful" into work that can be accepted

**Date:** 2026-08-20
**Seat:** miley
**Status:** design, approved in conversation with nick 2026-08-20

## 1. The problem

nick's ask: make the viewer experience of `/live` and `/broadcast` "extremely magical, intuitive,
helpful, fun, warm, beautiful, sleek, responsive, delightful."

That is a direction, not a task. Adjectives do not decompose — nobody can accept or reject "make it
warm," and a single lane pointed at all nine words would sprawl until it was abandoned or quietly
narrowed to whatever was easiest. This document splits the ambition into increments that each have
an owner, a falsifiable bar, and an end.

The organising principle is **what breaks when this is missing**, not which adjective it serves.

### 1.1 The trigger

The ask arrived attached to a specific observed defect: a speech bubble reading *"You were right, I
will take the handoff…"* with no indication of who "you" is. That defect is real and is increment
A1 below. It is also diagnostic — the office had the recipient available and dropped it, which is a
legibility failure, not a beauty failure.

## 2. The constraint that shapes everything

Measured on `miley/office-delight-program` @ `ec64ace6`, 2026-08-20, via `pnpm -r build && pnpm
perf:check`:

| budget | measured | ceiling | free |
| --- | --- | --- | --- |
| initial JS gzip (worst route `/live`) | 147.7 KB | 148.4 KB | **0.7 KB** |
| CSS gzip | 24.4 KB | 25.8 KB | **1.4 KB** |
| total JS gzip | 229.8 KB | 235.4 KB | 5.6 KB |
| largest chunk | 98.0 KB | 109.4 KB | 11.4 KB |

**The UI is 0.7 KB from failing its own CI gate on the exact route this program polishes.**

This is not new drift. `docs/perf/web-live-baseline.md` records that a 15% CSS headroom "lasted six
days at current office-CSS velocity," and `totalCssGzipBytes` has been raised twice since
(22000 → 25300 on 2026-08-04, 25300 → 26400 on 2026-08-12). Every visual increment so far has paid
for itself by raising a ceiling. At 0.7 KB of initial-JS headroom that road is out.

**Falsifier for this section:** re-run `pnpm -r build && pnpm perf:check` on main. If initial JS
free space exceeds ~5 KB, increment 0 is over-specified and can be reduced to a watch.

## 3. Increment 0 — buy the runway

**Blocks:** every increment below that adds bytes (B, C, D, E; A1 is small enough to fit).

Increment 0 does not produce polish. It produces a **decision between two routes**, backed by
measurement:

- **Route 1 — raise the ceilings deliberately, with a written story.** Honest if the bytes are
  genuinely earned. Costs nothing but candour, and ADR 183 already governs the ritual: a raise
  loosens, so it must be justified in the PR and logged in the baseline doc.
- **Route 2 — move office chrome off CSS.** `Live.css` is 15,190 of the 21,991 measured CSS bytes.
  The room is drawn on a canvas; some share of that CSS is drawing furniture and chrome the canvas
  could draw instead. If that share is large, the program gets real runway without loosening
  anything.

**The output of increment 0 is which route is true, not a plan.** The deliverable is a measurement
of how much of `Live.css` is canvas-substitutable, and a recommendation.

**Bar:** a number for the substitutable share, and a recommendation nick can accept or reject.
**Falsifier:** if under ~15% of `Live.css` is canvas-substitutable, Route 2 is dead and Route 1 is
the answer by elimination.

## 4. Increment A — the room stops misinforming

*Serves: intuitive, helpful. Foundational — no amount of beauty rescues a room that tells you
something false.*

### A1 — the recipient is visible on a directed act

`OfficeScene.tsx` builds the speech event as:

```js
h.emit({ kind: 'speech', who: e.from, text, tone: actTone(e.act), id: e.id, act: e.act });
```

`e.to` is dropped. The choreography layer (`mapping.ts`) *does* receive it — a handoff walks to the
recipient's desk — so the data is present and only the bubble is blind to it.

`Recipient` is a discriminated union of exactly `{ kind: 'member', name }`, `{ kind: 'team' }`,
`{ kind: 'broadcast' }` — no multi-recipient case exists at the envelope level.

**Design (approved by nick 2026-08-20):** a `→ ryder` chip on the bubble's leading edge, plus a soft
light-trace arcing from the bubble toward that member's desk and fading as the bubble settles. The
scene already holds head anchors (`heads: Map<string, Pt>`), so the tether's endpoint is free data.

- Team and broadcast acts show **no chip** — team is the default, and chipping every bubble is noise.
- The chip inherits the act's tone colour.
- The tether is suppressed under `prefers-reduced-motion` and under `stillMode()` (ADR 285
  measurement mode); the chip survives both, because it carries meaning rather than delight.
- A recipient who is not on the floor (offline, or capped out of the render) gets the chip and no
  tether — there is no desk to point at.

**Bar:** a directed act is never rendered without naming its recipient; the contrast gate stays
green on the chip; `perf:check` stays green.

### A2 — presence honesty

`docs/superpowers/specs/2026-08-19-presence-honesty-design.md` is written, committed (#904), and
unimplemented. Two measured symptoms it fixes: `idle` is unreachable for agents (so a seat has only
working-while-online and vanished), and offline members are deleted from the floor entirely, so a
10-seat team with two live sessions renders as a nearly empty room.

This increment is "implement that spec," not "design it again."

### A3 — the envelope stops reading as a log line

`[lane] resolved "Title"` is machine syntax over a person's head. `stripNoise` already unwraps a
known verb set into `resolved: Title`; the remaining question is whether a stranger knows what a
lane, a goal, or an act *is*. Overlaps increment B and may merge into it.

## 5. Increment B — the first five seconds

*Serves: intuitive, helpful.*

**There is no legend anywhere in the UI.** A stranger arriving mid-stream sees isometric figures
walking between desks with speech bubbles, and has no way to learn what a lane is, who the agents
are, whether they are real, or why any of it is happening.

This is the largest gap between what the office *is* and what a viewer *gets*. It is distinct from
increment A: A is per-element clarity, B is orientation. Scope to be designed in its own spec.

## 6. Increment C — feel

*Serves: responsive, sleek, delightful.*

Motion craft: easing, transition quality, micro-interactions, hover and click feedback.

Two hard constraints that most polish work ignores and that must be stated up front:

- **It must survive 25fps capture.** `/broadcast` runs at 720p25 with a capped draw rate; motion
  tuned on a 120Hz laptop can read as judder on the stream.
- **Reduced-motion parity is not optional** — 14 `prefers-reduced-motion` blocks already exist in
  `Live.css` and the scene threads a `reduced` flag.

The A1 tether is technically a C-class artifact shipping early inside A.

## 7. Increment D — beauty

*Serves: warm, beautiful.*

Material quality, light, colour, typography.

**Deliberately ranked low.** This is the most advanced area already — the night work (#935 two-layer
member glow, #936 desk lamps) landed here on 2026-08-19 and was accepted. Ranking it below A and B
is a claim that the office has a credibility problem before it has a beauty problem.

## 8. Increment E — life

*Serves: fun, magical.*

The ambient ladder. Increments 1 and 2 shipped (accept-confetti; day-cycle lighting). Remaining:

- **E1 — seeded idle life.** BLOCKED on a definition. Three readings were live in conversation and
  never resolved: a deterministic shared seed so every viewer sees the same office; denser ambient
  beats; life in an office with nobody in it. Needs nick's call before it is buildable.
- **E2 — work-tracking sound.**

**Note:** this ladder existed only in seat memory and lane titles until this document. That was a
defect — it is written down now.

## 9. Ordering and rationale

**0 → A → B → C / D / E.**

The instinct with "make it delightful" is to start at D and E, because they are the fun ones. That
is the wrong order here. The office currently drops recipients, cannot show `idle`, and deletes
offline people from the room. Delight built on a room that misinforms is decoration.

Increments C, D and E are genuinely parallel once 0 and A land.

## 10. The tension, stated out loud

"Extremely magical" and 0.7 KB of initial-JS headroom are in genuine tension. This program does not
resolve that quietly. Increment 0 exists so the resolution is a decision nick makes, rather than one
a seat makes by raising a number in a PR footnote.

## 11. Non-goals

- Rewriting the office renderer.
- Adding a UI framework, animation library, or asset pipeline (every byte lands on §2's budgets).
- Changing the wire protocol to carry presentation data — A1 uses `to`, which is already on every
  envelope.
- Designing increments B through E in this document. Each gets its own spec; this one decomposes.

## 12. Open questions

1. **E1's definition** — which of the three readings of "seeded idle life"? Blocks E1 only.
2. **Does A3 merge into B?** Both are "a stranger does not have the vocabulary." Decide when B is
   specced.
3. **Route 1 vs Route 2 in increment 0** — that is increment 0's whole output; listed here so it is
   not mistaken for settled. **Resolved 2026-08-24 (ADR 313, nick's call):** Route 2 rejected as
   runway — only 5.3% of `Live.css` is cheaply substitutable, and the rest costs JS bytes the JS
   budgets don't have. Runway comes from splitting `totalCssGzipBytes` into per-surface budgets;
   byte-adding increments now build against `appCssGzipBytes` (~3.2 KB measured headroom).
