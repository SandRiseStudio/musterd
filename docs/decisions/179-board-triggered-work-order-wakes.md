# 179 — Board-triggered work-order wakes: the toggleable automatic loop

- Status: proposed — 2026-07-28. Authored by stanley from a brainstorm with nick the same day.
  Number **179** — verified free on `origin/main` (highest is 178) at branch time.
- Date: 2026-07-28
- Builds on: [ADR 131](131-harness-residency-wake-ledger-host.md) (the wake ledger + `musterd host`
  actuator this ADR extends), [ADR 169](169-two-stage-close.md) (`ready_for_review`, verified-ness,
  `pickReviewCounterpart` — the review leg this ADR makes real), [ADR 147](147-the-to-human-ask-stream.md)
  / [ADR 153](153-reachability-gated-hold.md) (asks — the escalation leg, already complete),
  [ADR 048](048-plan-goal-work-item-model.md) / [ADR 049](049-orientation-and-handoff.md) (the
  orientation spine that lets a fresh session self-orient), [ADR 088](088-interrupt-line.md) /
  [ADR 128](128-recipient-scoped-message-reads.md) (the injection bar every composed line honors),
  [ADR 106](106-one-git-workflow.md) (the merge this ADR finally actuates), [ADR 112](112-the-steward-seat.md)
  (the `propose` / `auto-merge` autonomy knob, generalized here), [ADR 158](158-model-attestation-truth.md)
  / [ADR 172](172-model-family-posture.md) (`wake_pool` — the reviewer source), [ADR 166](166-session-liveness-by-enumeration.md)
  (the ended-cleanly signal the continuation wake needs).

## Context

The founder's highest-throughput day to date (2026-07-28: 40 merged PRs, 27 lanes, 190 acts from
four seats) was steered entirely out-of-band: **23 manually started fresh sessions**, ~40 disposable
`web-*` board sign-ins, in-session "check messages" relays, and a merge authorization on every PR —
while he sent **zero** musterd acts. The coordination layer carried the agents' traffic perfectly
and the human's traffic not at all; his load is real, measurable only in its side effects, and
invisible in the tables built to record it.

The target loop — agent starts a task → works, escalating via asks → `ready_for_review` → a
counterpart reviews, plus a human where required → close, merge, clean up → queue the next item →
start it in a fresh session — is **~70% shipped already**. Asks, two-stage close, reviewer routing,
the orientation spine, seat memory, and a production-grade wake actuator all exist. What is missing
is three wires and a repair:

1. **Wake eligibility reads the inbox, never the board.** A wake fires only on a waiting directed
   act; nothing connects "a lane needs a seat" to the actuator.
2. **The wake line is a doorbell, not a work order.** `composeWakeLine` can only say "you have
   mail," and the woken run is reply-only.
3. **The reviewer is never woken.** `pickReviewCounterpart` requires a live counterpart; on the same
   query it computes `wake_pool` — the offline seats that would restore diversity — and returns
   `null` beside it. Result: the review-catch rate is structurally zero (3 of 3 live `lane_ready`
   uses self-closed in seconds with no ask routed).
4. **The rail itself is dead.** The last observed wake run failed 3/3 on an expired `grant_id` and
   exhausted; `wake_leases` had zero rows on the 190-act day.

## Decision

Extend the ADR 131 wake machinery — unchanged in its lease, rate-limit, verify, watchdog, and
reporting layers — with **work-order wakes**: wakes derived from lane state, carrying a lane id,
running under the seat's own tool policy, behind a per-seat toggle that defaults off.

### The toggle

A per-seat residency policy field `flow: 'manual' | 'auto'`, default `'manual'`. At `manual`,
behavior is bit-identical to today. `auto` is opt-in per seat via the existing residency policy
surface (team default ⊕ sparse per-seat override), set by an admin, audited like any policy change.

### The work-order wake

A third wake derivation alongside `immediate` and `batched`, computed in `claimWakeLeases` from lane
state. Its composed line carries the seat, team, and **lane id only** — never the lane title, never
any free text: "lane `<id>` is yours — orient via `team_next` and begin." The board is the work
order; the wake is the doorbell with a lane id on it. This keeps the ADR 128 injection bar fully
intact: no agent-authored text ever enters a spawn prompt.

Work-order wakes run `tool_policy: 'seat-policy'` — the workspace's own permission settings govern,
and the wake path still never passes a skip-permissions flag (ADR 131 §6, asserted by argv tests).
They get their own watchdog knob (`work_timeout_ms`, default 30 minutes — a coding session, not a
reply) and their own rate caps; `budget_usd` stays advisory per the honesty clause (flags, never
kills).

### Increments

**0 — repair the rails** (no design, ships first, in parallel with this ADR):
the host detects the expired-grant deny and surfaces it on roster/doctor instead of silently
exhausting; grants re-mint via the existing `musterd agent <seat> --path <ws>` path, with auto
re-mint on enrollment refresh considered; one live wake verified end-to-end. Separately: diagnose
why `delivery_hint` (ADR 167) emitted zero hints on a 190-act day; and the telemetry-exposed
housekeeping (stale week-old claims held by a departed seat, ~45 junk `web-*` members with no TTL,
`Co-authored-by` trailer normalization, one worktree missing its ADR 109 git identity).

**1 — directed work-order wake.** A lane newly owned by an enrolled, offline, `flow: auto` seat —
today that means `lane_handoff` — derives a work-order wake. No doctrine change: the handoff is
already a directed act. The human (or a teammate) queues; execution automates.

