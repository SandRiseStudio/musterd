# 108 — Probe-safe autojoin: defer the launch claim to the first tool call

- Status: proposed
- Date: 2026-07-08
- Builds on: ADR 032 (claim-on-first-use / launch autojoin), ADR 060 (SessionStart verify runs
  `claude mcp get musterd`), ADR 068 (workspace-scoped displacement), ADR 092 (durability-gated
  same-workspace eviction — the previous attempt at this symptom)

## Context

The dogfood seat `miley` kept getting superseded mid-task — three times in one day — with
`superseded: your session as "miley" was taken over by a newer one`. This is the long-running
"reload-orphan / seat ping-pong" symptom (issue #118 territory) that ADR 068 scoped displacement to
the workspace and ADR 092 durability-gated, without fully killing it.

Root cause, traced end-to-end through the daemon audit log and live process table:

1. The MCP adapter ran its **autojoin at process boot** (`main()` → `await autojoin(...)` right after
   the stdio transport connected).
2. `claude mcp get musterd` **launches the adapter to health-check it** (it reports
   `Status: ✔ Connected`), completes the MCP `initialize` handshake, and exits.
3. So every such probe fired a **real one-shot claim**: `ws_claim_occupied` for the folder's seat,
   socket closed 2–80 ms later. Same workspace ⇒ ADR 068 displacement ⇒ the _live_ session in that
   folder was superseded by a claimant that was already dead.
4. Probe sources are everywhere: the ADR 060 **SessionStart verify hook** runs `claude mcp get
musterd` on every session start in a bound folder; `musterd doctor` / `init --check` detect via
   the same probe; and the CLI test suite's non-hermetic `claude detect` test ran it from the repo
   root — which is itself a bound dogfood workspace, so **every full test run displaced the live
   seat** (the observed 3-supersessions-in-a-day were all test runs).

ADR 092 could not fix this: it gates the _reaping of the predecessor connection_ on the successor
proving durable, but the _occupancy_ still transfers to the new claim immediately — a moribund
claimant displaces first and dies after.

## Problem

A health probe must be **side-effect-free**: launching the adapter to ask "are you wired?" must not
mutate who holds the seat. At the same time, launch autojoin (ADR 032) must keep working — a real
session should come online without an explicit `team_join`.

The boundary that separates the two is tool calls. A probe completes `initialize` and exits; it never
calls a tool. A real session's first act _is_ a tool call — the SessionStart hook instructs
`team_inbox_check` immediately.

## Decision

1. **Defer the launch autojoin to the first tool call.** `buildMcpServer` accepts an
   `onFirstToolCall` hook; `main()` passes the autojoin there instead of awaiting it at boot. The
   hook is armed by patching `registerTool` (the same choke point the ADR 089 telemetry wrapper
   uses), fires once, memoized, before the first tool handler runs — inside that tool's span, so the
   join latency it causes is attributed to the call that triggered it.
2. **Exempt `team_join` and `team_leave`.** An explicit join supersedes the implicit one (firing both
   would claim twice); a leave must never cause a join.
3. **Make the CLI's `claude detect` test hermetic.** It now probes the real `claude` CLI from a temp
   cwd, where no local-scope musterd registration exists — the probe exercises the real binary but
   can never launch the real adapter against the production daemon. (Belt to the adapter's braces: a
   test suite must never touch a production daemon regardless.)
4. **Hook copy updated.** The SessionStart orientation now says the seat "auto-claims on your first
   `team_*` tool call" instead of "auto-joined on launch", and asks for `team_inbox_check` — which is
   the call that joins.

Also fixed while verifying (same disease, second organ): the new probe-safety tests initially wrote
`.musterd/binding.json` into the **real repo root** via `persistBinding`'s `process.cwd()` — the test
suite clobbered the live dogfood binding (team/seat/server all wrong, stale key). The suite now pins
`process.cwd()` to a temp dir, and the binding was repaired. Tests that reach workspace state through
ambient cwd are exactly how this whole class of bug leaks.

## What we are explicitly _not_ doing

- **Not** restoring the predecessor when a same-workspace successor dies within a grace (a server-side
  "moribund-claim heal"). A one-shot `musterd claim` from a terminal is a _legitimate_ claim that must
  hold the seat after its socket closes; the server cannot distinguish it from a probe. The fix
  belongs at the source: probes must not claim at all.
- **Not** changing the protocol, the claim frame, or displacement semantics (ADR 068/092 stand).
- **Not** removing `MUSTERD_AUTOJOIN` or the pending-marker/resolution-watcher flow for unclaimed
  sessions — unchanged, still boot-time (they claim nothing).

## Consequences

- Health probes (`claude mcp get`, SessionStart verify, doctor, `init --check`) become
  side-effect-free: verified live — the fixed adapter completes a full `initialize` against the
  production daemon with **zero** claims logged, and the same simulation with a `tools/call` fires
  the deferred join exactly once.
- The supersession ping-pong's dominant source is gone; a live seat is no longer displaced by its own
  folder's probes or test runs.
- The roster shows a new session a few seconds later than before (first tool call instead of boot) —
  in practice immediately, since the SessionStart hook's first instruction is `team_inbox_check`.
- A session that never calls a tool never joins — which is the correct reading of "claim-on-first-use"
  (ADR 032): presence should reflect _acting_ sessions, not booted processes.

## Observability & Evaluation

- **Traces:** no new spans. The deferred autojoin runs inside the first `musterd.tool.call` span
  (ADR 089), so its latency is visible on exactly the call that paid it; probe launches now produce
  no daemon writes at all (the absence is the signal — `ws_claim_occupied` with a <100 ms lifetime
  was the bug's fingerprint and should disappear from the daemon log).
- **Eval:** dataset = the daemon log + audit table on the dogfood machine (the `claim.occupied`
  bursts correlated 1:1 with test runs and session starts). Baseline = pre-fix: every
  `claude mcp get musterd` in a bound folder produced a claim-and-close within ~80 ms and displaced
  the live seat (3 supersessions in one day). Score: count of sub-100 ms one-shot `miley` claims per
  day after the fix — expected zero from probe sources.
- **Experiment:** the before/after simulation in this ADR's verification — spawn the adapter, drive a
  bare `initialize` (probe) vs `initialize` + `tools/call` (session) over stdio against the live
  daemon, and diff the daemon log. Pre-fix the probe claims; post-fix only the tool call does.
