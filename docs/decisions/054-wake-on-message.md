# 054 — Wake on message: a blocking inbox-wait primitive and the `/loop` idiom

- Status: accepted — implemented 2026-06-29
- Date: 2026-06-25

## Context

In the 2026-06-25 two-agent dogfood, an operator asked one agent: _"can you poll, and as soon as a
message arrives from the other agent, start your work?"_ The agent reached for `/loop` — a Claude
Code skill that re-invokes a prompt on an interval (or self-paced) — and bolted inbox-polling onto
it. It worked, but it is a workaround for a missing first-class primitive.

Two problems with poll-on-a-timer as the only answer:

- **It burns turns.** Each tick re-enters the model to run `musterd inbox` and find nothing.
- **It is latency-vs-cost bound.** Tight interval = wasted turns; loose interval = a teammate's
  message waits out the gap.

What an idle-but-free agent actually wants is to **block until a message arrives** and resume
immediately — which the daemon can already do (it holds the watch WS and knows the instant a directed
act lands), but the CLI exposes no blocking primitive for it.

This is the **free-agent** case. It is the complement of ADR 053, not a substitute: `/loop` and a
blocking wait both need the agent's loop to be _running_, so neither reaches an agent **blocked on an
approval prompt** — that is ADR 053's job (push delivery through the human at the prompt). 054 makes
the _waiting_ efficient; 053 makes the _blocked_ reachable.

## Problem

Give an agent that has nothing to do right now a way to wait for its next directed act **without
polling** and resume the moment one arrives — riding the existing watch transport, no wire change —
and make the recommended wake pattern discoverable so a fresh agent doesn't have to invent it.

## Decision

### 1. A blocking wait primitive

Add `musterd inbox --wait[=<timeout>]` (or `musterd wait`): it opens the existing authenticated watch
WS, blocks until a **directed act for the bound seat** arrives (or the optional timeout elapses),
then prints that act and exits non-zero-on-timeout / zero-on-message so it composes in a shell loop.

- **Rides the watch socket, not a new channel.** The daemon already pushes on the watch WS (the same
  one `--watch` and presence use); `--wait` is a one-shot consumer of it that exits on first delivery
  instead of streaming. No SPEC bump, no server change beyond reusing the push it already sends.
- **Scoped to directed acts by default.** Broadcast journal traffic shouldn't wake a waiting agent;
  `--act`/`--from` filters (the same ones ADR's CLI-ergonomics item adds to `inbox`) narrow it
  further. Composes with the durable cursor so a message that arrived _during_ startup isn't missed.
- **Composes with `/loop`.** The intended idiom becomes `musterd inbox --wait && <do the work>` under
  a harness re-invoker — block cheaply, act on wake — instead of a timed poll that mostly finds
  nothing.

### 2. The `/loop` idiom in the primer

Document the wake pattern in the `AGENTS.md` primer (ADR 012) so it is **standing context**, not a
thing each operator must rediscover: a short "to wait for the next message, run `musterd inbox
--wait`; under a harness loop, pair it with `/loop`" note in the managed block. The primer already
teaches the working-loop; this adds the _idle_-loop.

### Why a primitive and not just docs

The blocking read is the part the CLI can't express today and the part that removes the turn-waste;
documenting `/loop` alone would bless the workaround without fixing its cost. Ship the primitive, then
point the primer at it.

## Open questions

- **Spelling.** `inbox --wait` (keeps one inbox surface) vs a top-level `wait`/`next --wait`. Lean
  `inbox --wait` for discoverability beside the thing it reads.
- **Timeout default.** Block forever (pure event-wait) vs a default bound so a dropped socket can't
  hang a shell loop. Lean: default-bounded with a clear timeout exit code; `--wait=0` for unbounded.
- **Reconnect.** If the watch WS drops mid-wait, reconnect-and-resume from the cursor vs exit and let
  the outer `/loop` re-enter. Lean on the latter — keep the primitive a clean one-shot.

## Resolved as built (2026-06-29)

- **Spelling.** `inbox --wait` — kept on the one inbox surface, beside the thing it reads.
- **Timeout.** Default-bounded at 300s with a clear timeout exit code (`124`, mirroring coreutils
  `timeout(1)`); `--timeout <seconds>` overrides and `--timeout 0` waits unbounded. Exit `0` only on a
  directed act, so a shell loop can tell "woke on a message" from "nothing yet".
- **Reconnect.** Kept a clean one-shot: a dropped/refused socket exits with the timeout code and lets
  the outer `/loop` re-enter, rather than reconnecting internally.
- **Startup race.** Before opening the socket, `--wait` drains the durable inbox and wakes immediately
  on the earliest unread directed act — so a message that landed just before the wait isn't missed.
- **Scope.** Wakes on acts **directed to this seat** (not broadcast journal traffic), never the seat's
  own echo; `--from`/`--act` narrow further. `--json` prints the raw envelope for scripting.

## Consequences

- An idle agent waits for work without burning turns and resumes on the message instead of on the
  next tick — the efficient form of the pattern the dogfood improvised.
- The recommended idiom ships as standing context, so the next fresh agent doesn't reinvent it.
- Strictly the free-agent complement to ADR 053; the two together cover both "waiting" and "blocked,"
  which the `/loop` workaround conflated.
- Builds on ADR 012 (primer), the watch transport / ambient-presence item (shared WS), and the
  CLI-ergonomics `--act`/`--from` filters.
