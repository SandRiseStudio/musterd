# 004 — ESLint deferred; strict tsc is the v0.1 static gate

- Status: accepted
- Date: 2026-06-09

## Context

`07-conventions.md` lists "lint clean (`pnpm -r lint`)" in the definition of done and names ESLint + Prettier.

## Problem

v0.1 was implemented without wiring an ESLint flat config. Shipping with the doc claiming an enforced lint gate that does not exist would violate the rule that docs and code never disagree.

## Decision

Defer the ESLint/Prettier setup. For v0.1 the enforced static-analysis gate is **TypeScript strict mode** (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`) run via `pnpm -r exec tsc --noEmit` (and every package's `build`). The root `lint` script is a no-op placeholder (`--if-present`) until ESLint is added.

## Consequences

- `07-conventions.md` updated: the DoD's lint line now points at strict `tsc --noEmit` as the v0.1 gate, with ESLint noted as roadmap.
- The hand-written conventions in `07-conventions.md` (import order, no-`any`-without-reason, named exports) are followed by convention, not yet machine-enforced. Adding ESLint to enforce them is a clean follow-up behind its own change.
- No behavior or API impact.
