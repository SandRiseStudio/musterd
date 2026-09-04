# 388 — The browser reads a room without the validator: the huddle fold joins `/wire`

- Status: proposed
- Date: 2026-09-04
- Builds on: [ADR 387](387-the-huddle-fold-is-protocol.md) (what a huddle IS belongs to the protocol), [ADR 378](378-a-huddle-is-a-thread.md) (a huddle is a thread; the room is a view over the log), [ADR 380](380-the-protocol-has-a-validator-free-face.md) (the protocol has a validator-free face), [ADR 151](151-web-perf-budgets-gate.md) (the JS budgets and what may raise them)
- Lane: 01M1NDGE39

## Context

ADR 387 moved the huddle fold into `packages/protocol/src/huddleView.ts` so that every surface reads
one answer to "what is in this room". Its two readers at the time — the CLI and the MCP server —
both run in Node, where importing from the package barrel costs nothing.

The web surface is the third reader, and it is the one where that import is not free.
`@musterd/protocol` builds its schemas at module scope, so a **single value** taken from the barrel
pulls zod and the whole `z.object(...)` graph into the bundle. ADR 380 measured that at ~20 KB
gzipped on `/live` and repaid it by moving the browser onto `@musterd/protocol/wire`, and #1307
re-baselined both JS budgets tighter on the strength of that repayment.

`deriveHuddles` is a value. Importing it the obvious way, from the barrel, immediately blew both
budgets at once (2026-09-04: total 252.9 KB against 231.4; initial 155.5 KB against 133.8) — the
repayment undone by one import, in a diff where nothing about it is visible.

## Decision

**`huddleView.js` is re-exported from `@musterd/protocol/wire`, and its one value import is re-homed
to `envelope.wire.js`.**

The fold qualifies for `/wire` on that module's own terms: it is plain TypeScript over shapes the
wire already defines, it validates nothing, and it constructs no schema. `eligibleOf` — its only
value dependency — is *defined* in `envelope.wire.ts` and merely re-exported by the schema module,
so the re-homing is a change of import path and nothing else. `Envelope` stays a type import from
the barrel, because types are erased.

The browser therefore reads a room the same way it reads every other contract: the derivation
without the validator. The daemon still parses every envelope with zod on ingest — the boundary that
decides what becomes durable is untouched.

## Consequences

- The lever that decides this cost is **reachability, not import style** (the trap already recorded
  in `docs/perf/web-live-baseline.md`): adding a value export to a `*.wire.ts` module that a zod
  module also imports is free; adding one that imports a zod module is not, and it appears in a diff
  as nothing at all.
- `/wire` widens again, and the same test as ADR 387's applies rather than "pure things go here":
  does this module construct or import a schema? If it does, it stays in the barrel.
- A fourth reader in the browser inherits the fold for free.
- The web increment that motivated this measured 228.6 → 230.7 KB total and 132.0 → 133.3 KB initial
  — inside both budgets, so no raise was taken. That matters beyond this PR: `totalJsGzipBytes` has
  been raised six times since 2026-08-24, and the standing steer is to find the repayment rather
  than the seventh raise.

## Observability & Evaluation

- **Traces:** none new. This changes an import path and a barrel re-export; it reads no field,
  writes nothing, and issues no query.
- **Eval:** `pnpm --filter @musterd/web build && pnpm perf:check` stays green, and
  `grep -l ZodError packages/web/dist/client/assets/*.js` prints nothing. Both are already gates.
- **Experiment:** n/a — a placement decision with a measured before and after, taken in one PR.
- **Falsifier:** a source guard in `packages/web/src/live/huddles.test.ts` fails if a browser module
  imports `deriveHuddles` from the barrel. It is deliberately a *unit* test rather than only the
  budget gate: the gate catches this only after a build, and only for as long as the budget has
  20 KB of headroom to lose. If that guard ever passes while a `ZodError` chunk exists on `/live`,
  the guard is wrong and the reachability trap has found a second path.
