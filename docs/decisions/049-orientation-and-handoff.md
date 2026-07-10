# 049 — Orientation & handoff: `musterd next` / `done`, the derived floor, no copy-paste

- Status: accepted — orientation & handoff shipped (`musterd next`/`done`, orientation-spine arc)
- Date: 2026-06-24
- Amended by: ADR 084 (lanes join the Plan — `musterd done` closes the **lane** when one carries the
  work; thread `resolve` is the lane-less fallback. The load-bearing terminal is lane-`done`, not the
  thread `resolve` act, which is dead in practice, 2/21.)

## Context

Today, handing a unit of work from one agent session to the next is done by a **human hand-writing a
copy-paste prompt** for the new session. That toil is the trigger for the 2026-06-24 planning session.
The pieces to remove it now exist: the reachability loop (ADR 024 comeback summary, ADR 046 agent-side
nudge), the `resolve` terminal signal (ADR 025), and the Plan/Goal model with **derived status**
(ADR 048).

## Problem

Let a **fresh agent self-orient** — what just shipped, what's in flight, what to pick up next, and the
working contract — **without a human-authored handoff prompt**, and do it **robustly even when agents
skip the ritual**.

## Decision

- **`musterd next` (the brief).** A **derived floor** that works at zero compliance: *last shipped* +
  *in flight* read from the act log; *next Goal* = the first un-shipped Goal by `wave`, minus in-flight,
  minus `dependsOn`-blocked (ADR 048). **Enrichment:** the latest `handoff` act → `@team`/`@me` (the
  human-authored *why*), appended when present, never required.
- **`handoff` carries `--meta goal_id=<id>`** — the structured pointer `next` reads back (the conceptual
  rename of `roadmap_id`). The body stays the free-text *why*.
- **`musterd done`** — closes the unit of work (+ optionally post the `handoff` for the next Goal,
  computed via the same derivation as `next`). *(Amended by ADR 084:)* when a **lane** carries the work
  it marks the lane `done` (the reliable terminal that drives derived Goal status); with no lane it falls
  back to `resolve` on the thread. **No status-tick step** — Goal status is derived (ADR 048), so there
  is nothing to forget.
- **Enforcement ladder (day-one rungs):** (1) the derived floor; (2) a **SessionStart hook auto-injects
  `musterd next`** (extends the existing inbox-check hook) — orientation with zero agent compliance;
  (3) an **ADR-046-style nudge** when the agent holds a live, unclosed unit of work
  (`⚑ open lane → musterd done`), self-clearing when it closes. The **load-bearing terminal is a lane
  reaching `done`** *(amended by ADR 084 — originally the thread `resolve` act, but it is dead in
  practice, 2/21; `done`/`resolve` is what `musterd done` emits)*; orientation is auto-injected;
  `handoff` is enrichment, never enforced.
- **Principle on hooks:** they **remind / inject context, never auto-act as the agent.** Auto-posting a
  `resolve`/`handoff` the agent didn't choose would *assert a fact it didn't intend* — against "record
  facts, don't assert" and "one member does the work, the team coordinates." Auto-injecting the *brief*
  on start is context, not an act, so it is fine.
- **Deferred:** a SessionEnd/Stop reminder hook (remind before exit).

## Consequences

- **Kills the copy-paste handoff:** a fresh session self-orients; the human stops being the router.
- **No wire/SPEC change** — rides existing acts + the inbox cursor (like ADR 035/046); `goal_id` is meta
  on `handoff`.
- **Robust to non-compliance:** the floor works with zero handoffs; the `handoff` act only *enriches* the
  brief. Mirrors ADR 046 exactly — the cursor/derivation is the real mechanism, the act is best-effort.
- Depends on **ADR 048** (Goals + derived status) and **ADR 084** (lanes carry the work below a Goal;
  `musterd done` closes the lane). Composes with **ADR 050** (the same derivations feed `musterd report`).
