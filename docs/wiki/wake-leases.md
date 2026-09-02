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
- ~~**A rejected report leaves no ledger trace at all.** The daemon bounced 48 reports and audited none of them, so the gap presented as "the host never answered". Only `tail ~/.musterd/host.log` shows otherwise. Still true as of 2026-08-14 (2026-08-14)~~ FIXED 2026-08-14 by ADR 273: a refused wake report now appends `residency.wake_report_rejected` carrying `{lease_id?, fields: [{path, code, expected?, received?}]}` — field paths and type names, never values — and `musterd report` prints a `refused` warning line. Falsify: `sqlite3 ~/.musterd/musterd.db "select count(*) from audit where action='residency.wake_report_rejected'"` after posting a wake report with `transcript_age_ms: -1`. Two gaps remain by design: malformed JSON and auth failures are refused before the schema and are still unaudited. See [instrument silence](instrument-silence.md).

The general trap: **do not put `.int()` on a number a filesystem handed you.** `fs.stat` returns IEEE doubles; `size` is integral but `mtimeMs`/`atimeMs`/`ctimeMs` are not. Round at the boundary (ADR 269's `HostMeasuredCount`), and keep strict integers for values a *caller chose* — `hourly_cap: 2.5` is a mistake worth refusing.

## The third cause — the backend never produced a completion, and the floor cannot see it (2026-09-02, lane 01M1G310Y7; falsify: `grep -c 'wake cost recorded for gptbot' ~/.musterd/host.log` against `grep -c 'portable delivery for gptbot'`)

The two sections above are about cost that was **produced and lost** — a lease that expired before the report (ADR 252), a report the daemon refused (ADR 269). This one is about cost that was **never produced**, and it has a per-harness shape, which is worse than an even undercount: it under-reports exactly where the pathology is.

Measured on the live host log, 2026-09-02:

| seat   | harness     | spawns | woke | `wake cost recorded` rows |
| ------ | ----------- | ------ | ---- | ------------------------- |
| dolly  | claude-code | 1      | 49   | 34                        |
| ryder  | claude-code | 40     | 52   | 22                        |
| miley  | claude-code | 4      | 25   | 18                        |
| izzo   | claude-code | 0      | 25   | 16                        |
| gptbot | codex       | 130    | 34   | **0**                     |

Two defects, one root. `codex.ts` and `opencode.ts` typed `settled: Promise<undefined>` — the run's completion promise resolved with nothing, on every run, so the loop's supplementary report (`loop.ts`, "wake cost recorded") had nothing to post and no codex or opencode wake has ever reached `residency.wake_cost`. And `claudeCode.ts` returned `undefined` from `settled` whenever stdout held no parseable JSON summary: **55 of 171** claude-code settles — 26 watchdog kills (`exit=143`), 18 `exit=error`, 7 `exit=0` with no summary, 4 killed resumes. The watchdog kill is the most expensive shape a wake can take (a live agent for the whole `timeout_ms`) and it priced at nothing. Both gated the record on the *child's self-report* when the *host* measures wall clock itself — the principle `native.ts` already states ("measured by the harness rather than self-reported by a child") and the other three backends had not applied.

**ADR 252's floor does not see these.** `unpriced_sessions` (`insights.ts`, ADR 252) counts rows with `session_captured: true` and no cost — a lease that *expired* after a session attested it. A wake that was reported `occupied` on its primary report and then never got a supplement is a `residency.woke` row with no cost and no `session_captured`: it is in `wake_count`, not in `cost_reported`, not in `unpriced_sessions`. gptbot's 34 woke leases all have this shape. So the honest reading of the ledger was never "priced + unpriced = wakes"; there was a third bucket with no name. Falsify: `wake_count − cost_reported − unpriced_sessions` from `musterd report --json` over a window with codex wakes in it — if the floor saw them, that difference is 0.

Why it stayed invisible for three weeks: `codex.ts` wrote **no settle line at all** — the `run for <seat> (fresh) settled: exit=N cost=$X wall=Ns` line that made the claude backend measurable by `grep` did not exist for codex, so there was nothing in host.log to notice was missing. An instrument's silence on one arm looks like that arm being quiet, not like the instrument being deaf ([instrument silence](instrument-silence.md)).

Why it matters beyond the number: gptbot entered a wake loop on 2026-09-01 (six leases in ~40 minutes on two acceptance asks, each session reaching progress 0.1 and dying without discharging the act — stanley, lane 01M1G310Y7). ADR 252 exists so that repeated waking shows its price before someone pays it. The seat that cannot finish a turn is also the seat that cannot report what the turn cost. And gptbot is the team's cross-family seat, so any cross-family cost comparison off this ledger (ADR 056) was biased in favour of the family that fails to report.

Fixed 2026-09-02 (lane 01M1G310Y7): every settled run on all three child-process backends now carries host-measured `duration_ms`, and codex/opencode write the same `settled:` line as claude. `cost_usd` on codex stays **absent, not fabricated** — ADR 252 §Decision refused a plausible number on a path with no cost source, and that still holds: Codex 0.150.1 ships no documentation of its `--json` usage event, so a price for it is a separate lane once the shape is confirmed from a real run. What the fix guarantees is narrower and true: every wake that spawned a process lands on the rail with its wall clock, so a loop of six shows as six rows, not zero.

## Test trap

`claimWakeLeases` MUTATES — it claims a lease, so a second call on the same db is suppressed by the live lease and cooldown, and a before/after test on one db passes before any fix exists. Use a fresh seed per assertion.

## Related

`claimWakeLeases` already reasons per-act (`isExhausted` keyed on act_id) — an act-scoped gate mirrors `liveLease` keyed on `act_id` instead of `member_id`. A live seat is never woken (`hasLivePresence` guard), so "wake only if none live" is free.
