# 048 — The Plan/Goal work-item model: declared skeleton, derived flesh

- Status: accepted — Plan/Goal spine shipped (orientation-spine arc, #81 increment 2)
- Date: 2026-06-24
- Amended by: ADR 084 (lanes join the Plan — the work-item noun below a Goal is the lane when
  ownership/contention matters; Goal status derives lanes-first over `Goals × lanes × threads`)

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
  Goal store/view for musterd's own dogfood. Below the Goal, a **work item** carries the actual work —
  a **lane** (ADR 083) when ownership/contention matters, or a **thread** as the zero-compliance fallback.
  ("feature/task" are informal depth-labels, not a schema; see the shape note below.)
- **The shape is two levels — `Goal → work-item` — not a recursive tree.** *(Amended by ADR 084.)* The
  original design imagined an optional immutable `parent` pointer (epic→feature→task); no such field ships.
  Containment is the flat `goal_id` join from a lane/thread up to its Goal — deliberately *not* a
  recursive hierarchy, because amprealize's mutable `parent_id` tree "was a direct bug source." A "feature"
  mid-altitude is a *grouping in prose*, not a stored node. No move / reorder / column CRUD, ever.
- **Declared skeleton (may be stored, curated):** a Goal's *existence, intent, `wave`, `dependsOn`*.
  PR-gated in `roadmap.data.ts` for the dogfood ("curated is a feature"); in-band for a general team
  (deferred — see seam). No `parent` field.
- **Derived flesh (never stored):** a Goal's **status is a projection** over its work items joined by
  `goal_id` — **lanes-authoritative, threads fallback-only.** The exact rule (quantifier, thread handling,
  flap-tolerance) is pinned in **ADR 084**; in one line: `shipped` once the Goal has lanes and they are
  all terminal with ≥1 `done`, `in-flight` while any lane is live, `planned` with no lanes. **Live status
  is flap-tolerant** — reopening work honestly returns a Goal to `in-flight`. This derived status drives
  `musterd next` and the live dashboard. The **public `ROADMAP.md` badge keeps its declared status**
  (curated is a latch, and a milestone shouldn't un-ship on a follow-up lane) — see the generator bullet
  below; wiring the generator to live derived status is deliberately *not* done.
- **Terminal-done signal:** the load-bearing terminal is a **lane reaching `done`** (ADR 083); thread
  `resolve` (ADR 025) is the fallback for lane-less teams. *(Amended by ADR 084 — the original text made
  thread `resolve` load-bearing, but it is dead in practice, 2/21.)*
- **Visibility inheritance:** derived Goal status is a projection over the same acts/lanes as the raw log,
  so it **inherits their visibility exactly** — team-wide today (no message-content need-to-know is
  enforced yet), and whatever the v0.3 need-to-know model later scopes. A derived view is *more legible*
  than the raw acts it summarizes, so the surveillance-asymmetry caution binds it **more** tightly, not
  less. The projection is only as trustworthy as the declarations feeding it, which are unauthenticated by
  design (any member may set `goal_id`/lane ownership — warn-never-block, roster-governance-not-work-approval).
- **Open seam (BUILT 2026-07-02):** where *declared* Goals live for a **general** (non-musterd) team —
  a `message` act to `@team` carrying `meta.goal` (`{id, title, wave?, depends_on?}`), **no new act, no
  new table**, latest-declaration-per-id wins. `POST/GET /teams/:slug/goals`, `musterd goal
  declare|list` + `team_goals`/`team_goal_declare`, and `musterd next` picks the next `planned` Goal by
  `wave` minus `dependsOn`-blocked. `roadmap.data.ts` stays musterd's own dogfood source, untouched.
  Derived status is agnostic to the source — it needs only a stable `goal_id`.
- **The `ROADMAP.md` generator keeps *declared* status, not derived — a deliberate reversal of the
  bullet above (2026-07-02).** ADR 084's flap-tolerance decision settles it: live derived status
  *flaps* (a follow-up lane returns a shipped Goal to `in-flight`), which is right for `musterd
  next`/the dashboard but wrong for a **public roadmap milestone badge**, which wants a curated latch.
  So the curated roadmap keeps its declared status (a creating-declaration, "curated is a feature");
  the derived projection serves orientation. Wiring the generator to the daemon's live status is
  explicitly **not** wanted.

## Consequences

- A real planning layer with **zero stored execution state**. For a **general team** the manual
  status-tick never exists — Goal status is derived from lanes. For musterd's **own dogfood roadmap** the
  curated `status` stays by deliberate choice (the public-badge latch, above), so ADR 041's generator is
  **unchanged** — no daemon coupling, no flap in the public artifact.
- New work (all shipped 2026-07-02, ADR 084 increment 2): the declared-Goal mechanism (`meta.goal`
  messages), the derived-status projection (`deriveGoalStatus` + `listGoals`/`nextGoal`), and the
  `next`/`goal` surfaces. The web map + `ROADMAP.md` generator were intentionally left reading declared
  status.
- "Epic/feature/task" reuse amprealize's vocabulary, but as **informal depth-labels over a flat
  `Goal → work-item` join** — its rot was architectural (stored, dual-written state; a mutable `parent_id`
  tree), not lexical. We keep the words, not the tree.
- **Non-goal (the standing bet):** this layer is deliberately *not* a project-management tool. If it ever
  stores execution state, grows a `status` column, adds move/reorder/column CRUD, or grows a recursive
  `parent` tree, it has failed and reintroduced the amprealize rot. Minimal declared noun, derive
  everything else.
- Foundation for **ADR-049** (orientation & handoff) and **ADR-050** (insights), both of which are
  projections over `Goals × lanes × threads` *(amended by ADR 084 — lanes join the projection)*.
