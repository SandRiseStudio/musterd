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
   the conversational fabric.** ADR 048's "feature → task are depth-labels on *threads*" is amended to
   "depth-labels on *lanes and threads*". The zero-compliance floor survives: a team that never opens
   a lane still gets thread-derived status; a lane simply gives the projection a stronger signal.

2. **The join is an optional `goal_id` on the lane** (additive migration; nullable column, no
   backfill). `lane_open --goal <id>` / the MCP `lane_open` param declare it at task start. This
   mirrors ADR 049's `goal_id` handoff-meta for threads — one stable id, two carriers.

3. **Goal status derivation becomes lanes-first, threads-fallback**, projected over
   `Goals × lanes × threads` (amends ADR 048's rules):
   - `shipped` ← a representative lane `done` (or a resolved representative thread);
   - `in-flight` ← any `claimed`/`active` lane (or an accepted-but-unresolved thread);
   - `planned` ← neither.

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

## Observability & Evaluation

**Traces.** No new spans — this ADR threads `goal_id` through the existing lane/handoff acts (ADR 083),
so the coordination traces it rides on are already emitted; a Goal is just a new grouping key over them.

**Eval.** The lane-native evals promised in ADR 083 (% closed via resolve/auto-merge vs abandoned,
handoffs carrying a branch vs prose) become *per-Goal* slices once `goal_id` lands — the first honest
answer to "what did this Goal cost in waste?" short of the deferred cost-per-item metric. Dataset: the
lanes+goals dogfood act log; baseline: the P3 session.

**Experiment.** The A/B posture is unchanged — the P3 session is the baseline, and the first lanes+goals
dogfood is the experiment: it measures whether derived Goal status matches reality without a single
hand-flipped status field.
