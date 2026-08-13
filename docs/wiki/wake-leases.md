# Wake leases

A wake lease is discharged by the seat REPORTING the wake — not by answering it — so `lease_expired` means the wake never landed, never "nobody answered".

## The trap (2026-08-12; falsify: read the report path in packages/server/src/store/residency.ts)

Three cases want opposite responses: `expired` ⇒ the seat is unreachable, escalate immediately; `reported`-but-unanswered ⇒ they are on it, HOLD (any hold window must outlive `WAKE_LEASE_TTL_MS` = 120s); `decline` ⇒ "not me" is information, escalate immediately. Anything keying escalation on `lease_expired` alone escalates on the wrong signal and stays silent on the right one (recorded in ADR 254 Consequences for increment 2).

## The ledger prices only reported wakes (2026-08-08/12, ADR 252/#747; falsify: count wake_cost rows vs wake_leased)

`residency.wake_cost` is written only on the wake-report route, so a wake that spawns a session and dies `lease_expired` is paid and invisible — measured 35 cost rows against 150 `wake_leased`. Any dollar figure off this ledger is biased low in exactly the failure mode being priced; #747 counts these as `unpriced_sessions` OUTSIDE the totals, documented as a floor. Timing-window correlation is invalid on a flapping seat (ADR 241 removed exactly that inference). A handoff discharged by doing the work is recognized by `laneHandoffDischarged` in delivery.ts (#745 — ADR 090's two older clauses are reply-shaped and matched 0 of 8 real discharges); the exhaustion cap keys per act, and one handoff can be two envelopes, so 6 wakes is inside policy.

## Test trap

`claimWakeLeases` MUTATES — it claims a lease, so a second call on the same db is suppressed by the live lease and cooldown, and a before/after test on one db passes before any fix exists. Use a fresh seed per assertion.

## Related

`claimWakeLeases` already reasons per-act (`isExhausted` keyed on act_id) — an act-scoped gate mirrors `liveLease` keyed on `act_id` instead of `member_id`. A live seat is never woken (`hasLivePresence` guard), so "wake only if none live" is free.
