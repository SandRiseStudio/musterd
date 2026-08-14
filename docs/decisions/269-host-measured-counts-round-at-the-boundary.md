# 269 — A wake's price was being refused at the door by one unusable digit

- Status: accepted
- Date: 2026-08-14
- Deciders: stanley (found it on the live host log while opening the wake-pricing arc), izzo (whose
  ADR 260 Eval surfaced the symptom and correctly guessed it belonged to this goal)
- Relates to: ADR 252 (the counter that made this gap sayable — and whose stated *cause* this
  corrects), ADR 131 (§4 the wake ledger, increment 5 `wake_cost`), ADR 209 (#603, which put
  `transcript_age_ms` on the report body), ADR 210 (the byte/age resume ladder these measurements
  feed), ADR 236 (absence is not an assertion — why the ledger's silence read as "free")

## Context

ADR 252 closed with an open item: *"The cost of an unreported wake stays unknown. Actually pricing
it needs a cost source on the failure path — a host-side reap that reads the harness's own
accounting after a run dies."*

That premise is wrong, and the live ledger says so. There is no missing cost source. The cost was
measured, printed, and posted — and the daemon threw it away.

The evidence, read off `~/.musterd/musterd.db` and `~/.musterd/host.log` on 2026-08-14:

- Over the 7-day window `musterd report` actually shows: **52 leases → 3 woken acts → 2 priced, 10
  `unpriced_sessions`.** `cost_usd_total` described 2 of the 12 wakes known to have paid for a
  session.
- Since 2026-08-13: 32 leases, **zero** `residency.woke`, **zero** `residency.wake_cost`, and 9
  `residency.wake_failed` rows carrying `session_captured: true`.
- The host log for those same leases:

  ```
  ⚡ woke ryder: spawn→roster 5.1s, session=fresh provenance=wake
  ! wake-report failed for lease 01KZZB1PHVG7MF4FZBQ1RM8BZD: transcript_age_ms: Expected integer, received float
  run for ryder (fresh) settled: exit=0 cost=$1.3093 wall=99.7s
  ! wake-cost report failed for lease 01KZZB1PHVG7MF4FZBQ1RM8BZD: transcript_age_ms: Expected integer, received float
  ```

  The wake worked. The run finished cleanly. The harness knew the price to four decimal places. Both
  reports that could have carried it were refused.

- Across the whole log: **48 rejected reports, every one the same message, $22.54 of
  harness-attested spend discarded.**

**The mechanism, end to end.** `transcript_age_ms` is derived in the backends as
`Date.now() - liveness.transcriptMtime`, and `transcriptMtime` is `fs.statSync().mtimeMs` — an IEEE
double that is *fractional on APFS* (`1786744301066.2197`). `Date.now()` is an integer, so the
difference is a float. The wire schema declared `z.number().int()`. Zod rejects the **whole object**,
so a field that exists only to feed the ADR 210 resume ladder took down, with it:

1. the primary report — so the lease never settled, and expired;
2. the supplementary report — so no `residency.wake_cost` row was ever written;
3. and, because an unsettled act stays due, the daemon re-leased it. One act was leased **12 times**;
   leases-per-act climbed 2.2 → 4.6 between 08-04 and 08-13.

That third consequence matters beyond cost. izzo's ADR 260 Eval measured wake leases rising 0.23/h →
1.10/h across the ADR 253 routing change and read it as routing volume. A material part of that rise
is this bug re-leasing acts that could never settle. **The Eval's arms are contaminated by a defect
that spans both of them**, which is a stronger reason not to read it than the one ADR 260's report
already gives.

So the ledger's failure mode was never "we cannot price a wake that died". It was: **a wake that
succeeded, priced itself, and was told its paperwork was malformed** — after which it died, and the
ledger recorded the death and not the receipt. `unpriced_sessions` counted this correctly and
honestly; only its explanation was wrong.

## Decision

**A count the host MEASURED off its own filesystem is rounded at the boundary, never refused.**

1. `transcript_bytes` and `transcript_age_ms` on `WakeReportBodySchema` take a shared
   `HostMeasuredCount` = `z.number().nonnegative().transform(Math.round)`.
2. The two producers (`claudeCode.ts`, `codex.ts`) round the value they send, so the wire carries the
   integer they mean. The boundary's tolerance is a backstop for hosts running a pinned `dist`, not
   this code's excuse.
3. **Validation still bites where a value is chosen rather than handed over.** Negatives are still
   refused. Every policy and config integer in `residency.ts` — `cooldown_ms`, `hourly_cap`,
   `attempt_cap`, `timeout_ms`, `transcript_max_bytes` — stays strict. The distinction is the whole
   rule: a caller who writes `hourly_cap: 2.5` made a mistake worth refusing; a filesystem that
   returns `mtimeMs: …066.2197` did not.

## Consequences

- The $22.54 stops. More precisely: reports carrying a price stop being refused, and the wakes they
  describe stop expiring for want of a settlement.
- `unpriced_sessions` should fall toward 0 and `cost_reported` should rise to meet `wakes`. Per ADR
  252 §5 this counter only ever read as a floor; it is about to become a much smaller floor for a
  reason that has nothing to do with coverage.
- Lease churn should fall with it — an act that settles is not re-leased — which will show up as
  leases-per-act returning toward ~1 and as a *drop* in the lease rate that must not be misread as
  routing getting quieter.
- **ADR 252's open item is narrower than it looked, not closed.** A genuinely unreported wake — host
  killed mid-run, machine asleep — still has no cost source, and `unpriced_sessions` still exists to
  count it. What is closed is the dominant term: the wakes that *did* report and were not heard.

### Limitations, and what is left open

- **The rollout coupling is the unfriendly direction this time.** The daemon fix takes effect for
  every host the moment the daemon restarts, including pinned ones — that is why rounding lives at
  the boundary. But the *running* actuator on this machine executes
  `/Users/nick/agents/packages/cli/dist/bin.js`, a different worktree's build, so the producer half
  is inert there until that dist is rebuilt.
- **A rejected report is still only visible in a local logfile.** This is the fragility that made a
  one-digit type error cost $22.54 and three weeks of silence: the daemon rejected 48 reports and the
  ledger records no trace of having done so, so the gap presented as "the host never answered". An
  audit row for a refused wake report would make the next protocol drift one query instead of one
  lucky `tail`. Deliberately not built here — it is a ledger change with its own design, and this
  increment is worth landing without it. **Raised to nick as a consult.**
- **The host actuator is not running as of this writing** (`launchctl` reports
  `studio.sandrise.musterd-host` exited `-15`, no PID), so the live re-observation below cannot be
  taken until someone restarts it — which spawns real, paid sessions and is therefore nick's call.

## Observability & Evaluation

**Traces.** No new span, no new field. The change is that existing rows get written at all.

**Eval.** The claim is that a wake which reports a price now has that price recorded.

*Observed at the boundary, 2026-08-14* — the exact rejected value, replayed against the built
protocol dist:

```
st.mtimeMs       : 1786744301066.2197 (integer? false)
transcript_age_ms: 4674.7802734375    (integer? false)

before: wake report with a real cost of $1.3093 -> REJECTED  (transcript_age_ms: Expected integer, received float)
after : wake report with a real cost of $1.3093 -> ACCEPTED
```

Regression tests live at the boundary, not at the producer, because the boundary is what protects a
host nobody rebuilt: `packages/protocol/src/residency.test.ts` — a fractional age is rounded and the
`cost_usd` beside it survives; a fractional byte count is rounded; a negative age still throws.

*Live re-observation, pending the host restart above.* The discriminating evidence is a
`residency.wake_cost` row appearing for a lease whose seat also produced a `residency.woke` row —
neither of which has existed since 2026-08-12. Supporting read, unchanged from ADR 252:
`unpriced_sessions + cost_reported ≤ leases`.

**Failure to watch:** `residency.wake_cost` rows still absent after the host is rebuilt and
restarted. That would mean the rejection was never the only thing standing between a measured cost
and the ledger, and this ADR's diagnosis is incomplete rather than merely narrow.

**Experiment.** None. There is no arm worth running: the alternative is a boundary that discards
receipts it can read, which is the state being corrected.
