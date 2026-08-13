# Per-package vitest configs

A package-local vitest run inherits NOTHING from the root config — each standalone package must re-declare whatever the root was giving it.

## The two ways this bit (fixed 2026-08-12 by #754; falsify: pnpm -r test)

telemetry had a `test` script and no config → fell back to the root config, whose include globs are root-relative (`packages/**/*.test.ts`), matched nothing from the package cwd, and reported "No test files found" for six real tests. cli had a config carrying only env vars → missing the ADR 190 machine-state isolation (`tests/setup/isolate-machine-state.ts`), so ~100 service tests died on the guard doing its job. The guard failing closed is correct — the missing piece is the isolation it demands.

## The rule

New package with tests ⇒ copy the 6-line config from packages/protocol; if the suite touches machine paths, mirror the root's `setupFiles` + `MUSTERD_CONFIG`/`MUSTERD_HOST_REGISTRY` pins.
