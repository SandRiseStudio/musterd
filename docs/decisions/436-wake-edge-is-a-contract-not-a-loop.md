# 436 — The wake edge is a contract the host enforces, not a loop musterd owns

- Status: proposed
- Date: 2026-09-21
- Relates to: [ADR 251](251-native-backend-musterd-as-its-own-harness.md) (the native row stays the
  reference implementation, not the delivery path), [ADR 131 §7](131-harness-residency-wake-ledger-host.md)
  (the actuator seam this contract wraps), [ADR 209](209-portable-wake-context.md) /
  [ADR 430](430-wake-context-packet-v2.md) (the packet, unchanged), [ADR 364](364-tokens-are-the-attested-unit-when-the-harness-prints-no-price.md)
  (unpriced is a fact), [ADR 166](166-session-liveness-by-enumeration.md) (the liveness guard
  clause 4 corrects), [ADR 056](056-research-as-first-class-practice.md) / [ADR 101](101-model-as-a-variable.md)
  (why one engine is not an option)
- Lane: `01M32FJ8T49EGFJV659DNBEMKK` (increment 5 of `seat-continuity`)
- Design: `docs/design/musterd-harness.md` — the conversation with nick, 2026-09-21

## Context

Increment 5 of the `seat-continuity` goal was chartered as a design conversation: does musterd run
the agent loop itself, so that the ~45% of a wake life the harness injects before the seat acts
becomes musterd's to cut? By the time the conversation ran, increment 4's measurement had removed
the continuity argument — a fresh spawn with the v2 packet matched a transcript resume on
correctness at half the cost, on Claude Code and Codex. Before deciding, the same three-act thread
was run on the two remaining wake backends, Grok CLI and OpenCode (wiki:
`resume-bound-is-below-one-wake-life.md`, "Arms D and E"). The first act was correct on all four
harnesses. Around the act, every harness differed: reads before acting (0 / 1 / 2 / 3), whether
the reply landed in the thread, whether musterd could price the wake (only Claude Code), and which
wake-edge defect the run tripped — Grok wakes never settle and post no cost row; a finished Grok
session reads live for ten minutes; OpenCode wakes are captured as `claude-code`; a `message`
reply discharges nothing, so the daemon re-leased both seats' handoffs after a correct answer.

Grok's own usage file showed 284,583 input tokens for a one-line reply, seven times the whole
Claude Code life — the floor is harness-specific, and musterd sees it on one harness of four.

## Problem

The `ActuatorBackend` seam (ADR 131 §7) asks a backend for an `outcome` and a `settled` promise
and accepts `undefined` from the latter. Settle, price, capture, liveness and discharge are each
done by some backends and not others, and the host checks none of them. Every defect the run hit
lived in that gap; none lived in the packet. Owning the loop would close the gap for one engine
and reopen it as a model-diversity regression; owning it per provider is four SDK integrations to
fix five contract holes.

## Decision

1. **The wake edge is a contract the host enforces around every backend.** Five clauses, each a
   host-side guarantee in the loop that drives `ActuatorBackend`, never a backend courtesy:
   **settle** (every wake yields a settled line and a `residency.wake_cost` row; a backend that
   returns nothing gets a duration-only row with an `unpriced_reason`); **price** (a cost reader
   per harness over the artifact that harness writes, pure, fixture-tested from a real file;
   unpriced stays named per ADR 364); **capture** (`session_captured` carries the harness the host
   spawned, stamped at spawn); **liveness** (the host marks a captured session ended when the child
   exits); **discharge** (`accept`/`decline`/`resolve` on the thread discharge a wake act; the wake
   line says so on every harness; a `message` reply is recorded as answered-not-discharged and the
   act is not re-leased at the next window).
2. **The native backend (ADR 251) is not the delivery path for wakes.** It remains the reference
   row that proves the seam is not CLI-shaped, and grows under its own charter. No wake is routed
   to it because of this ADR.
3. **The packet is unchanged.** ADR 430 stands; nothing in this ADR alters what a seat is handed.
4. **A measurement rail, per harness, derived from the wake ledger:** floor tokens before first
   act, reads before first act, priced or not, first act in thread or not. Arms A–E are its first
   rows.
5. **Dated trigger.** Owning the loop with an engine per provider is revisited — by a new ADR —
   when, thirty days after clause 1 lands on the daemon, either holds: a backend still cannot be
   priced from its own artifact, or the median floor on any harness exceeds three times Claude
   Code's. Absent both, this decision stands and the question is closed.
