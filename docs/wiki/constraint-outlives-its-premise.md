# A constraint outlives its premise

A rule written into a comment goes on being obeyed after the thing that made it true has moved, because nothing re-checks a premise — and the same blindness runs the other way, where a gate that guards one kind of token says nothing about the kind beside it.

## The shape

A constraint is written for a reason. The reason is a fact about the code at that moment. Later the code moves, the fact stops holding, and the constraint stays — correctly formatted, confidently worded, and wrong. Nobody re-derives it, because re-deriving a rule you were told is exactly what a rule is for.

Two instances on this repo, both 2026-08-28, both found only because someone happened to be changing the thing the rule protected.

## `--wall` was pinned to a premise that had been deleted

`packages/web/src/styles/tokens.css` carried, from #522: *"`--wall` is deliberately NOT touched — the paper chrome's contrast was tuned against this exact cream, and moving the backdrop would silently undo that."*

True when written. The office's speech bubble and nameplate were **translucent** then, so the wall behind them really did decide their ink contrast — the bubble measured 12.60 on its own stock and 1.38 over a dark actor, which is why the transparency was later removed (the long note on `.lc-speech__inner` in `packages/web/src/live/Live.css` records that change and its reasoning).

Opaque chrome cannot have its contrast reached by the backdrop. **The constraint died the day the opacity change landed and stayed written down for weeks afterward (2026-08-28; falsify: set `--wall` to any colour and run `pnpm a11y:check` — if the constraint still held, the office routes would drop below AA; they measured 14 routes, 0 below AA at both `light=12` and `light=21`).**

The opacity change had every reason to be correct and no reason to go looking for a comment in a different file that its own premise invalidated. That is the whole failure: the constraint and the mechanism it depended on lived apart, and only the constraint was written down.

## `tokens:check` guards colour tokens and says nothing about lengths

`scripts/check-css-tokens.ts` exists to catch two silent lies about colour: a token used with a `var()` fallback but defined nowhere, and a fallback that disagrees with the definition. It is a real gate and it works.

It does not cover length tokens. **`tokens:check` fails on an undefined COLOUR token used with a fallback and passes on an undefined LENGTH token in the identical shape (2026-08-28; falsify: add `color: var(--nope, #ff0000)` to any rule in `Live.css` and run `pnpm tokens:check` — it fails; replace it with `font-size: var(--nope, 13px)` and run again — it passes. Measured both ways, in that order, so the control is known to fail.)**

Note the exact shape the gate targets: the **fallback** form. Neither a bare `color: var(--nope)` nor a bare `font-size: var(--nope)` is caught, because a bare `var()` of an undefined token makes the declaration invalid at computed-value time and the gate is looking for the quieter lie where a fallback silently becomes the value.

The runtime half is worse than a wrong value, because CSS drops an unresolved declaration rather than failing: the element silently inherits, the page renders, and every gate stays green. A length token can therefore be wrong in two ways the tooling never mentions — undefined-with-a-fallback, which the gate skips, and defined-but-out-of-scope, which is not a token lie at all and so is nobody's gate. Caught in #1104 when six new `--lc-type-*` tokens were placed next to the paper set on `.lc-ov, .lc-gl-labels` — the obvious home, and wrong, because `.lc-office__work .lc-workstack` and `.lc-captions` are inside neither. Three of the six resolved to nothing on the two surfaces that most needed them. Fixed by defining them on `.lc`, verified by injecting probe elements under `.lc-office` and reading their computed sizes rather than by re-reading the CSS.

## What to do about it

- **When you change a mechanism, grep for the rules that named it.** The `--wall` note would have been found by searching for `paper` or `contrast` from the opacity change. It costs one search and it is the only step that closes this class.
- **When a written constraint blocks you, check whether its premise still holds before obeying OR overruling it.** Both are failures if the premise is gone: obeying preserves a dead rule, overruling without checking is luck.
- **Retire a constraint in writing, where it lived.** #1101 replaced the `--wall` note with a record of why it no longer binds. A deleted comment teaches nobody; a comment that says "this used to be true, and here is what changed" stops the next reader re-deriving it from scratch.
- **A green gate bounds what it checks, not what is true.** The same reading applies here as in [instrument silence is not evidence](instrument-silence.md) and [DEFECT_RE coverage](defect-gate-coverage.md): ask what the gate actually asserts before treating its silence as a pass.

## Related

- [Correct by coincidence](correct-by-coincidence.md) — the value-level cousin: a stand-in that stays right only while it happens to agree with the truth.
- [The office scene](office-scene.md) — where both instances landed.
- [Web performance](web-performance.md) — the other place `packages/web` records constraints that are easy to invalidate from a distance.
