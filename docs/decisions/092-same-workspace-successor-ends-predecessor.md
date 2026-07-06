# 092 — A same-workspace successor ends its predecessor (durability-gated), and a replaced adapter exits

- Status: accepted
- Date: 2026-07-06

## Context

A dogfood failure (#118, 2026-07-06, twice in one session): the `stanley` seat on `revive`
ping-ponged between two live adapter processes for the same workspace (`/Users/nick/agents-stanley`).
A host (Claude Code) MCP-server reload spawned a replacement **without closing the predecessor's
stdin**, so `installShutdownHandlers` never fired and the old `packages/mcp/dist/index.js` stayed
alive and connected. The daemon audit showed `claim.occupied stanley` every ~30–60s and the working
session repeatedly saw `superseded: your session as "stanley" was taken over by a newer one` at its
next send. Manual remediation each time was `ps` → kill the orphan → `team_join` again.

Two decisions collide here:

- **ADR 017** (newest-wins): a fresh claim displaces the incumbent, sends it `superseded`, closes it.
- **ADR 068** (workspace-scoped displacement): a *same-workspace* claim must **not** supersede the
  live session, because Claude Code spawns the stdio server transiently for ~90s health checks and
  `claude mcp get`, and each transient spawn auto-claims. Without scoping, every probe flapped the
  seat. ADR 068's accepted consequence was that "two same-workspace sessions now coexist instead of
  waging a supersede war."

That coexistence is exactly why the orphan survives: a genuinely-replaced predecessor and a
transient probe are indistinguishable at claim time, so ADR 068 keeps **both** the orphan and its
successor alive. The seat then has two claimants, and a dormant orphan with no host attached has no
purpose — it only fights.

## Problem

Reconcile two truths that were both correct in isolation:

1. A same-workspace **reload successor** should obsolete its predecessor (the orphan must die).
2. A same-workspace **health-check probe** must never kill the live session (ADR 068's anti-flap).

The only observable difference between a reload successor and a probe is **liveness after the
fact**: a probe disconnects within milliseconds; a real successor stays connected and heartbeats.
The claim moment itself carries no reliable discriminator.

## Decision

**A same-workspace successor ends its predecessor, gated on the successor proving it is durable; a
replaced adapter exits cleanly instead of lingering dormant.**

### 1. Durability-gated same-workspace eviction (server, `ws.ts`)

- Cross-workspace displacement is unchanged (immediate `superseded`, ADR 017).
- On a same-workspace agent claim, the server still does **not** supersede the incumbent at claim
  time (ADR 068 holds). Instead, once the successor has occupied, the server **schedules** eviction
  of the pre-existing same-workspace connection(s) after a short grace window
  (`supersedeGraceMs`, default 5s, `MUSTERD_SUPERSEDE_GRACE_MS`). When the timer fires, eviction
  runs **only if the successor is still connected** (`hub.getConn(successorConnId)` present); each
  still-present predecessor is sent `{ code: 'superseded', same_workspace: true }`, closed, removed,
  and its presence row cleared.
- A transient probe disconnects before the grace elapses, so the gate finds the successor gone and
  does nothing — the incumbent is kept, ADR 068's anti-flap intact. A real reload successor survives
  the grace and cleanly reaps the orphan.
- The HTTP claim path (`http.ts`) is intentionally left displace-all with no workspace scoping — the
  orphan war is the persistent-WS path; the one-shot HTTP claim does not linger.

### 2. A replaced adapter exits (adapter, `client.ts` + `index.ts`)

The `superseded` handler is already terminal (drops presence, does not reconnect). It now
additionally, **when `same_workspace: true`**, invokes an `onReplaced` hook that `index.ts` wires to
the same graceful teardown as shutdown (stop the resolution watcher, close the client, flush
telemetry within the bounded cap) and then `process.exit(0)`. `process.exit` stays out of the
library core — the client only signals; `main()` owns the exit. A **cross-workspace** supersession
keeps today's behavior (dormant, no exit): that is a genuinely different session (another machine /
a different branch) and exiting it is out of scope for #118.

### 3. Reconnect terminality confirmed (ADR 017 conformance, issue direction B)

Audited the re-claim surface: the `superseded` branch sets `wantPresence = false` so
`scheduleReconnect` is a no-op; `startResolutionWatcher` short-circuits while `client.claimed`;
`autojoin` runs once at launch. No path re-`hello`s or re-claims after supersession. Locked with
regression tests; no code change needed beyond the tests.

### 4. Drift detection (issue direction C)

- Server: when the durability gate observes a live same-workspace predecessor, it appends a
  warn-level `claim.duplicate_workspace` audit row so the condition is visible in the daemon log
  even before the eviction fires.
- `musterd init --check`: a best-effort, read-only check warns (a **note**, not exit-1 drift, since
  §1/§2 self-heal) when this seat has more than one live presence sharing its workspace.

### Frame carrier

`same_workspace` is an additive optional boolean on the existing `ErrorFrame` (`frames.ts`), rather
than a new dedicated `SupersededFrame`. It is backward compatible (older adapters ignore it and keep
the dormant behavior) and is the smallest correct change; a dedicated frame was considered and
rejected as a larger protocol churn for one boolean.

## Consequences

- The orphan war ends without regressing ADR 068: a reload reaps its predecessor after a 5s grace,
  a health probe never touches the live seat. The seat self-heals — no more `ps`/kill/`team_join`.
- One residual window: for up to `supersedeGraceMs` after a reload, two same-workspace presences
  coexist (a brief roster flicker), then the predecessor is reaped. Strictly better than the prior
  indefinite coexistence.
- A replaced adapter releases its process slot instead of lingering. Cross-workspace supersession is
  deliberately unchanged; if a dormant cross-workspace orphan ever proves a problem, that is a
  separate, later decision.
- Adds one server timer per same-workspace succession (unref'd, cleared on successor close) and one
  optional config knob. No migration, no new table.
- Composes with ADR 017 (newest-wins across workspaces), ADR 068 (same-workspace anti-flap, now with
  a durability escape hatch), ADR 064 (the idle reaper still sweeps true orphans as a backstop), and
  ADR 060 (`init --check` gains one more read-only drift note).

## Observability & Evaluation

**Traces** — the eviction reuses the existing `superseded` error frame and `ws_close` churn spans;
the new `claim.duplicate_workspace` audit row marks the moment two same-workspace claimants are seen.
The gated eviction is observable as a `superseded` (with `same_workspace: true`) that lands ~`grace`
after a same-workspace `claim.occupied`, versus its absence when the successor was a probe.

**Eval** — success metric: **orphaned same-workspace adapters per session**, which should fall to 0
(the reload successor reaps its predecessor). Guard against regressing ADR 068: `superseded` frames
sent to a live agent **per hour under health-check probing** must stay ~0 for a single-session seat
(the probe disconnects before the grace, so it never evicts). Dataset: the #118 daemon audit
(`claim.occupied stanley` ping-pong 2026-07-06 10:47–10:54) is the labeled failing case; the
integration tests encode both the reap-the-successor and keep-through-the-probe cases. Baseline:
pre-092, indefinite coexistence + manual kill.

**Experiment** — none built; named: once a long-running dogfood harness exists, compare orphan-count
and supersede/hour across seeded reload+probe sequences before/after 092 — does the grace-gated reap
eliminate orphans without reintroducing the ADR 068 flap?
