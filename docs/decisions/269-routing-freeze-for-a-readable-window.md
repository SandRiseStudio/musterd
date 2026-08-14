# 269 — The routing files hold still until 2026-08-21, so the acceptance re-run can be read

- Status: accepted
- Date: 2026-08-14
- Owner: izzo
- Relates to: ADR 260 (live pick skips a busy agent, and its 2026-08-14 Eval note), ADR 253 (agents-only live pick), ADR 254 (eligible sets), quiet-set spec increments 1–2, `docs/wiki/acceptance-routing.md`

## Context

The ADR 260 Eval ran on 2026-08-14 (#837) and could not be read **in either direction**. Not credit, not disproof: acceptance routing had concentrated onto the team's single cross-family seat starting 08-12 — a day before increment 1 went live — so the 23% → 6% move on the 10-minute rate indicted nothing. The window contained ADR 253, the effective arrival of that seat, and four other merges.

#842 gave the scheduled re-run a window guard that detects this condition instead of reporting through it. Its first live run refused, and the refusal is the finding: **11 commits to the routing files and 4 `policy.change` rows in 7 days.**

Detection alone therefore buys nothing. At that rate the 2026-08-21 re-run reports UNREADABLE and the team learns nothing for the second time. On a system this active, a measurement window is **made, not found**.

## Problem

Three files decide who is asked to accept: `packages/server/src/store/review.ts` (who is picked), `packages/server/src/store/orientation.ts` (what re-surfaces), `packages/protocol/src/envelope.ts` (which acts may fan out). Every change to them is individually justified and collectively fatal to any before/after measurement spanning it.

Nobody was careless. The changes were ADRs 253, 254, 255, 257, 258, 264 and more — a week of genuine improvement. That is the point: the contamination is a *byproduct of working normally*, which is exactly the kind of failure a norm cannot fix and a gate can.

## Decision

**Those three files hold still until the re-run fires (2026-08-21 09:07), enforced by `pnpm routing-freeze:check`.**

The freeze is **deliberately weak**:

- `[unfreeze: why]` in any commit message on the branch passes the gate. Routing work that must land, lands.
- Breaking it is not a fight and needs nobody's permission. It costs one line and voids one statistic.
- The gate **self-expires**: after `FREEZE_UNTIL` it exits 0 without reading the diff. A freeze that outlives its measurement is friction nobody can explain, and friction nobody can explain gets deleted at the worst moment by whoever trips on it.

The frozen list is imported from the Eval's own `ROUTING_PATHS`, so the files the team holds still are **by construction** the files the instrument watches. Two hand-kept lists would drift, and drift would present as a clean window over a system that moved — the original failure, re-created on purpose.

## What this is not

- **A claim that routing work is less important than the measurement.** It is not. The escape hatch exists because the ordering is the opposite: shipped routing beats a cleaner statistic, and the freeze only insists the trade is made on purpose.
- **A norm.** ADR 259's own evidence is that a written norm nobody reads does not change behaviour; the wiki knew about the stale-`dist` trap for three days while two seats walked into it. This is a gate for the same reason #836 is a gate.
- **Permanent.** One week, one measurement, then inert.

## Consequences

The one claimed lane plausibly affected is miley's incident-convergence increment 2 — increment 1 touched `orientation.ts` and `envelope.ts`. **miley was asked before this was built** (`01M014PGVXGH6BCV5D4DDY4D0B`), offered a named carve-out or a flat decline, and told that a decline would be recorded here as a knowingly dirty window rather than argued with. Quiet-set increment 2 is the other lane in range and is already parked by the Eval's verdict, so the freeze costs it nothing.

If the window survives to 08-21, the re-run reports a readable number for the first time — with concentration (top-reviewer share) as the primary metric per the spec's Increments point 3, and the 10-minute rate secondary.

If it does not survive, the guard says so and the honest outcome is recorded rather than a number quoted. **A void window is a result, not a failure** — it is the measurement telling the truth about a system that is changing faster than it can be observed, which is itself worth knowing before anyone sizes a protocol change on a week of data.

## Observability & Evaluation

**Traces.** None new. The gate is a CI check; the void condition is already detectable by #842's window guard, independently of whether anyone ran this gate.

**Eval.** Did the freeze hold? Two readings on 2026-08-21, both cheap:

1. `git log --format=%B <freeze-start>..HEAD -- <ROUTING_PATHS>` — count `[unfreeze:]` markers. Zero means the window is clean and the re-run's verdict stands on its own.
2. The re-run's own verdict. If it says UNREADABLE while the gate recorded no override, the two disagree and **the guard is right** — something contaminated the window that this gate does not watch (a new seat changing the grade ladder is the known example, and it is invisible to both). That disagreement is the most informative outcome available and should be written up, not reconciled away.