**2 — self-queued continuation** (the chaining primitive). Derivation adds: enrolled seat,
`flow: auto`, owns a lane in `claimed` (not `blocked`, not `ready_for_review`), **no live session**,
under caps ⇒ fresh-session work-order wake. "No live session" needs the clean ended-cleanly signal:
the SessionEnd capture (`ended_at`, ADR 131 inc 4) plus ADR 166 enumeration outranks the 10-minute
transcript-mtime guard, which would otherwise veto every wake for 10 minutes after a session ends.
The end-of-session ritual — `team_memory_save`, claim your next lane, `status_update`, end — ships
as guidance in the primer and skill, because hooks remind and never act as the agent (ADR 049).
ADR 100 (SessionEnd memory auto-save) stays its own separate proposal.

**3 — reviewer wake.** When `pickReviewCounterpart` finds nobody live and
`teamFamilyPosture().wake_pool` is non-empty, the ready edge emits a work-order wake for the best
cross-family candidate; the review ask already waits in their inbox. The worker's ≤5-minute
self-close window stretches while a reviewer wake is in flight — the exact contract is settled at
implementation, but silence-after-a-failed-wake must still degrade to the sanctioned self-close;
never a wedge (ADR 145). The review-catch rate, made a first-class metric by the ADR 169 amendment,
goes from structurally-zero to measured.

**4 — merge + cleanup actuation.** After a **verified** close (closer ≠ owner, cross-family — the
only kind increment 3 makes routinely possible): an **unrisky** lane auto-merges — the closing agent
runs the one git workflow (ADR 106: squash, auto, delete branch), cleans up, and attests
`git.pr_merged`; a **risky** lane raises a Gate-B-style `approve` ask to a human, whose accept
releases the merge. "Unrisky" means no declared risk tag **and** no derived risk: a new team-policy
map from surface globs to implied risk tags closes the hole that risk is self-declared today —
observation outranks declaration (ADR 158's rule, applied to risk). Open at implementation: whether
the closer or the owner merges, and what `authorized_by` records on an auto-merge.

**5 — observe the loop.** `/board` and `team_report` surface sessions chained, wakes by derivation,
review-catch rate, auto- vs asked-merges, and per-seat daily spend — all derived from audit rows.

## What deliberately does not change

- **No orchestrator, no runtime, no daemon timers.** The daemon derives candidates; the host
  actuates; the agent owns every clock and every decision about *what* to do — a woken session
  orients from the board and may decline, release, or raise an ask like any other session. The host
  executes reachability policy; it never decides work (ADR 131 §7's needle, threaded the same way).
- **No auto-pick from open lanes.** An idle seat is never woken because unowned work exists. Every
  work-order wake traces to a directed act (inc 1) or the seat's own recorded intent (inc 2). The
  "wake whoever for whatever is open" design was considered and rejected: it breaks the directed-act
  doctrine and needs an assignment concept that does not exist.
- **The ask leg.** ADR 147/153 already cover escalation, hold, and strand; a woken session uses them
  unmodified.
- **Verified-ness, risk, loop state stay derived**, never stored (ADR 048's standing bet).
- **Attribution invariants**: ADR 109 git identity, ADR 101/158 model attestation, ADR 150 gates
  all apply to woken sessions exactly as to attended ones — a work-order wake carries provenance
  `wake` like any other.

## Observability & Evaluation

- New audit verbs ride the existing `residency.*` family: work-order leases and outcomes are
  distinguishable by derivation (`immediate` / `batched` / `work_order`), so every metric is a
  read-side projection over rows that already exist or extend them.
- **Success metrics, pre-stated:** (a) manual fresh-session starts per flow-day drop from the
  measured 23 toward single digits; (b) review-catch rate leaves zero — verified closes appear
  without a human staging a reviewer; (c) merge audit coverage goes from 9/40 to every-loop-merge
  attested; (d) the founder's out-of-band steering (disposable web sign-ins, in-session relays)
  visibly shrinks against the 2026-07-28 baseline, which is preserved in the telemetry snapshot from
  that day.
- **Failure signals, pre-stated:** wake exhaustion or watchdog kills trending up per seat; woken
  sessions that burn budget without a lane-state transition; auto-merges on lanes that later revert.
  `budget_usd` flags per the honesty clause; the toggle is the kill switch, per seat, instantly.
- Increment 0's repair is itself an evaluation: the expired-grant failure mode was silent for at
  least a day — after the repair, a dead rail must be loud on roster/doctor within one poll cycle.

## Consequences

- The founder's manual loop — start session, paste context, relay nudges, restart — becomes: hand a
  lane to a seat (or let the seat queue its own next), and watch the board. The paste ritual was
  already obsoleted by the orientation spine; this ADR obsoletes the restart ritual.
- The trust step is real and is taken per seat, per toggle, never globally: a work-order wake is a
  genuine coding session under workspace permissions, where today's wake is a bounded reply-only
  doorbell. The mitigations are the toggle default, per-derivation rate caps, the watchdog, advisory
  budget, and the unchanged ask/strand machinery.
- Increment 3 must land before increment 4 can ever fire: auto-merge requires a verified close, and
  verified closes require a reviewer who can actually be produced.
- Two-stage close stops being theater the day increment 3 ships — and starts costing real wake
  spend, which increment 5 makes visible.

## Related

- Supersedes nothing. Extends ADR 131 (wake), ADR 169 (review), ADR 112 (autonomy knob).
- The lanes-phase2 items this overlaps (`role-pool auto-assignment`, `auto-done on merge`) remain
  deprioritized as designed there; increment 4's merge actuation is close-driven, not merge-watching.
- ADR 100 (SessionEnd memory auto-save) and ADR 176 (team home) proceed independently.
