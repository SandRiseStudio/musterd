# Wake leases

A wake lease is discharged by the seat REPORTING the wake — not by answering it — so `lease_expired` means the wake never landed, never "nobody answered".

## The trap (2026-08-12; falsify: read the report path in packages/server/src/store/residency.ts)

Three cases want opposite responses: `expired` ⇒ the seat is unreachable, escalate immediately; `reported`-but-unanswered ⇒ they are on it, HOLD (any hold window must outlive `WAKE_LEASE_TTL_MS` = 120s); `decline` ⇒ "not me" is information, escalate immediately. Anything keying escalation on `lease_expired` alone escalates on the wrong signal and stays silent on the right one (recorded in ADR 254 Consequences for increment 2).

## Related

`claimWakeLeases` already reasons per-act (`isExhausted` keyed on act_id) — an act-scoped gate mirrors `liveLease` keyed on `act_id` instead of `member_id`. A live seat is never woken (`hasLivePresence` guard), so "wake only if none live" is free.
