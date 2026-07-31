# 199 — Dispatch-loop wake: handoff + continuation work-orders (ADR 179)

- Status: accepted
- Date: 2026-07-31
- Builds on: [ADR 179](179-board-triggered-work-order-wakes.md) (the dispatch loop this
  implements), [ADR 191](191-review-loop-wake.md) (work_order derivation + dual toggles),
  [ADR 131](131-harness-residency-wake-ledger-host.md), [ADR 166](166-session-liveness-by-enumeration.md),
  [ADR 192](192-outcome-acceptance.md) (lane state vocabulary).
- Lane: `01KYX061KXZ0TZBKPWSF0N7P4M`

## Context

ADR 179 decomposes the automatic day into composable scoped loops. The review loop shipped
as ADR 191 (dark). Dispatch — wake the **lane owner** to work a claimed lane — is the chaining
primitive: a handoff or a clean session end should start the next coding session without a
human paste ritual. Today a `lane_handoff` already enters the wake ledger as act `handoff`, but
only as a reply-only doorbell; the continuation edge (board-owned lane, no triggering act) does
not exist at all.

## Problem

1. A handoff to an offline `flow: auto` seat wakes a thin reply session, not a seat-policy coding
   session with a lane-id work order.
2. An owner who ends cleanly while still owning a `claimed`/`active` lane is never woken — and
   after a clean exit the enumerated liveness path treats a still-warm transcript as `live` for
   up to 10 minutes, which would veto the wake even once derived.

## Decision

### 1. Toggles (defaults off — the trust ramp)

- Per-team `loops.dispatch: boolean`, default `false`.
- Per-seat `flow: 'manual' | 'auto'` (unchanged from ADR 191).

A dispatch work-order fires only where **both** agree. Inbox reply wakes for seats that stay
`flow: manual` are unchanged.

### 2. Handoff edge (increment 1 — no nullable act)

When `loops.dispatch` ∧ `flow: auto` ∧ cooled: unanswered directed `handoff` messages carrying
`meta.lane_handoff.lane`, whose lane is still owned by that seat and not awaiting acceptance /
terminal, lease as `derivation: 'work_order'` with `lane_id`, `tool_policy: 'seat-policy'`,
`bounds.timeout_ms: work_timeout_ms`. Composed line (injection bar — id only):

> lane `<id>` is yours — orient via `team_next` and begin

Plain `request_help` and non-lane handoffs stay reply doorbells. Prefer dispatch handoff
work-orders ahead of inbox candidates (same starvation rule as ADR 191 review).

### 3. Continuation edge (increment 2 — schema bite)

When the same toggles agree: an enrolled offline seat that owns a lane in `claimed` or `active`
(not `blocked`, not awaiting acceptance, not terminal), under caps, with **no triggering act**,
derives a work-order wake.

- Protocol: `WakeOrder.act_id` / `act` / `sender` optional when `derivation === 'work_order'` and
  `lane_id` is present; otherwise still required.
- DB (v28): `wake_leases.act_id` nullable; additive `wake_leases.lane_id` for board-derived rows.
- Rate / exhaustion: key on `act_id` when present, else `lane:<lane_id>` (written into audit
  `detail.act` on lease/report so existing counters keep working).

### 4. Host timeout for work-orders

For `derivation === 'work_order'`, the host **does not clamp** below `order.bounds.timeout_ms`
(the seat's `work_timeout_ms`). Reply wakes keep the operator `--timeout` ceiling. Log when the
work-order timeout exceeds the host flag.

### 5. Ended-cleanly outranks transcript mtime (deciding path)

In `localSessionLiveness`, when enumeration decides `live` but the binding session has
`ended_at` **and** the enumerated live session id is that same session, use the slot's non-live
verdict (`resumable` / `gc-expired`). A *different* live session beside an ended capture stays
`live` (ADR 166 guardrail preserved).

Daemon-side end attestation remains open (ADR 179); this increment is host-local only.

### 6. CLI knobs

`musterd residency on|policy` accepts `--flow manual|auto` and `--work-timeout <duration>` so
ops can flip without raw policy JSON.

### 7. Deliberately out of scope

- Merge loop.
- Enabling `loops.dispatch` on dogfood (owner smoke after land).
- Auto-pick from unowned open lanes.
- Hard spend kill on `budget_usd`.
- Per-derivation rate-cap split beyond the exhaustion key above.

## Consequences

- Protocol: `Policy.loops.dispatch`; optional WakeOrder act fields for board work-orders; residency
  CLI exposes `flow` / `work_timeout_ms`.
- Defaults keep every team bit-identical until an admin flips both knobs.
- ADR 179 stays the umbrella (still proposed); this ADR is the accepted increment, mirroring 191.

**Scope limit — presence-live is the upstream veto, and "parked" is not a state (recorded
2026-07-31, decision unchanged).** §5 governs a seat whose session **ended** while its transcript is
still warm. It is not reachable for a session that is merely idle, because `claimWakeLeases` vetoes
on `hasLivePresence` (step 2, `packages/server/src/store/residency.ts`) **before** the local-session
snooze (step 3b) and long before any `ended_at` read. The MCP adapter heartbeats presence every 15s
(`HEARTBEAT_MS`, `packages/mcp/src/client.ts`) for as long as the harness **process** is alive — so
presence measures process aliveness, never attention.

Two consequences worth stating outright, because a careful reading of §5 alone suggests otherwise:

- **The continuation edge only ever serves seats whose harness process is gone.** A live-but-idle
  seat is reachable by the ADR 088 interrupt line, not by a wake. That is coherent — you do not
  spawn a session beside a session — but it is not deducible from §5.
- **An agent cannot make itself wake-eligible from inside its own session.** Announcing "parked" in
  a `status_update` is a social convention with no system representation; the seat stays
  presence-live until the process exits. Any exercise that needs a genuinely wakeable enrolled seat
  needs that seat's session **closed**, not merely idle.

Measured on 2026-07-31 (dolly's handoff-edge exercise, lane `01KYX37RKH`): a seat that reported
parking twice held presence continuously (sampled age 4/14/9/4/14s against a 45s timeout) with
`ended_at` unset, while its transcript went 19 minutes cold — past `LOCAL_SESSION_LIVE_MS`, so the
mtime guard would already have passed. The veto was presence, not mtime and not `ended_at`. The
hook path itself is sound: a sibling seat's binding carried `ended_at` from a real SessionEnd in the
same window, and the only bindings missing it were the four whose sessions were open. No code change
followed: the behaviour is correct, the documentation was not.

## Observability & Evaluation

- **Traces.** `residency.wake_leased` / `woke` / `wake_failed` carry `detail.derivation:
'work_order'` and `detail.lane_id`; continuation rows use `detail.act = lane:<id>` when
  `act_id` is null.
- **Eval.** Baseline: handoff → batched reply doorbell (pre-this). Success after enable: a
  `lane_handoff` to an offline `flow: auto` seat under `loops.dispatch` produces a seat-policy
  work-order lease that reaches `occupied`, and a clean session end on an owned claimed lane
  produces a continuation lease without a 10-minute defer veto.
- **Experiment.** Flip `loops.dispatch` + one enrolled seat to `flow: auto`; leave siblings
  manual. Pre-register: does chaining cut manual session starts without ugly wake spend?
  **Setup precondition (learned 2026-07-31):** the target seat's session must be genuinely
  **closed**, not idle — see the §5 scope limit. On a machine where every enrolled seat is in
  active use, the eligible set is empty by construction, and the exercise cannot run at all until a
  seat exits or a non-dogfooded seat is enrolled.
