# 372 — Whiteboard `tslib` runtime dependency

- Status: proposed
- Date: 2026-09-03
- Lane: `01M1MMA3NX1PGQDJPXKVRVYRR1`

## Context

`agent-whiteboard` builds its browser surface with Vite. Its `tldraw` dependency brings in
`react-remove-scroll`, whose ESM production module imports `tslib`. The package already resolves
`tslib@2.8.1` in the workspace lockfile, but whiteboard listed it only in `devDependencies`.

On 2026-09-03, `pnpm --filter agent-whiteboard build` consistently failed in Rolldown while
resolving `react-remove-scroll/dist/es2015/Combination.js`: `Failed to resolve import "tslib"`.
The TypeScript phase succeeds; the failure is production-bundler resolution, which does not use
whiteboard's development-only dependency declaration as a runtime boundary.

## Problem

The whiteboard package cannot produce its published browser bundle from a lockfile-valid install.
Adding a Vite external would defer the unresolved module to the browser, and relying on a
transitive installation is not a package contract.

## Decision

Move the existing `tslib: ^2.8.1` declaration from `devDependencies` to `dependencies` in
`packages/whiteboard/package.json`. No new version is resolved and no source behavior changes.

This records a direct runtime dependency because whiteboard's shipped browser bundle resolves a
runtime import through it. The considered alternative, marking `tslib` external in Vite, would
produce an artifact that still requires an undeclared browser-side module and is rejected.

## Consequences

- `pnpm --filter agent-whiteboard build` resolves the runtime helper and produces `dist-web`.
- The root recursive build can proceed past the whiteboard package; its existing chunk-size warning
  remains a warning, not part of this decision.
- The regression check is the production build itself: removing `tslib` from `dependencies` must
  reproduce the Rolldown resolution failure; a successful build falsifies the original failure.

## Observability & Evaluation

**Traces.** n/a — this changes package resolution only and emits no runtime telemetry.

**Eval.** Dataset: the lockfile-valid whiteboard production build. Baseline: on 2026-09-03,
`pnpm --filter agent-whiteboard build` failed resolving `tslib` from
`react-remove-scroll/dist/es2015/Combination.js`. Success: the same command exits zero and writes
the browser bundle. Falsifier: a clean lockfile install still fails that resolution after this
declaration is present.

**Experiment.** n/a — deterministic package metadata correction, not a behavioral experiment.
