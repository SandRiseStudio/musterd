# 068 — Workspace-scoped single-active: stop the seat from flapping on health-check probes

- Status: accepted
- Date: 2026-06-29

## Context

Agent seats are single-active, newest-wins (ADR 017): a fresh `hello` from the same identity displaces
the prior live session (sends it a `superseded` error, closes it) so a reloaded/orphaned adapter can't
lock an agent out of its own seat. This assumed each `hello` is a *real* new session.

A 2026-06-29 dogfood disproved that. A running agent (Jasmine, autojoined via `MUSTERD_AUTOJOIN=1`) kept
getting superseded "between posts," with status updates only landing on retry. The daemon log showed the
cause: short-lived WS connections opening and closing within milliseconds, each joining as Jasmine and
bumping the live session. The trigger is that **Claude Code spawns the stdio MCP server transiently** —
its periodic MCP health checks (~90s), and `claude mcp get musterd` (which the ADR 060 SessionStart hook
runs) — and with autojoin enabled *every transient spawn joins as the agent and, under newest-wins,
displaces the real session*, then disconnects. The seat flaps; the real session must rejoin on its next
action. No data is lost (the inbox is durable), but presence churns and posts retry.

The key realization: a transient probe and the live session share the **same workspace** (same folder /
binding / git branch). Newest-wins should fire for a *genuinely different* session (another machine, a
real reload), not for the same seat's own probe.

## Decision

- **Scope agent single-active displacement by workspace** (`ws.ts` hello path). On an agent `hello`, only
  displace existing live connections whose `workspace` **differs** from the incoming one. A same-workspace
  hello is the same seat reconnecting (reload or health-check probe) and must **not** supersede the live
  session. A client that sends no workspace falls back to the old displace-all behavior (compatibility).
  - Connections now carry `workspace` (`hub.ts`), set from the hello.
  - Only the displaced connections' presence rows are cleared (`clearPresenceById`), plus orphaned
    held/disconnected rows (`clearOrphanPresence`) — never the live same-workspace presence we keep.
- **Cross-workspace newest-wins is unchanged** (ADR 017): a hello from a different workspace still takes
  the seat, so a real reload or a second machine displaces correctly and no agent is locked out.

## Consequences

- The seat stops flapping under health-check probes; an autojoined agent stays live and its posts land
  without retry. The original lockout-prevention (a real new session takes over) still holds across
  workspaces.
- Two same-workspace sessions (e.g. two windows on one worktree) now *coexist* instead of waging a
  supersede war — strictly less disruptive, and the discouraged setup anyway (one session per worktree;
  ADR 065 gives each agent its own).
- Residual, accepted: a transient probe still briefly attaches a same-workspace presence (a small
  dashboard flicker) before it disconnects — harmless now that it never supersedes. The ADR 060 hook's
  `claude mcp get` keeps its registration-check robustness; its server-spawn side effect is now benign.
- Composes with ADR 017 (newest-wins), ADR 042 (kind-scoped: humans still fan out), ADR 057 (ambient
  presence's "no-op under resident session" is the same instinct, now applied to join), ADR 064 (the idle
  reaper still sweeps true orphans), and ADR 065 (per-agent worktrees make "same workspace = same seat" hold).

## Observability & Evaluation

**Traces** — the relevant spans already exist in the daemon log: `ws_hello` / `ws_close` (connect churn)
and the `superseded` error frame. The fix is observable as the *absence* of `superseded` for
same-workspace reconnects; a future presence span should carry `workspace` and a `displaced_by_workspace`
boolean so the trace distinguishes a real takeover from a same-seat reconnect.

**Eval** — success metric: `superseded` frames sent to a live agent **per hour of continuous session**,
which should fall to ~0 for a single-session seat under normal health-check probing. **Dataset**: the
daemon logs across dogfood sessions (the 2026-06-29 Jasmine run is the labeled failing case — repeated
ws_hello→ws_close→supersede cycles). **Baseline**: pre-068, where each ~90s health-check probe produced a
supersede; post-068, zero for same-workspace. Unit coverage: `integration.test.ts` asserts a
same-workspace hello does *not* supersede while a different-workspace hello still does.

**Experiment** — none built yet, but named: once batond exists, compare seat-stability (supersedes/hour,
posts-needing-retry) for autojoined agents before/after 068 across seeded long-running sessions — does
workspace-scoping eliminate the flap without regressing the real-reload-takeover case?
