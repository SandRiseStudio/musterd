# 048 — The Plan/Goal work-item model: declared skeleton, derived flesh

- Status: proposed
- Date: 2026-06-24

## Context

musterd v0.2 attaches all state to **members** (`status_update` + the `working:` roster label). It has
no noun for **the work itself** — no backlog, milestones, or board. The 2026-06-24 planning session
(`docs/design/planning-and-insights-brainstorm.md`, "Live session") designed that layer end-to-end.

The cautionary anchor is the prior platform, **amprealize** (`/Users/nick/main/amprealize`): it bundled
an agile board + work-items and rotted. It **stored execution state and dual-wrote it** — an agent-run
table *and* a `work_items.status` column with no transaction between them → drift; boards were lost
twice and recreated by hand (`scripts/recreate_boards.py`, `migrate_board_statuses.sql`). Its mutable
`parent_id` hierarchy (Goal→Feature→Task) wired to move/reorder operations was a direct bug source. The
governing maxim (`human-agent-dynamics.md` §4): *record facts, enforce boundaries, read meaning out of
the durable record — never assert it into config. Execution state is always derived; planned work may be
declared.*

## Problem

Introduce a planning / work-item layer that (a) gives orientation and leadership a noun for work at
multiple altitudes (epic→feature→task), (b) does **not** recreate the board-rot (stored, hand-synced
execution state), and (c) adds **no new execution-state storage** and minimal new schema.

## Decision

- **One layer, `Plan`, viewed at altitudes.** The top altitude is a **`Goal`** — a *declared outcome*
  ("what this team is for"). This **retires "roadmap" as the coarse noun**: `roadmap.data.ts` becomes the
  Goal store/view for musterd's own dogfood. Below the Goal, **feature → task are depth-labels, not
  schemas** — they are **threads** (the existing primitive), whose latest act is their status.
- **Hierarchy via an optional `parent` pointer** on the work-item notion: **immutable, containment-only.
  No move / reorder / column CRUD** — that is exactly where amprealize's `parent_id` rotted.
- **Declared skeleton (may be stored, curated):** a Goal's *existence, intent, `wave`, `dependsOn`,
  `parent`*. PR-gated in `roadmap.data.ts` for the dogfood ("curated is a feature"); in-band for a general
  team (deferred — see seam).
- **Derived flesh (never stored):** a Goal's **status is a projection** over threads joined by `goal_id`
  — a resolved representative thread → `shipped`; an accepted-but-unresolved thread → `in-flight`; none →
  the declared default `planned`. **`roadmap.data.ts` drops its `status` field**; the web roadmap map and
  the `ROADMAP.md` generator (ADR 041) read the derived status. Progress against a Goal is *counted* from
  its children's terminal (`resolve`, ADR 025) acts — never typed.
- **Terminal-done signal already exists:** `resolve` (ADR 025) is the thread-close marker this relies on.
- **Open seam (deferred):** where *declared* Goals live for a **general** (non-musterd) team — leaning
  toward a thread declared to `@team` carrying goal metadata (the parked doc's *intended-but-unoffered*),
  **no new act, no new table**. `roadmap.data.ts` stays musterd's dogfood source. Derived status is
  agnostic to this — it needs only a stable `goal_id`.

## Consequences

- A real planning layer with **zero stored execution state**; the manual `roadmap.data.ts` status-tick
  (done by hand for ADR 046 this session) is **eliminated**.
- New work: the derived-status projection, and reading it in the web map + the `ROADMAP.md` generator (a
  real change to ADR 041's generator, which currently reads the hand-declared `status`).
- "Epic/feature/task" reuse amprealize's vocabulary, but as **depth-labels on a derived tree** — its rot
  was architectural (stored, dual-written state), not lexical.
- Foundation for **ADR-049** (orientation & handoff) and **ADR-050** (insights), both of which are
  projections over `Goals × threads`.
