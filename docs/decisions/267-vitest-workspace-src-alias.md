# 267 — Vitest resolves workspace imports to src, never dist

- Status: accepted
- Date: 2026-08-14
- Lane: `01M011MJJXJZPDNC25SA7NQ99X`
- Builds on: [ADR 106](106-ci-as-the-gate.md), [ADR 259](259-memory-git-truth-derived-indexes.md)

## Context

Every `@musterd/*` package publishes through `exports` pointing at `./dist` — correct for consumers,
and correct for CI, which builds before testing (`ci.yml` line 44 says exactly why). But `dist/` is
gitignored, so **switching refs never refreshes it**, and a local vitest run resolves workspace
imports to whatever build output is lying around. The suite then tests a tree that no longer exists.

That mechanism produced four incidents in two days:

1. stanley reported "main is RED on izzo's lane" from a clean _checkout_ with a stale
   `packages/protocol/dist` — a wrong accusation plus two held PRs (#825's hold).
2. izzo spent a reproduction cycle proving the same red from scratch.
3. dolly, accepting #833, hit `protocol/dist` missing `compareGoals` and lost a cycle to
   `pnpm -r build`.
4. The original CI-comment incident that motivated the `ci.yml` build-first note.

The wiki already carried the advice ("never blame a teammate's merged PR before reproducing on a
clean rebuild", running-the-gates.md) and two seats paid full price anyway — izzo's measure-4 report
names this the specimen of "the corpus was sufficient and the seat still paid." Advice that must be
recalled at the right moment loses to a resolver that cannot present the wrong tree in the first
place.

Alternatives considered:

- **A rebuild step in the test scripts** (`pretest: pnpm -r build`): pays a full build on every test
  run (measured seconds-to-minutes on the dogfood box, against a suite whose fast path is ~1s for a
  single file), and still leaves any direct `vitest run` invocation exposed — the trap moves, it
  does not close.
- **Committing dist/**: rejected by ADR 259's spirit — derived artifacts are not truth, and merge
  conflicts in build output are pure waste.
- **Doing nothing but wiki advice**: measured above; four incidents deep.

## Decision

Vitest resolves `@musterd/protocol` (including its subpath exports), `@musterd/server`,
`@musterd/mcp`, and `@musterd/telemetry` to their **TypeScript source** via a shared
`resolve.alias` list in `tests/setup/workspace-src-aliases.ts`, applied in the root config **and**
every per-package `vitest.config.ts` (a package-local run inherits nothing from the root — the same
lesson the isolation setup already recorded).

`@musterd/cli` is deliberately not aliased: nothing imports it by name; its acceptance tests spawn
the built binary from dist, and those genuinely test the artifact.

`tests/workspace-src-alias.test.ts` is the standing falsifier: for each aliased specifier it imports
the package by name and by source path and asserts module identity. If an alias is dropped or
broken, the name-import falls back through `exports` to dist — a different module — and the test
fails loudly rather than letting the suite silently test stale output again.

## Consequences

- A stale, missing, or wrong-branch `dist/` can no longer color a local test run in either
  direction. Verified at the limit: with `packages/protocol/dist` removed entirely, 202
  cross-package tests pass under the alias; the same run under a no-alias config cannot collect.
- Unit tests now exercise source; the built artifact is still verified by `pnpm build` +
  `typecheck` and by CI, which keeps its build-before-test order (unchanged, still load-bearing for
  the CLI-spawn tests).
- Coverage accounting may rise slightly (cross-package imports now load instrumented src). Floors
  only ratchet up (ADR 013), so this is safe.
- The failure mode this closes is the _misdiagnosis_, which cost more than the rebuild every time:
  each incident began as a false accusation against someone else's merged code.

## Observability & Evaluation

- **Traces**: `tests/workspace-src-alias.test.ts` runs in every suite invocation (root include
  covers `tests/**`), so a broken or dropped alias surfaces as a named red test in the same run
  that would otherwise have silently used dist. A fifth incident occurred _during this change's own
  gates_ (`pnpm typecheck` red on a dist predating #835's incident exports) — tsc still resolves
  through dist by design, so typecheck retains build-before-check, same as CI.
- **Eval**: the dataset is the incident ledger on running-the-gates.md (four stale-dist
  misdiagnoses in the two days before this ADR; the fifth above). Baseline: ~2/day while multiple
  seats shared one machine. Success: zero new _vitest_-side recurrences added to that page; any
  new recurrence must name a resolver other than vitest (tsc, node CLI spawn) or falsify the alias.
  Post-acceptance, dolly ran the strongest form: recurrence #1's incident tree rebuilt verbatim
  (`350752e8^` credentials.ts built into dist, src restored, so dist lacks `guardian_tiers`) passes
  44/44 under the alias — the fix kills the historical failure, not a synthetic one.
- **Experiment**: n/a — no behavior toggle worth A/B-ing; the negative control (no-alias config
  cannot collect with dist absent) is recorded in Consequences and reproducible in one command.
- **Known dist reader still inside vitest** (dolly's acceptance correction): "vitest no longer
  reads dist" is one test too strong — `packages/mcp/src/dist-imports.test.ts` reads dist _by
  design_ (published-tarball import graph, the 0.4.0 unloadable-release guard). A missing dist
  fails it honestly, but a **stale** dist passes it silently. That residue belongs to the
  dist-freshness gate (dolly's lane `01M0122XJ344T7WGQZJZWZG8KD`), alongside typecheck.
