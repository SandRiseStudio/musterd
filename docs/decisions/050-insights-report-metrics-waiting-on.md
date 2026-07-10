# 050 — Insights: `musterd report`, flow metrics, and the waiting-on view

- Status: accepted — insight engine shipped (report engine #82, coordination-density #84)
- Date: 2026-06-24
- Amended by: ADR 084 (lanes join the Plan — flow metrics read lane timestamps first; thread
  `open → resolve` is the fallback; projections are computed server-side, surfaces render)

## Context

Real teams (and the companies musterd wants to serve) need leadership to see progress / blockers /
milestones, and need PMs to **stop hand-compiling status** — that compiling is the mirror-sync toil that
rots. The 2026-06-24 planning session designed the insight layer (parked doc sections B/C/D). It builds on
the Plan/Goal model with **derived status** (ADR 048) and the reachability predicate
(`openActionNeeded`, ADR 024/046).

## Problem

Surface leadership-grade insight as **projections over the act log** (never stored), **Goodhart-safe**,
honoring the **surveillance asymmetry** — without building the deferred dashboard or a cost subsystem.

## Decision

- **`musterd report [--altitude ic|team|exec]`** — the report **writes itself from the log**. **IC** = the
  board (every thread, its latest-act column); **Team** = a digest ("14 threads closed · auth Goal shipped
  · time-to-unblock 2×"); **Exec** = milestones + exceptions ("on track; one risk blocked 2d"). All three
  are **projections, never stored**. Dashboard/web = **later** (same projection on the web console,
  deferred with the dashboard build). A **scheduled digest posted into the team** (protocol dogfood) is a
  noted future enrichment, not day-one.
- **Flow metrics over velocity** (drop story points — agent capacity is elastic, sprint velocity is
  meaningless): throughput (threads closed/wk), cycle time (open → `resolve`), WIP, work-item age. All
  derivable from the log.
- **Goodhart guard:** measure **outcomes / queues** (threads closed, asks answered, artifacts shipped),
  **never message volume** (agents emit cheap text).
- **Cost-per-shipped-work-item in $** — the agent-native flagship metric ("this Goal cost $340 / 6 days;
  bottleneck was human review", a sentence no human-team tool could honestly produce). **Deferred to the
  cost-ingestion seam:** it needs per-member token/compute cost accounting (the observability / "batond"
  surface). Ships when that data exists; not plumbed into the core now.
- **Waiting-on view** — `openActionNeeded` (ADR 024/046) **aggregated by recipient, sorted by age**
  ("waiting on nick — 8 threads, oldest 2d"). A section of `musterd report`; the per-person slice already
  exists as the ADR-046 nudge + the `status` comeback summary. **Goodhart-safe** (measures queues, not
  output). Names the real bottleneck: in a human+agent team the human is the rate-limiter. **Visibility:**
  team-wide on localhost now (a queue, transparency unblocks); **v0.3 need-to-know governs** later — the
  localhost down-payment posture (ADR 044). Natural home for v0.3's approval lane.

## Consequences

- Leadership insight as **audited projections** — no stored second source of truth, no board CRUD.
- Reuses the **shipped reachability predicate**; the waiting-on view is nearly free.
- The **cost metric, dashboard, and v0.3 governance** are named seams, not built here.
- Depends on **ADR 048**; composes with **ADR 049** (same derivations feed `musterd next`).
