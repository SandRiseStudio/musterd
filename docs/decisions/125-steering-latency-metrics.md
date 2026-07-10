# 125 — Steering-latency & stale-work-caught metrics (ADR 088 increment 4)

- Status: accepted
- Date: 2026-07-10

## Context

Increments 1–3 of the interrupt-line arc are shipped:

- [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) — the interrupt line
- [ADR 103](103-steer-challenge-defer-acts.md) — `steer` / `challenge` / `defer`
- [ADR 111](111-stale-plan-detection.md) — plan epochs + targeted staleness wakes

Each ADR's Observability & Evaluation section named the same headline numbers and deferred building
them: **steering latency**, **supersession-correctness**, and **stale-work-caught**. Design §8 item 4
([interrupt-line-mid-loop-reachability.md](../design/interrupt-line-mid-loop-reachability.md)) is the
last rung — the measurement layer that turns the arc from a claim into a before/after against the P3
~37%-waste baseline. The numbers live on the report engine ([ADR 050](050-insights-report-metrics-waiting-on.md) /
[ADR 084](084-lanes-join-the-plan.md)): derived, never stored, one projection for CLI + MCP.

## Problem

Surface three Goodhart-safe metrics from the existing message + lane log — no new capture, no
migration, no wire-version bump — so `musterd report` / `team_report` can answer: how fast does a
`steer` reach a busy agent, do agents ever act on a superseded direction, and do staleness wakes
actually catch course-changes?

## Decision

### 1. One additive `steering` block on `Report`

`ReportSchema` gains a `steering` object (windowed like coordination-density / MAST — 7 days). Three
numbers, one posture:

| Metric | Definition | Source |
| --- | --- | --- |
| **Steering latency** | For each directed `steer` to a member in the window, latency = recipient's first subsequent act (`ts ≥ steer.ts`) − `steer.ts`. Report `steers` (count), `acked` (those with a follow-on act), `latency_median_ms` / `latency_p95_ms` (null when `acked = 0`). | `messages` |
| **Supersession-correctness** | Count of acts whose `meta.in_reply_to` names a `steer` that was already superseded at the act's timestamp (a newer `steer` to the same recipient exists with `steer.ts < act.ts`). Should be **zero**. | `messages` |
| **Stale-work-caught** | Count of `stale_plan` / `stale_dependency` wake acts (`meta.lane_warning.kind`) in the window whose subject lane was subsequently abandoned or resolved (`resolved_at > wake.ts`), or whose owner posted a course-changing act (`accept` / `handoff` / `status_update` / `resolve`) after the wake. Also report `stale_wakes` (denominator). | `messages` + `lanes` |

The recipient's **next act** is the acknowledgment for latency — matching ADR 103's "next act
acknowledging it" without requiring a formal `accept` (agents usually continue under the new
direction with a `status_update`). Supersession-correctness stays strict: only an explicit
`in_reply_to` of a dead steer counts as the contradictory-stack failure.

### 2. Pure read module on the report engine

`deriveSteeringMetrics(db, teamId, now)` in `store/insights.ts` (same family as
`coordinationDensity` / `deriveMast`). Folded into `deriveReport` → `Report.steering`. No new HTTP
route — the existing `GET /teams/:slug/report` payload grows additively.

### 3. Surfaces

- **CLI:** `musterd report` (team altitude) and `musterd report coordination` render a `steering`
  section; `--json` already dumps the full report.
- **MCP:** `team_report` renders the same block on the team altitude (and always in the structured
  payload).

No new acts, no new emitters, no scores — diagnostic instruments only (human-agent-dynamics §4).

## Consequences

- The interrupt-line arc is measurable end-to-end; the launch-demo A/B (hook-on vs hook-off, ADR 056)
  can read these numbers directly from the report.
- Additive protocol field only — clients that ignore unknown keys keep working; typed clients pick up
  `steering` with this ADR.
- Roadmap item `steering-latency-metric` ships with this change.

## Observability & Evaluation

**Traces** — n/a — this ADR *is* the evaluation layer over existing traces/acts; it emits nothing new.
Steers and staleness wakes already ride ADR 088/089/103/111 instrumentation.

**Eval** — the three numbers above. _Dataset:_ the message + lane log. _Baseline:_ P3 dogfood
(~37% waste; dependency-steer unseen for a full work cycle). _Targets:_ median steer latency ≤ one
tool-call boundary for hooked agents; `superseded_acts = 0`; stale-caught / stale-wakes rising vs the
unseen-steer baseline.

**Experiment** — ADR 088/103/111's built-in A/B (hook-on vs hook-off; free-text vs `steer`; `defer`
while heads-down) now has a single instrument panel. A coordination-traces benchmark scenario
(ADR 056).
