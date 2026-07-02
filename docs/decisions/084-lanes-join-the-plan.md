# 084 — Lanes join the Plan: reconciling the work-item nouns

- Status: proposed
- Date: 2026-07-02

## Context

ADRs 048/049/050 (2026-06-24, proposed) designed the planning layer on one axiom: below a declared
`Goal`, **the work items are threads** — "feature → task are depth-labels, not schemas … whose latest
act is their status" (ADR 048). Cycle time was specified as thread `open → resolve` (ADR 050).

Six days later, ADR 083 (2026-07-01, accepted) shipped a different work-item noun: the **lane** —
`{ work-item × owner × surface }` — a first-class declared object with its own lifecycle
(`open | claimed | active | blocked | done | abandoned`), owner, dependency edges, a branch pointer,
and stored `claimed_at` / `resolved_at` timestamps. The lane spec explicitly left the planning
hierarchy out of scope ("the full planning hierarchy (Plan→Goal→feature)" —
`lane-phase1-mvp-spec.md`), so the two models don't contradict — but nothing says how they join, and
the planning ADRs were written for a pre-lanes world.

Two dogfood facts force the reconciliation in lanes' favor:

- **The act-`resolve` signal the planning ADRs lean on is dead in practice** — 2/21 loops closed in
  the P3 post-mortem. ADR 083's whole lifecycle design ("closes as a fact, not a courtesy") exists
  because of this: `lane_resolve` is a cheap state flip that writes no message.
