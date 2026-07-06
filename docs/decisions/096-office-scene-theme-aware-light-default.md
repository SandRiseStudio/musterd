# 096 — The office scene reads its theme from the host; light becomes the default

- Status: accepted — built 2026-07-06 (`office-scene/render.ts` gains a `ScenePalette` read via `setScenePalette`; `office-scene/index.ts` resolves `--floor`/`--floor-2`/`--wood`/`--couch` off the canvas host each bake; `Live.css` pins the dusk palette on `.lc`; `tokens.css` + `__root.tsx` flip the default theme to light)
- Date: 2026-07-06

## Context

ADR 094 put the office scene on the marketing hero. `tokens.css` (ADR 036) already defined two full
office palettes — daylight and dusk — as semantic tokens, with dark kept active by design "until the
office scene + landing hero are light-mode-ready." The scene itself never read those tokens: `render.ts`
painted the floor, desks, and couch from hard-coded hex constants (`#e4a96b`, `#7a4e2d`, `#e3a72b`, …),
so flipping `tokens.css`'s default would have left the canvas frozen in dusk colours no matter what the
page around it did.

`/live` and `/office-preview` mount the same scene inside `.lc`, whose own chrome (the dusk gradient
backdrop, `--lc-*` tokens) is unrelated, page-scoped work — reskinning it to daylight is PR 4, not this
change.

## Problem

Make the office scene itself theme-aware so a light default is actually visible where the hero renders
it, without prematurely re-theming the `.lc` stage chrome that isn't ready yet.

## Decision

**The scene reads its palette from whatever theme cascades to its host; `.lc` pins dusk explicitly.**

- `render.ts` exports a `ScenePalette` (`floor`, `floor2`, `wood`, `couch`) plus `setScenePalette` /
  `DARK_PALETTE`. Every furniture draw that used the fixed hex constants now reads the palette (desk
  legs/slab, task chairs, bookshelf carcass, nook counter/couch, huddle table). `WOOD_TOP` becomes a
  `woodTop()` derived from `PAL.wood`, so the lighter surface tracks the base in one place. Colours that
  are furniture _identity_, not theme — book spines, monitor glow, skin tone, entrance glass/door,
  plant foliage — stay fixed; a green plant is still green in daylight.
- `office-scene/index.ts` adds `resolveScenePalette()`, reading `--floor`/`--floor-2`/`--wood`/`--couch`
  off `getComputedStyle(host)` and calling `setScenePalette` at the top of every `bake()` — so the same
  renderer paints daylight on a light page and dusk inside `.lc`, with no branch on _which_ page it's in.
- `Live.css`'s `.lc` root now sets those four custom properties explicitly to the dusk values, so the
  live stage's scene stays coherent with its dusk chrome regardless of the document's theme — a page-
  level override, not a scene-level one.
- `tokens.css` flips the active default: the header comment now states light is default, and
  `__root.tsx` sets `data-theme="light"` on `<html>` plus `color-scheme: light` / a matching
  `theme-color` meta. The bare `:root` block (dusk) remains reachable — by any element not under a
  `data-theme="light"` ancestor, which today is only `.lc`'s explicit override, not a toggle.

This keeps the same "semantic tokens, no raw hex in components" rule (ADR 036) but extends it to the
one surface — the canvas — that couldn't just inherit CSS: `getComputedStyle` reads what cascaded, so a
host inside `.lc` sees dusk and a host on the bare document sees light, automatically.

## Consequences

- The marketing hero now renders the intended daylight office; `/live` and `/office-preview` are
  visually unchanged (still dusk) until PR 4 re-themes that stage's own chrome.
- Any future third theme is a token swap plus nothing else in `render.ts` — the palette is resolved,
  not hard-coded, so no renderer change is needed to add a theme, only a token block.
- Verified 2026-07-06: typecheck clean, production build green (6 pages prerender), 66 office-scene
  unit tests pass unchanged, full `format:check` gate green. Visual QA via headless-Chrome screenshots
  at `/` (daylight floor `#f0c188`) and `/office-preview` (dusk floor `#e4a96b`, `.lc`-scoped) confirms
  the split.

## Observability & Evaluation

n/a — a visual/token change to a human-facing scene renderer and the page-default theme attribute. It
emits no coordination acts, joins no team, and adds no spans — there is no agent behavior to eval or
experiment on. Success is mechanical and was verified: typecheck, build, the existing 66-test
office-scene suite, and a targeted before/after screenshot comparison of the two theme contexts.
