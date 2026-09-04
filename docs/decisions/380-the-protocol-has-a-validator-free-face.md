# 380 — The protocol has a validator-free face

- Status: accepted
- Date: 2026-09-04
- Relates to: [ADR 148](148-feature-epoch-roster-skew.md) (forward tolerance — the
  posture the read guards implement), [ADR 151](151-web-perf-budgets-gate.md) (the budgets this
  repays), [ADR 183](183-two-js-budgets.md) (two JS budgets; a re-baseline
  may only tighten), [ADR 232](232-ledger-seats-every-actor-on-the-roster.md) (`kind: 'service'` — the roster row from the
  daemon's future that made per-row tolerance real)
- Decided by: nick, 2026-09-04 (steer via ryder on lane 01M1N9V7YN: "find and land the repayment, or
  write the decision that says why the ceiling moves, rather than raising it a seventh time"; then
  "zod lane"); recorded by miley

## Context

`@musterd/protocol` is a schema package: every module imports zod and builds its enums and objects
at module scope. That is right for the daemon, the CLI and the MCP server, which **enforce** the
contract. The browser does not enforce it — it reads it, over its own origin, from a daemon that
validates everything on ingest — and it pays for the schemas by the byte.

Six raises of `totalJsGzipBytes` since 2026-08-24 (241,000 → 258,000) with no tightening between
them. The 2026-09-03 entry in `docs/perf/web-live-baseline.md` measured and rejected the only
remaining lever it could name (un-splitting via `manualChunks`) and recorded the finding: the budget
had become an instrument measuring product growth rather than catching waste.

One lever had been half-pulled. On 2026-09-02 `packages/web/src/live/format.ts` stopped
value-importing three helpers from the barrel and deep-imported them from `@musterd/protocol/model`
and `/posture`, which moved zod off `/live`'s **eager** graph — 13 KB of first paint. It did not
remove zod from the product: both of those modules import their vocabularies from `acts.ts`, which
builds `z.enum`s at module scope, so a 13.5 KB chunk was still fetched with the roster and the
protocol barrel chunk still carried its whole `z.object(...)` graph.

**The lever is reachability, not import style.** A deep import only helps when the module it reaches
is itself validator-free, and no module in this package was.

## Decision

**The vocabularies and pure derivations of the protocol live in validator-free modules, and the zod
schemas are built on top of them. `@musterd/protocol/wire` is the door for a consumer that reads the
contract rather than enforcing it.**

1. **One list per closed set, in a `*.wire.ts` module.** `acts`, `ask`, `capabilities`, `envelope`,
   `goals`, `lanes`, `offline`, `posture`, `seeds`, `working-hours` each gain a sibling module that
   holds the tuples, the types derived from them, and the pure functions over them. The zod module
   beside it **builds its enum from that tuple and re-exports the name**, so `@musterd/protocol`
   keeps its one-import surface and the two faces cannot disagree about what the wire allows.
   Duplicating a list here rather than re-homing it would reintroduce exactly the drift this avoids,
   and is the thing to refuse in review.
2. **`@musterd/protocol/wire` is an enumerated subpath export**, like `./model` and `./posture`
   before it — a barrel over the `*.wire.ts` modules plus `guards.ts`. It is additive: nothing is
   removed from `.`, and no existing importer changes.
3. **A read guard validates in proportion to what acts on the result.** `readMemberSummary` checks
   every field against the tuple it was built from, because the roster **counts** what it cannot read
   into `unreadable` and renders the ADR 148 "behind" hint from that count — a guard that waved rows
   through would make the count a lie. The response readers (lane board and result, audit, report)
   check the envelope of the response, fill the defaults an older daemon may omit, and stop.
4. **Read-path tolerance stays per-row; the write path stays strict.** Nothing in this ADR touches
   ingest: the daemon parses every envelope and every lane body with zod, which is the boundary that
   decides what becomes durable. `makeEnvelope` keeps its parse for every caller inside the daemon;
   a browser composing an act it is about to POST uses the validator-free `buildEnvelope` and sends
   it to an endpoint that validates.
5. **A closed set a guard checks must be one the daemon cannot widen underneath it.** Where the set
   is actively widening — `Seed.source`, which ADR 373 increment 2 extended from `slack` to include
   `repo` — the guard checks the field's *type*, not its membership. A browser rejecting a value its
   daemon had just learned is the ADR 148 failure in miniature.

### Not in this ADR

- **Removing zod from the daemon, CLI or MCP.** They enforce; the schemas are the enforcement.
- **A codegen step deriving the guards from the schemas.** Two hand-written readers plus a drift
  test is less machinery than a generator and fails louder. If the corpus test ever passes while the
  two disagree, that is the trigger for generation — recorded, not built.
- **Guarding the report body deeply.** Nothing in the web branches on its inner shape.

## Consequences

- zod is absent from every chunk in `packages/web/dist/client` — total JS gzip 249.1 → 228.6 KiB
  (38 → 36 chunks), `/live` eager 139.1 → 132.0 KiB (13 → 12). Budgets **re-baselined, tightening**
  per ADR 183: `totalJsGzipBytes` 258,000 → 237,000, `initialJsGzipBytes` 144,000 → 137,000. Five of
  the six raises are repaid.
- The package gains ten small modules and one subpath. The cost is a rule to hold in review: a value
  export added to a `*.wire.ts` module that imports a zod module is free to write, invisible in the
  diff, and appears in the bundle as a chunk.
- A third-party implementation reading this protocol can now depend on the vocabulary without
  depending on zod's version. That was not the motivation and is not promised, but it is true.
- The browser no longer re-derives the daemon's field validation on four read endpoints. What it lost
  is a strict page-level reject on a malformed response; what it gains is that a response from a
  **newer** daemon renders, which is the posture ADR 148 asks for and the one `fetchRoster` was
  rewritten to restore in the first place.

## Observability & Evaluation

- **Traces:** none new. The roster's `unreadable` count (ADR 148) is the standing signal that the
  per-row guard is doing its job; it must keep reading 0 against a matched daemon.
- **Eval:** `grep -l ZodError packages/web/dist/client/assets/*.js` after a build prints nothing.
  Success: `pnpm perf:check` reads total ≈228.6 KiB against 231.4 KiB and initial ≈132.0 KiB against
  133.8 KiB. Failure — the falsifier — either that grep matching a chunk, or
  `packages/protocol/src/guards.test.ts` reporting a corpus row where `readMemberSummary` and
  `MemberSummarySchema` disagree.
- **Experiment:** `guards.test.ts` runs both readers over one corpus of 44 member rows (accepts,
  rejects, the legacy `idle` → `active` transforms, the `.default()` fills) and asserts identical
  verdicts and identical normalized output. The corpus is the artifact to extend whenever the member
  shape grows — a field added to `MemberSummarySchema` with no branch in the guard fails there.