- **Lanes already carry the flow-metric inputs.** `claimed_at → resolved_at` is cycle time;
  CONTENDING lanes are WIP; `created_at` gives age — stored today, read by nothing (ADR 050 wants
  exactly these numbers and would otherwise derive them from an act that isn't emitted).

## Problem

Make ADRs 048/050 lanes-aware before they're built: name the work-item noun below a Goal, define the
Goal↔work join, and re-ground Goal status + flow metrics on the signal teams actually emit — without
reopening amprealize's stored-execution-state wound or breaking the zero-compliance derived floor.

## Decision

1. **The work-item noun below a Goal is the lane when ownership or contention matters; threads remain
   the conversational fabric.** The shape is **two levels — `Goal → work-item` — not a recursive tree**
   (ADR 048's imagined `parent` pointer never ships; containment is the flat `goal_id` join). A
   work-item is a lane or, for a team that never opens a lane, a thread — the zero-compliance floor.

2. **The join is an optional `goal_id` on the lane** (additive migration; nullable column, no
   backfill). `lane_open --goal <id>` / the MCP `lane_open` param declare it at task start. This
   mirrors ADR 049's `goal_id` handoff-meta for threads — one stable id, two carriers.

3. **Goal status derivation — lanes-authoritative, threads fallback-only, flap-tolerant** (this is the
   pinned rule; amends ADR 048's ambiguous "representative thread"). Projected over
   `Goals × lanes × threads`:
   - **If the Goal has ≥1 lane, threads do not affect its status** (they are conversation; mixing dead
     thread-`resolve` into work-status is the failure this avoids):
     - `shipped` ⟺ every lane joined to the Goal is terminal (`done`/`abandoned`) **and** ≥1 is `done`;
     - `in-flight` ⟺ any joined lane is live (`open`/`claimed`/`active`/`blocked`);
     - (`planned` cannot occur here — having a lane means work exists.)
   - **If the Goal has no lanes** (fallback): an accepted-but-unresolved thread → `in-flight`; else
     `planned`.
   - **The projection is live, not a latch.** Reopening work (a new lane on a `shipped` Goal) honestly
     returns it to `in-flight`. This is harmless for `musterd next` (an in-flight Goal is skipped either
     way) and correct for the live dashboard. A **permanent milestone latch** for the *public roadmap*
     badge — a declared `landed` marker, a creating-declaration allowed by ADR 048's model, never a
     stored `status` column — is **deferred until the `ROADMAP.md` generator actually needs it** (nothing
     consumes live status until `next`/the dashboard exist).
   - **Quantifier chosen deliberately:** `shipped` is *conjunctive* over lanes (all terminal), not "any
     done," so a multi-lane Goal isn't marked shipped while lanes are still open. `abandoned`-only Goals
     do not count as shipped (the ≥1-`done` clause).

4. **Flow metrics read lane timestamps first** (amends ADR 050): cycle time =
   `claimed_at → resolved_at`; WIP = CONTENDING lanes; age = `now − created_at`; throughput = lanes
   `done`/wk. Thread `open → resolve` stays as the fallback for lane-less teams — stated as the
   degraded path, not the primary.

5. **The stored-state tension, addressed head-on** (the amprealize ghost): a lane's `state` *is*
   stored — but it is a **declared coordination fact** with a single writer (the daemon) in a single
   table, not a mirror of meaning derived elsewhere. The ADR 048 maxim refines to **one source of
   truth per fact**: lane state lives only in the `lanes` table; Goal status is never stored
   anywhere, always projected. amprealize rotted on the *dual-write* (an agent-run table *and* a
   `work_items.status` column, no transaction); this model has no second copy to drift.

6. **This resolves a seam ADR 083 left open**: "`status_update` traffic (51% of session messages) can
   migrate to lane transitions over time." With `goal_id` on the lane, lane transitions become a
   primary signal the insight layer projects over — the migration has somewhere to land.

### Engine placement (forward guidance for the insight build)

The projections this ADR defines belong **server-side, computed once, rendered by thin surfaces**.
Today the reachability predicate (`openActionNeeded`) lives in `packages/cli/src/render/rows.ts` —
CLI-only, invisible to MCP-wired agents (who use one channel only, per the primer). The daemon
already derives coordination state (`countOpenLoops` feeding `musterd.coordination.open_loops`,
ADR 082); Goal status, the board projection, flow metrics, and waiting-on follow the same pattern:
daemon HTTP API (e.g. `GET /teams/:slug/report?altitude=ic|team|exec`), with CLI (`musterd
next`/`done`/`report`), MCP parity tools, and the web dashboard as renderers. Duplicating the
projection per surface would rot.

## Consequences

- ADRs 048/050 remain the design of record for the planning/insight layer, **as amended here**; both
  gain a pointer to this ADR. ADR 049 is unaffected except that `goal_id` now has two carriers.
- Cycle time, WIP, and age become computable **the day the insight engine ships** — the lane table
  already stores the inputs; no new emission or agent compliance needed.
- One additive migration (nullable `goal_id` on `lanes`) when the Plan/Goal layer is built — nothing
  ships with this ADR alone.
- The roadmap's "Work items & insight" theme restructures to match: the declared skeleton
  (Plan/Goal), one server-side **insight engine**, and thin **CLI+MCP** / **dashboard** surfaces —
  replacing the pre-lanes board/report split.
- Standing cautions carry through unchanged: Goodhart (outcomes/queues, never message volume),
  surveillance asymmetry (v0.3 need-to-know governs derived *human* metrics; never rank Members),
  warn-never-block.
- **Trust & visibility of the projection** (recorded so the insight build inherits it consciously):
  the derived Goal status is only as trustworthy as the declarations feeding it, and **those are
  unauthenticated by design** — any team member may set a lane's `goal_id`/`owner_seat` with no
  authorization gate (roster-governance-not-work-approval; "admin actions never sit in the path of an
  agent doing its work"). That is the platform's chosen posture, not a gap to close here. Separately,
  the projection **inherits the visibility of the acts it reads** — team-wide today (no message-content
  need-to-know is enforced yet; the "acts addressed to them" scoping in `security.md`/`membership-model.md`
  is still aspirational). A derived report is *more legible* than the raw log, so the surveillance-asymmetry
  caution binds it **more** tightly: the insight layer must not ship a human-bottleneck view with wider
  reach than the raw acts already have, and derived-human-metric governance stays a **hard prerequisite**
  for anything past localhost.

## Observability & Evaluation

The lane-native evals promised in ADR 083 (% closed via resolve/auto-merge vs abandoned, handoffs
carrying a branch vs prose) become *per-Goal* slices once `goal_id` lands — the first honest answer
to "what did this Goal cost in waste?" short of the deferred cost-per-item metric. The A/B posture is
unchanged: the P3 session is the baseline; the first lanes+goals dogfood measures whether derived
Goal status matches reality without a single hand-flipped status field.
