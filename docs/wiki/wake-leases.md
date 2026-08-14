# Wake leases

A wake lease is discharged by the seat REPORTING the wake — not by answering it — so `lease_expired` means the wake never landed, never "nobody answered".

## The trap (2026-08-12; falsify: read the report path in packages/server/src/store/residency.ts)

Three cases want opposite responses: `expired` ⇒ the seat is unreachable, escalate immediately; `reported`-but-unanswered ⇒ they are on it, HOLD (any hold window must outlive `WAKE_LEASE_TTL_MS` = 120s); `decline` ⇒ "not me" is information, escalate immediately. Anything keying escalation on `lease_expired` alone escalates on the wrong signal and stays silent on the right one (recorded in ADR 254 Consequences for increment 2).

## The ledger prices only reported wakes (2026-08-08/12, ADR 252/#747; falsify: count wake_cost rows vs wake_leased)

`residency.wake_cost` is written only on the wake-report route, so a wake that spawns a session and dies `lease_expired` is paid and invisible — measured 35 cost rows against 150 `wake_leased`. Any dollar figure off this ledger is biased low in exactly the failure mode being priced; #747 counts these as `unpriced_sessions` OUTSIDE the totals, documented as a floor. Timing-window correlation is invalid on a flapping seat (ADR 241 removed exactly that inference). A handoff discharged by doing the work is recognized by `laneHandoffDischarged` in delivery.ts (#745 — ADR 090's two older clauses are reply-shaped and matched 0 of 8 real discharges); the exhaustion cap keys per act, and one handoff can be two envelopes, so 6 wakes is inside policy.

## Why the wakes above were unpriced — it was not the failure path (2026-08-14, ADR 269/#841; falsify: `grep "report failed" ~/.musterd/host.log`)

The section above is right that the ledger under-prices, and ~~its stated cause — no cost source exists on the failure path (2026-08-12)~~ CORRECTED 2026-08-14 by ADR 269: the cost source existed and worked. The daemon was **refusing the reports that carried it**. `transcript_age_ms` is `Date.now() - fs.stat().mtimeMs`, and `mtimeMs` is fractional on APFS (`1786744301066.2197`), so the value is a float against a `z.number().int()` wire schema. Zod rejects the whole object, so one unusable digit of sub-millisecond precision took down the lease settlement AND the `cost_usd` beside it: **48 rejected reports, $22.54 of harness-attested spend discarded**, each lease then expiring as `wake_failed {session_captured: true}` — the ledger calling a wake free that had just printed `cost=$1.3093` to stdout.

Two second-order effects worth knowing:

- **Unsettled acts get re-leased.** One act was leased 12 times; leases-per-act went 2.2 → 4.6 (08-04 → 08-13). Any lease-rate reading over that window — including the 0.23/h → 1.10/h rise the ADR 260 Eval attributed to ADR 253 routing — is contaminated by this defect in BOTH arms.
- **A rejected report leaves no ledger trace at all.** The daemon bounced 48 reports and audited none of them, so the gap presented as "the host never answered". Only `tail ~/.musterd/host.log` shows otherwise. Still true as of 2026-08-14 — see [instrument silence](instrument-silence.md).

The general trap: **do not put `.int()` on a number a filesystem handed you.** `fs.stat` returns IEEE doubles; `size` is integral but `mtimeMs`/`atimeMs`/`ctimeMs` are not. Round at the boundary (ADR 269's `HostMeasuredCount`), and keep strict integers for values a *caller chose* — `hourly_cap: 2.5` is a mistake worth refusing.

## Test trap

`claimWakeLeases` MUTATES — it claims a lease, so a second call on the same db is suppressed by the live lease and cooldown, and a before/after test on one db passes before any fix exists. Use a fresh seed per assertion.

## Related

`claimWakeLeases` already reasons per-act (`isExhausted` keyed on act_id) — an act-scoped gate mirrors `liveLease` keyed on `act_id` instead of `member_id`. A live seat is never woken (`hasLivePresence` guard), so "wake only if none live" is free.
