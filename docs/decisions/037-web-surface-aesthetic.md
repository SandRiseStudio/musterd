# 037 — the web surface goes maximal; the product chrome stays minimal

- Status: accepted
- Date: 2026-06-23

## Context

`brand.md` is deliberately small: one accent (mustard `#E1AD01`) on zinc neutrals, two
typefaces (Inter + JetBrains Mono), plain declarative voice, and a §6 reversibility note that
forbids expanding the identity — "logos, mascots, multi-color systems, illustration" — without
an ADR and an explicit decision to invest. The wordmark rules (§1) also bar "gradients, drop
shadows, or 3-D treatments" on the mark itself.

We are now standing up the first piece of the web surface (a roadmap landing page, `packages/web`)
and want it to be immersive: a WebGL hero, mustard glows, depth, motion — a "spectacle." That
intent runs straight into §6. Per `brand.md`'s own rule ("do not silently deviate — record the
issue in an ADR, make the smallest correct change, update the affected doc in the same commit"),
this is the ADR.

## Problem

Two things are true at once and must not be conflated:

1. The **product chrome** — the CLI, terminal frames, the future dashboard's functional UI — earns
   trust by staying quiet, legible, and minimal. The single-accent discipline is load-bearing there.
2. A **landing/marketing surface** has a different job: it has seconds to convey that musterd is
   alive and crafted. Quiet minimalism under-sells it.

Treating these as one system forces a bad compromise. Treating them as two lets each do its job.

## Decision

Split the brand into two registers with one shared anchor.

- **Anchor (unchanged):** mustard `#E1AD01` stays the single accent and the warm through-line on
  every surface. Inter + JetBrains Mono remain the only typefaces. Voice stays plain and declarative
  — copy never says "magic"/"revolutionary"; the *experience* carries the spectacle, the *words* do
  not. The wordmark is still set in lowercase JetBrains Mono.
- **Web surface (expanded, opt-in):** the marketing/landing surface MAY use immersive WebGL
  (three.js), gradients, glows, depth, and motion, plus a deep-black ground darker than `zinc-950`.
  This expansion is scoped to `packages/web` and does not touch the CLI/terminal briefs or the
  dashboard's functional chrome.
- **Guardrails:** spectacle degrades gracefully — `prefers-reduced-motion` drops all WebGL/heavy
  motion to a static gradient with fully readable content; the page is prerendered to static HTML so
  text never depends on JS; the heavy 3-D bundle is code-split and loads only client-side after paint.
- **Liquid glass** (the SVG-displacement refraction technique) is used as a *single tasteful accent*
  over DOM content, not page-wide.

## Consequences

- `brand.md` gains a short "web surface" carve-out pointing here; the §6 reversibility note still
  governs the product chrome, which is unchanged.
- The expansion is still reversible: it lives entirely in `packages/web` tokens/components. Walking
  it back is deleting a package, not unpicking the identity.
- New risk to watch: drift between the two registers. The rule is that anything shared (color anchor,
  type, voice, wordmark) obeys `brand.md`; only the landing surface may go maximal. If the dashboard's
  functional UI later wants spectacle, that needs its own decision — this ADR does not grant it.
- Tooling: `packages/web` is type-checked by its own `tsc` and excluded from the Node-oriented ESLint
  config and the coverage floors (verified by build + typecheck instead).
