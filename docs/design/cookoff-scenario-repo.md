# cookoff scenario repo — the Skiff fixture

> **Built 2026-07-10** (Lane `01KX6QBK3B57ZMD7CZ4G0GSF6R`, Goal cookoff-value-experiment). This is
> the pointer record for the cookoff **fixture**, which lives in its own repository — not in this
> product repo — so its pinned kickoff commit is un-entangled from musterd's history and its bespoke
> code is not in any model's training data. The measurement rules it is scored against are frozen in
> [ADR 123](../decisions/123-cookoff-measurement-protocol.md) /
> [`cookoff-measurement.md`](cookoff-measurement.md); the experiment it feeds is
> [ADR 122](../decisions/122-cookoff-value-experiment.md) / [`cookoff-experiment.md`](cookoff-experiment.md).

## Where it is

**`SandRiseStudio/cookoff-scenario`** (private) — https://github.com/SandRiseStudio/cookoff-scenario

- **Kickoff SHA** (the pinned starting state every cell is scored from): `ea5c6d4` (tip of `main`).
- Stack: TypeScript + vitest, zero runtime dependencies.

## Skiff — the bespoke domain

Skiff is an invented river-ferry booking-and-billing service on the (fictional) river Vell under the
(fictional) Meridian Concord tariff. Every rule and constant is defined in-repo in `SPEC.md`, so the
task cannot be solved from memory. It is a deterministic pure-logic fare core behind a framework-free
HTTP router over an in-memory ledger — chosen so the coordination traps fire naturally on shared
modules (`config.ts`, `schema.ts`, `tariff.ts`, `router.ts`).

## The 8 trap tickets

The identical work artifact is `TASKS.md` (seeded as Goals/Lanes from the same text in the musterd
cells — ADR 122's "hold the work constant" invariant). The backlog is engineered for the core-three
trap taxonomy:

| #   | Ticket                                   | Trap                        | Contended surface      |
| --- | ---------------------------------------- | --------------------------- | ---------------------- |
| T1  | canonical `quoteFare`                    | hidden-dependency **root**  | tariff                 |
| T2  | `POST /quotes` price estimate            | **hidden dependency** on T1 | router, schema, tariff |
| T3  | reject malformed bookings                | **duplicate scope** w/ T4   | schema, router         |
| T4  | harden the booking endpoint              | **duplicate scope** w/ T3   | schema, router         |
| T5  | twilight off-peak rebate                 | **shared surface**          | tariff, config         |
| T6  | tiered loyalty rebate                    | **shared surface**          | tariff, config, store  |
| T7  | `GET /ledger/summary`                    | shared router/schema        | router, store, schema  |
| T8  | configurable reach fares + `GET /tariff` | **shared surface**          | config, router, tariff |

T2's wording never names T1; T3/T4 overlap by design; T5/T6/T8 all edit the fare pipeline and config.

## Branch layout

- **`main`** — the kickoff scaffold only (compiling, green on the visible baseline tests, all tickets
  unimplemented). Agents branch from here and merge back per [ADR 106](../decisions/106-unified-git-workflow.md);
  its tip is the kickoff SHA.
- **`scoring`** — the grading apparatus, **never merged into `main`** so agents never see it:
  `acceptance/T1..T8.test.ts` (one hidden vitest suite per ticket, graded through the router by
  behaviour), `scoring.config.json` (kickoff SHA, exclude globs, ticket→suite map, configured
  actors), `score.ts`, and `OPERATOR.md`.
- **`reference-solution`** — a correct implementation across three seat identities (`alix` / `boro` /
  `cyra`, ADR 109 `Co-authored-by` trailers), used to prove the harness offline. Its history carries
  one deliberately abandoned commit (`abandoned/legacy-pricing`) so the archaeology classifier has a
  genuine non-zero signal to catch.

## Scoring workflow

`score.ts` (on `scoring`) rolls the four ADR 123 metrics into one report over a delivered ref:

- **headline** wasted-work % — shells out to `musterd archaeology --start <kickoffSha> --delivered
<ref> --json` (git predicate set v1) and surfaces the W1–W4 + per-actor breakdown;
- **guardrail** acceptance pass rate — overlays the hidden suites onto a throwaway checkout of the
  delivered tree and runs vitest, one suite per ticket;
- **support** interventions-to-done — parses the per-run `interventions.log` (I1–I6);
- **support** tokens-to-done — best-effort from Claude Code usage `.jsonl` (billed-cost roll-up
  pending the model + pricing pin, ADR 123 §7).

Because the archaeology window is `git rev-list --all --not <kickoff>`, each **cell runs in its own
single-branch clone of `main`** — a full clone of the fixture would let the `reference-solution` /
`abandoned` branches count against the run. See `OPERATOR.md`.

## Validation (offline proof the harness runs)

`node --experimental-strip-types score.ts --delivered reference-solution` reports **8/8 acceptance**
and a **non-zero** archaeology breakdown (12.2% wasted-work, all W1 abandoned, three seats
attributed). This is the smoke rung's de-risking done ahead of time: the scenario repo, hidden tests,
scoring script, and git archaeology are proven to work together before any paid run.

## What's next (not this Lane)

The **run ladder** Lane (`01KX6QBY86YD9A7W696P31ABXQ`) consumes this fixture: its smoke rung also
recalibrates `musterd archaeology` against finding 001's ≈37% before scoring any cell, and pins the
flagship model + harness in the ADR 051 run manifest (still open, ADR 123 §7).

## Related

[ADR 122](../decisions/122-cookoff-value-experiment.md), [ADR 123](../decisions/123-cookoff-measurement-protocol.md),
[`cookoff-experiment.md`](cookoff-experiment.md), [`cookoff-measurement.md`](cookoff-measurement.md),
[ADR 106](../decisions/106-unified-git-workflow.md), [ADR 109](../decisions/109-seat-git-attribution.md),
finding [001](../research/001-telemetry-gaps-p3-dogfood.md) (the ≈37% anchor + the archaeology
reference method).
