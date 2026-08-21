# 050 — Insights: `musterd report`, flow metrics, and the waiting-on view

- Status: accepted — insight engine shipped (report engine #82, coordination-density #84)
- Date: 2026-06-24
- Amended by: ADR 084 (lanes join the Plan — flow metrics read lane timestamps first; thread
  `open → resolve` is the fallback; projections are computed server-side, surfaces render);
  Amendment 2026-08-21 below (seam disposition — cost metric stays deferred with its prerequisite
  named; the scheduled digest is retired)

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
  noted future enrichment, not day-one. *(Retired 2026-08-21 — see the Amendment below.)*
- **Flow metrics over velocity** (drop story points — agent capacity is elastic, sprint velocity is
  meaningless): throughput (threads closed/wk), cycle time (open → `resolve`), WIP, work-item age. All
  derivable from the log.
- **Goodhart guard:** measure **outcomes / queues** (threads closed, asks answered, artifacts shipped),
  **never message volume** (agents emit cheap text).
- **Cost-per-shipped-work-item in $** — the agent-native flagship metric ("this Goal cost $340 / 6 days;
  bottleneck was human review", a sentence no human-team tool could honestly produce). **Deferred to the
  cost-ingestion seam:** it needs per-member token/compute cost accounting (the observability / "batond"
  surface). Ships when that data exists; not plumbed into the core now. *(Re-examined 2026-08-21:
  still deferred, prerequisite now concrete — see the Amendment below.)*
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

## Amendment (2026-08-21): seam disposition — one seam stays deferred, one is retired

Both seams this ADR named-but-did-not-build were re-examined on their merits (nick + miley,
2026-08-21), with the explicit option of concluding "no". The outcomes differ, and each is dated
here so the seam stops reading as a live plan nobody has looked at since June.

**Cost-per-shipped-work-item: still deferred — the data still does not exist, and now the
prerequisite has a name.** What shipped since June is ADR 252's wake-spend accounting
(`cost_usd_total`, `cost_usd_per_wake`, `unpriced_sessions`), and it prices exactly one thing:
sessions the wake path spawned and that reported a cost. Interactive sessions — every seat session a
human starts, which is most real spend — attest no cost at all, and ADR 252 §5's own rule is that
every attestation-derived count is a floor. A "$340 per Goal" figure built on that floor would be a
systematically wrong number wearing a flagship label, and ADR 252's posture (never fold an estimate
into a ledger whose job is to be trustworthy about spend) forbids shipping it. The concrete
prerequisite is the increment ADR 252's Limitations already names: a cost source for sessions the
wake path did not spawn (host-side reap of the harness's own accounting). When that exists, this
metric becomes buildable honestly; until then the seam stays a seam. ADR 194 parking batond changes
the consumer (the research practice, not an engine), not this data gap.

**Scheduled digest posted into the team: retired.** The digest's job was routing — get the report to
the team without hand-compiling. That job is now done at *reader time*: `team_next` opens every seat
session with goals in flight, carrying, review debt, and open lanes — the team-altitude digest,
delivered at the moment a seat can act on it. The push form, meanwhile, has evidence against it that
did not exist in June: the ADR 166 slot sweep escalated into `musterd report` and OS pushes for 25
days with zero of its DEMOTED findings inspected (izzo, 2026-08-21), the shape
`docs/wiki/recorded-not-routed.md` documents; and the team inbox routinely elides hundreds of unread
messages, so a scheduled broadcast would add agent-emitted volume — the exact thing this ADR's own
Goodhart guard refuses to reward — to a surface already past capacity. Pre-registered questions with
terminal states (the longitudinal-watches lane, ADR 297 in draft) are the successor answer to "how
does a measurement reach a reader". If a periodic team-facing digest is ever wanted again, it is a
new decision against that landscape, not a revival of this line.

Falsifier for the retirement: a shipped mechanism that posts scheduled report content into the team
*and* shows sustained reader engagement (inspections, not deliveries) would void the second
disposition. Falsifier for the deferral: the host-side-reap increment landing makes the first
disposition obsolete — build the metric then.
