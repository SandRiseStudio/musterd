# 093 — The marketing hero is the office scene; three.js/WebGL is removed

- Status: accepted — built 2026-07-06 (`Hero.tsx` mounts `mountOffice()` with a 5-member fixture + 10s choreography loop; `scene.ts`/`effect.ts`/`anime-three.ts` + GLSL shaders deleted; `three`, `animejs`, `@types/three`, `vite-plugin-glsl` dropped from `packages/web`)
- Date: 2026-07-06

## Context

The `/` hero ran a bespoke three.js particle field: a WebGL `scene.ts` + post-processing
`effect.ts`, an `anime-three.ts` tween bridge, and hand-written GLSL vertex/fragment shaders, wired
through `vite-plugin-glsl` and a `glsl.d.ts` ambient module. It predated the isometric office
visualization (ADR 079/086), which now renders the product's actual metaphor — agents and humans as
co-workers on a shared floor — as a Rive-driven, act-to-choreography scene already shipped on
`/live`.

That left the homepage telling a different visual story than the product, and carrying a second
rendering stack (three.js + a GLSL toolchain) whose only consumer was the hero.

## Problem

The hero should show what musterd _is_, not an abstract particle field, without the homepage owning
a WebGL/shader pipeline that nothing else in `packages/web` uses.

## Decision

**Reuse the office scene as the hero backdrop; delete the three.js stack.**

- `Hero.tsx` mounts `mountOffice()` (the same renderer `/live` uses) with a 5-member fixture and a
  10s choreography loop, behind the wordmark. `Hero.css` carries a stronger vignette (0.65) so the
  headline and subhead stay legible over the bright office floor; `index.tsx` links `Live.css` in
  `head()` for the shared scene styles.
- Deleted: `scene.ts`, `effect.ts`, `anime-three.ts`, `shaders/particles.{vert,frag}.glsl`,
  `glsl.d.ts`, and the dead `live/constellation-scene.ts`.
- Dropped from `packages/web`: `three`, `@types/three`, `animejs`, and the `vite-plugin-glsl`
  plugin (removed from `vite.config.ts`).

This is a single-renderer decision: the office scene is the one visual system, shared between the
marketing hero and the live view, so a change to the choreography or rig shows up in both.

## Observability & Evaluation

n/a — a marketing-page re-skin. The hero swaps one human-facing renderer (three.js particles) for
another that already ships (`mountOffice`, ADR 079/086), and removes a build-time toolchain
(`vite-plugin-glsl`). It emits no coordination acts, joins no team, and adds no spans — there is no
agent behavior to eval or experiment on. Success is mechanical and was verified: typecheck clean,
production build green, all 6 pages prerender, and the previously-firing SSR hydration warning on `/`
is gone (baseline: 2 warnings/load → 0).

## Consequences

- One rendering stack in `packages/web` (Rive/canvas), not two. Smaller dependency surface and no
  GLSL build step.
- The hero and `/live` now share `mountOffice` + `Live.css`; a regression in one is visible in the
  other, which is the intended coupling (single source of visual truth) but means hero-only tweaks
  must be made scene-side deliberately.
- Verified 2026-07-06: typecheck clean, production build green, all 6 pages prerender including `/`.
  Fixed one latent SSR hydration mismatch surfaced by putting the Roadmap on the prerendered
  homepage — `WindingRoad` seeded `--x` from `Math.sin`, whose last ULP differs Node-vs-browser;
  now rounded to 4dp so both sides serialize identically.
