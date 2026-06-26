# 057 — Ambient agent presence (liveness from real actions)

- Status: accepted — implemented 2026-06-25
- Date: 2026-06-25

## Context

Presence today is earned by holding a **resident WebSocket session**: `musterd inbox --watch` opens a
socket, sends a `hello`, and heartbeats every 15s, which keeps a `presence` row fresh and the member
`online` on the roster. The reaper frees a row once its `last_seen_at` ages past `presenceTimeoutMs`
(45s), or once a release hold's grace expires (ADR 010).

That model fits a human parked in a terminal, but not an agent doing **bursty one-shot CLI work**. An
agent that runs `musterd send`, does some coding, then runs `musterd inbox` a minute later never opens a
socket — each command is a stateless HTTP request that authenticates and exits. So a demonstrably-active
agent reads `○ offline` on the roster the whole time, even mid-task. The 2026-06-25 dogfood made this
concrete: a fresh seat handed real work showed offline to teammates because it was working through
one-shots, not watching a socket. Liveness was tied to _connection_, not _activity_.

This is a load-bearing gap for the Human ↔ agent loop: an agent that reads offline can't be reasoned
about ("is anyone home on that seat?"), and downstream features (Wake on message, the blocked-agent
push) assume the roster reflects who is actually doing things.

## Problem

Make presence reflect **recent authenticated activity**, so a bursty one-shot agent reads present
between watch sockets — without (a) inventing a second liveness clock, (b) flooding the `presence` table
with a row per command, (c) disturbing the resident-WS session or ADR 017 newest-session-wins, or (d)
muddying the `working: <x>` label, which must keep coming **only** from a self-reported `status_update`
(the two-clocks rule, ADR 010).

## Decision

### 1. A short-TTL ambient presence touch on each authenticated command

Every authenticated command the daemon serves over HTTP (`send`, `inbox`, `inbox/cursor`,
`availability`, operator `reclaim`/`remove`) writes an **ambient presence touch** for the _caller_
after auth succeeds: a connectionless `presence` row (`conn_id = NULL`) with `last_seen_at = now`. The
roster's existing liveness filter then reads the member present for `presenceTimeoutMs` after its last
command — its activity within the last window — and the reaper flips it offline when that window passes.

There is **no new TTL constant**: ambient liveness reuses `presenceTimeoutMs` (45s, env-tunable via
`MUSTERD_PRESENCE_TIMEOUT_MS`). One liveness clock for the whole system keeps the roster honest and the
semantics teachable — "present means active within the last 45s," whether that activity is a heartbeat
or a command.

### 2. Upsert, not append — one ambient row per member

The touch is an **upsert**, never an insert-per-command: it refreshes the member's existing
connectionless, non-held `presence` row (or creates one if absent). A thousand one-shots leave a single
ambient row, not a thousand to reap. This is the key difference from the explicit stateless `POST
/presence` ping (which deliberately attaches a fresh row per call); the explicit ping keeps its existing
behavior and is **not** ambient-touched (it already declares its own presence).

### 3. No-op when a resident session already owns liveness

If the member already holds a **live connected** presence (a real socket, `conn_id IS NOT NULL`), the
ambient touch is a no-op. A watching agent's WS heartbeat already owns its liveness; ambient presence
must not add a competing second row or muddy the surface list. Ambient presence is precisely the
_fallback_ that fills the gap when there is no socket — matching the roadmap framing ("reads as offline
_until_ it opens a watch socket").

### 4. Ambient touch never displaces — newest-session-wins stays the only eviction path

The touch only ever writes its own connectionless row; it never closes a socket, never calls
`clearMemberPresence`, and never sends a `superseded` frame. So a one-shot command from one surface can
**not** evict an agent's resident watch session on another — displacement remains exclusively the WS
`hello` path (ADR 017). And because a real `hello` clears an agent's rows before attaching (kind-scoped
single-active, ADR 042), opening a watch socket cleanly absorbs any stale ambient row. The two
mechanisms compose without a special case.

### 5. The working-label clock is untouched

Ambient presence moves only the **liveness** clock. The `working: <x>` label still resolves solely from
the latest `status_update` (the two-clocks rule, ADR 010 / activity resolver). An agent that runs
one-shots without ever posting a status reads `online` (present, no reported task), not `working` — and
a touch never invents or clears a status. This is why the standing dogfood nudge pairs a one-line
`status_update` with finishing a unit of work: the command flips you present (ambient), the status flips
you `working`.

### 6. Live watchers see the transition

When a touch flips a member from no-live-presence to present (an offline→online transition), the daemon
broadcasts the same `{ type: 'presence', member, status: 'online' }` event the WS attach path emits, so
`inbox --watch` rosters update live rather than waiting for a poll. The reaper already emits the
matching `offline` when an ambient row expires (its `held_until` is null, so it counts as a real
state change, not a grace-hold expiry). Provenance is stamped `session` — a one-shot command genuinely
has the agent's session behind it (ADR 014); surface defaults to `cli` but honors an optional
`x-musterd-surface` request header so an MCP/adapter one-shot can label its real surface.

### 7. Background pollers opt out (the notifier)

A read carrying `x-musterd-no-touch` skips the touch. This exists for the notifier (`musterd notify`,
ADR 035), which polls a member's inbox **on their behalf** while they are away: without the opt-out, the
notifier's own poll would mark the human present, `isReachable` would then see them online, and the
notification it was about to fire would silence itself — a regression caught the day ADR 057 landed. The
`notify` command issues its inbox/roster reads through a presence-neutral client; every other client
touches as normal.

## Consequences

- A bursty one-shot agent reads `online` (or `working`, with a status) on the roster, closing the
  "active but shows offline" gap — liveness from real actions, exactly the Wave 1 item.
- No schema change, no new wire frame, no new timeout knob: an additive server-side write on the
  existing authenticated chokepoint, governed by the existing presence timeout and reaper.
- The `presence` table stays bounded (one ambient row per member, upserted), and the explicit
  `POST /presence` ping, resident-WS sessions, ADR 017 displacement, and ADR 042 human fan-out all keep
  their current semantics.
- Unblocks **Wake on message** (ADR 054) and pairs with the **blocked-agent push** (ADR 053): both
  assume the roster reflects who is actually doing work.
- Builds on ADR 010 (two-clocks rule, reclaim grace), ADR 014 (provenance), ADR 017 (newest-session-wins),
  ADR 042 (kind-scoped single-active).

## Alternatives considered

- **A separate, shorter ambient TTL.** Rejected: a second liveness clock makes "why is this seat
  online?" depend on _how_ it last signaled. One window (`presenceTimeoutMs`) is simpler and honest.
- **Touch inside `authMember`.** Rejected: `authMember` is a pure store lookup with no config/timeout or
  hub access; the touch needs both (timeout to compute the transition, hub to emit). The HTTP layer is
  the right seam, and a single `authTouch` helper keeps the call sites uniform.
- **Insert a row per command and let the reaper mop up.** Rejected: bounded only by the reaper interval,
  this lets a tight loop accumulate dozens of rows; the upsert keeps it at one.
- **Agents only.** Rejected: a human running a one-shot `musterd` command is just as present; the touch
  is kind-agnostic and composes with human fan-out (ADR 042). Availability (`away`/`dnd`) is a separate
  axis and is left untouched — "present but away" stays expressible.
