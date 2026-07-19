# 151 — Web performance budgets: the /live perf arc becomes a merge gate

- Status: accepted — 2026-07-19
- Date: 2026-07-19

## Context

A measure-first optimization arc (#326–#331) took the /live dashboard from throttled Lighthouse
**49 → 85**, transfer **1,077 KB → 381 KB**, and **4,461 → 1,564** DOM nodes: compression + caching
at the daemon (#326), compressed JSON (#327), a windowed stream DOM (#328), dropping 503 KB of
retired fonts (#329), and suspending the office render loop while unseen (#331). The method and every
measured verdict — including the levers that _didn't_ pan out — live in
`docs/perf/web-live-baseline.md`, with a reproducible harness at `scripts/perf/live-baseline.mjs`.

Nothing defends those wins. The baseline doc is a lab notebook, not a contract: an agent adding a
feature to `packages/web` next month has no gate that fails when it ships a 200 KB dependency, a
fourth font family, or an always-running rAF loop — and no guidance surface that tells it the arc
ever happened. Our own cookoff A/B run (2026-07-17, the ADR 150 motivation) measured exactly this
failure mode in another domain: with guidance alone, agent compliance was 0/8; behavior moved only
when the rule became structural. Prose asking future agents to "keep the UI fast" is the already
disproved treatment.

## Problem

Make the performance floor durable against future contributors — human or agent — who never saw the
arc. The mechanism must (a) fail the merge automatically for the regression vectors a machine can
catch, (b) put the non-machine-checkable rules where an agent working in `packages/web` actually
reads, and (c) keep raising a budget possible but deliberate — a visible, reviewed diff, never a
silent drift.

## Decision

Three layers, cheapest enforcement first.

### 1. Byte budgets as a CI gate — `pnpm perf:check`

`docs/perf/budgets.json` holds the numbers; `scripts/perf/check-budgets.ts` (native-TS, no deps,
same pattern as the vocab/obs-evals gates) enforces them against `packages/web/dist/client` and runs
in the `gates` job right after Build. Budgeted dimensions: **total JS gzip**, **per-chunk JS gzip**,
**total CSS gzip**, **total font bytes**, and a **font-family allowlist**. Gzip for text because that
is what the daemon serves (#326); raw bytes for fonts (pre-compressed formats). Initial budgets are
the 2026-07-19 main-branch measurements plus ~10% headroom, so ordinary feature work fits and a
dependency-sized regression does not.

Bytes-only is deliberate: bytes are the one dimension CI can measure without a daemon plus headless
Chrome, they are deterministic (no flake), and they were the largest single lever of the arc
(compression + fonts ≈ 700 KB of the 1,077 → 381 drop). Runtime metrics — LCP, FPS, DOM size,
long tasks — stay on the manual harness, which simulated-throttling Lighthouse is too noisy to gate
on anyway.

**Raise protocol:** a budget increase is made in the same PR as the change that needs it, justified
in the PR body, with the measured cost appended to the baseline doc's optimization log. The gate's
failure message states this protocol, so the contract travels with the failure.

### 2. A scoped guidance surface — `packages/web/AGENTS.md`

The rules a byte-check cannot see, placed where harnesses load context for work under
`packages/web/` (a `CLAUDE.md` there imports it for Claude Code): render loops suspend when unseen;
list DOMs stay windowed; three font families; canvas type via `canvasFont.ts` tokens; the daemon
already compresses; new dependencies justify their gzip cost. It also carries the **don't-re-chase
list** (entry-chunk split, `content-visibility` on stream rows, split-bake/ambient-cap) so future
agents don't burn a session re-disproving a measured verdict, and the ritual: perf-affecting change
→ run the harness → append numbers to the baseline log.

### 3. This ADR

The policy record: budgets are law, the baseline doc is the measurement log, the AGENTS.md is the
working contract. Future feature ADRs touching the web UI inherit the budget constraint by
default — an ADR that needs more bytes says so and moves the number in the open.

## Observability & Evaluation

**Traces** — the gate's one-line summary (each category's spend vs budget, largest chunk) prints on
every CI run and every local `pnpm perf:check`, so byte drift is visible in green runs, not only at
failure. The budgets file is itself the trend instrument: its git history is the record of every
deliberate raise, each tied to a PR with a logged justification. Runtime metrics remain observable
via the harness (`scripts/perf/live-baseline.mjs`) with results appended to
`docs/perf/web-live-baseline.md`.

**Eval** — the gate self-verifies mechanically: at introduction it passes on main's build
(217.7 KB JS / 16.9 KB CSS / 708 KB fonts against 244.1 / 19.5 / 742.2 budgets) and was
negative-tested by lowering budgets below spend (fails, exit 1, names the offending chunks). Dataset:
every future PR build. Baseline: the pre-gate state, where a regression shipped silently. Headline
measure: zero unreviewed regressions past the budgets — any exceedance appears either as a red
`gates` run or as a reviewed `budgets.json` diff. Secondary measure, checked at the next perf pass:
the budgets file's raise history stays sparse (frequent small raises would mean the headroom is
mis-sized or the contract is being paid down in installments).

**Experiment** — the standing question from the cookoff arc applies here too: does the structural
gate change agent behavior where prose didn't? The natural probe is the next web-UI feature lane
built by an agent that never saw this arc: watch whether (a) the gate trips and the agent shrinks
the change rather than raising the budget, and (b) the AGENTS.md rules that are _not_
machine-checked (loop suspension, windowed lists) are followed without prompting. If (b) fails while
(a) holds, that is more evidence for the ADR 150 thesis — and a signal to promote the checkable
subset of those rules (e.g. a static grep for un-suspended `requestAnimationFrame` loops) into the
gate.

## Consequences

- Adding meaningful bytes to the web client now requires either shrinking the change or an explicit,
  reviewed budget raise — the silent path is closed.
- CI cost is negligible: the check is a few hundred milliseconds of gzip over an already-built dist.
- The budgets can go stale in the _loose_ direction (headroom above real spend after future wins);
  the perf ritual includes tightening them to measured-plus-10% when a pass lands a big drop.
- Bytes-only means a runtime regression (an always-on loop, an unbounded DOM) can still merge; the
  AGENTS.md contract plus the harness ritual are the defense until a checkable subset earns
  promotion into the gate.