6. **Scope.** cursor-agent has no wake backend and is excluded explicitly. Shrinking what a harness
   injects is a separate question, not decided here.

## Consequences

- Five lanes open under `seat-continuity` before lane `01M32FJ8T4` closes: settle + price
  `01M32ZKP4Z` (filed from the run, owned by stanley), capture `01M3309Y1V`, liveness
  `01M3309Z28`, discharge `01M330A04F` (depends on `01M32V416B`), rail `01M330A14T`; the last
  four are unowned.
- The Grok and OpenCode seats used for the run (grokbot, ghost) stay enrolled at team defaults, so
  the clauses can be falsified on the harnesses that exposed them.
- Clause 5 changes what the daemon does after a wake: an act answered with `message` stops waking
  its seat. Lane `01M32V416B` (discharged acts re-leased on window reopen) is the adjacent fix; the
  two must agree on what "discharged" and "answered" mean.
- The trigger date is set by clause 1's landing, recorded here as a dated note when it lands.
- **2026-09-21 (same day, after the run):** [ADR 434](434-a-discharged-act-never-re-wakes-its-seat.md)
  reached the daemon at `c8ab98bc`, after the arm D/E wakes ran on `e95b52d`. It already decides
  that a recipient's `message` reply in the act's thread discharges for that recipient, and that a
  `residency.woke` row spends the act — held live at 15:01 (gptbot, one lease through thirteen
  polls). Clause 5's "not re-leased at the next window" is therefore satisfied by ADR 434, which
  this ADR adopts rather than overrides; lane `01M330A04F` narrows to the wake-line wording (a reply
  OUTSIDE the thread — ghost's arm-E shape — discharges nothing, and no seat is told so) and to
  whether the ledger carries a distinct answered-vs-discharged label.

- **2026-09-24 (lane `01M3309Z28`, clause 4 — liveness):** the host loop now stamps `ended_at`
  at settle on every capture a backend's `WakeCompletion.captures` claims (`host/wakeCapture.ts`);
  backends name the capture, the loop writes it, so the guarantee stays in the loop per Decision 1.
  The grokbot deferral had two causes, not one: nothing stamped a finished Grok wake ended, **and**
  a fresh Grok capture was recorded as the `wake-<lease>` placeholder, which enumeration can never
  match, so the ADR 199 override (`ended_at` outranks a warm file for the SAME session) could not
  fire even had it been stamped. At settle the Grok backend names the real session — the newest
  `session_kind: headless` summary created at or after spawn — so an interactive session a human
  opened beside the wake is never taken for it, and the ADR 166 guardrail holds (a different live
  session beside the ended capture stays live; tested). The rename also makes a later `-r` resume
  name a real id. A session that took the slot mid-wake is never stamped: the claim must name it.

- **2026-09-24 (lane `01M3309Y1V`, clause 3 — capture):** the host stamps `MUSTERD_WAKE_HARNESS`
  with the backend it spawned, beside `MUSTERD_WAKE_LEASE` (`wakeEnv`, only with a lease), and
  `musterd session start` prefers it over the payload-shape inference. The ledger's `claude-code`
  rows had a second cause: `pushAttestation` defaulted its harness to `claude-code` and the hook
  path never passed one, so even a slot that said `grok` was attested as `claude-code`. The push
  now sends the capture's own harness. Grok wakes have posted captures since 2026-09-21 21:03, all
  mislabelled. No protocol change: `harness` was already an open string.

## Observability & Evaluation

- **Traces:** per wake, the existing `residency.woke` / `residency.wake_cost` / `session_captured`
  rows, now guaranteed present for every backend; clause 5 adds an `answered_not_discharged` fact
  on the wake ledger. Agent-turn detail stays in the harness's own transcript (ADR 194).
- **Eval:** the per-harness rail (Decision 4). Success = every enrolled harness has a cost row for
  100% of wakes, a correct harness on 100% of captures, and zero re-leases of an act that was
  answered. **Baseline:** the four arms of 2026-09-21 — cost rows on 1 of 4 harnesses, capture
  wrong on 1 of 2 that capture, both non-Claude seats re-leased after a correct answer.
- **Experiment:** re-run the three-act thread on all four harnesses after clause 1 lands and again
  at the thirty-day mark; the trigger in Decision 5 is read from the rail, not re-argued.
