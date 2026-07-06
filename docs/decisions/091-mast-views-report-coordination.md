# 091 — Telemetry Layer 2, increment 3: the MAST-aware views + `report coordination`

- Status: accepted
- Date: 2026-07-06

## Context

ADR 089 froze the Layer 2 arc; increments 1 (the client telemetry SDK, #111) and 2 (the derived
per-recipient delivery ledger, ADR 090, #114) are on main. What remains is the arc's original
motivation: finding 002 produced four real insights **by hand-grepping a text log** — the act-mix /
broadcast-journal split, one ignored `request_help`, an ~70 h unclosed loop, the absent human. MAST
(arXiv 2503.13657) names these failure classes — _ignored agent input_, _coordination breakdown_
(stalled threads, step repetition, circular handoffs) — and `observability.md` §5b has promised them
as **derived views over the message log, never stored beside it** since the strategy doc was
written. The substrate now exists: coordination-density (ADR 050) covers the act-mix lens, and
inc2's open directed ledger is per-act ignored-input data. Nothing yet computes the thread-shaped
views or serves the whole picture as one surface.

## Problem

Serve finding 002's queries as one first-class projection — _is this team's coordination healthy,
and where exactly is it breaking?_ — without storing any derived state, without a new wire frame,
and without turning diagnostics into performance scores (`human-agent-dynamics.md` §4 applies in
full: these instruments name failure shapes, never rank members).

## Decision

One new derived block on the existing report projection (ADR 050's seam — computed server-side
once, rendered everywhere), plus a CLI verb to read it. No migration, no SPEC bump, no new acts.

### 1. `store/mast.ts` — three thread-shaped views (the ones nothing computes today)

All windowed (7 days, matching coordination-density) and derived per query:

- **Time-to-unblock** — over loops _closed_ in the window (an `accept`/`decline` naming a
  `request_help`/`handoff` via `meta.in_reply_to`, or a `resolve` closing its thread root): count,
  median and p95 of close-ts − open-ts. The lived counterpart of the emitted `loop_latency`
  histogram — computable retroactively from the log, no collector required.
- **Stalled threads** — MAST's coordination-breakdown shape: a thread with ≥ 2 acts, no `resolve`,
  and no activity for 24 h. Reported as {thread, last act, participants, age} — the "everyone
  walked away" detector.
- **Circular handoffs** — within one thread, a `handoff` whose recipient already sent or received
  an earlier handoff in that thread (A→B→…→A). Step-repetition made visible; count + the threads.

The remaining two §5b lenses are already served and are **referenced, not recomputed**: act-mix /
broadcast-share is `coordination` (ADR 050), and ignored `request_help` is the `open_directed`
ledger filtered to `request_help` older than 1 h (ADR 090) — the report's `mast` block carries that
filter's result as `ignored_help` so the reader gets MAST's ignored-input lens without a second
derivation drifting from the ledger.

### 2. The surfaces

- **Report payload** gains `mast: { window_days, time_to_unblock, ignored_help, stalled_threads,
circular_handoffs }` — one projection, every client renders the same truth.
- **CLI:** `musterd report coordination` — the coordination-health page: the density line (ADR
  050), time-to-unblock, ignored help, stalled threads, circular handoffs. `--json` for scripts.
- **MCP:** `team_report` renders the mast block when anything is noteworthy (a stalled thread, an
  ignored ask, a circular chain) — silent when healthy, so the common case costs no context.
- **Web:** deferred to the insight-board roadmap item — the projection is now on the payload, so
  the dashboard renders it whenever that lands; nothing here blocks on it.

## Consequences

- The Layer 2 arc closes: finding 003-style analysis becomes `musterd report coordination` instead
  of an afternoon of `grep` — and the roadmap's telemetry-l2 entry ships whole.
- Everything stays derived: the report is still computed from `messages` + lanes + cursors + audit
  on demand. Cost is bounded by the 7-day window and per-team scoping.
- The MAST detectors become batond's first coordination-native views and the labeled shapes the
  coordination-traces dataset (ADR 056) needs — detector output over real traces.
- Thresholds (1 h ignored, 24 h stalled) are constants, not config — deliberately opinionated until
  dogfood data argues otherwise; changing them is a one-line diff, not a settings surface.
- Goodhart guard: the block reports shapes and queues (threads, ages, chains), never per-member
  throughput; `time_to_unblock` is a team distribution, not a leaderboard.

## Observability & Evaluation

**Traces** — no new emission: this increment is pure read-model over data Layers 1–2 already emit
and store. The views' inputs (loop closures, cursor advances, interrupt raises) are all first-party
series already.

**Eval** — the guard metric: `mast.time_to_unblock` computed from the log must be consistent with
the emitted `musterd.coordination.loop_latency` distribution over the same window (two derivations
of one truth, the ADR 090 pattern). Headline: on the dogfood team, the finding-002 pathologies
(ignored ask, ~70 h loop) must surface in `musterd report coordination` with zero hand-grepping —
the acceptance test is re-running finding 002's analysis as one command.

**Experiment** — the coordination-density A/B extends: run a two-agent task with and without the
lanes/interrupt features and diff the mast block (stalled-thread count, time-to-unblock) — the
flywheel's first team-topology comparison reading entirely off `report`.
