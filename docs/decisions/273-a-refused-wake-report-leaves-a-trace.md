# 273 — A refused wake report leaves a trace

- Status: accepted
- Date: 2026-08-14
- Deciders: stanley (built it), nick (consulted on whether it earns its own increment — answered
  yes), miley (declined ownership: a rejection row belongs with the pricing fix that explains it),
  wanderer (accepted the increment it corrects)
- Relates to: ADR 269 (the worked example, and the reason this exists), ADR 252 (`unpriced_sessions`
  — the counter that was right while its explanation was wrong), ADR 131 (§4 the wake ledger,
  increment 5 `wake_cost`), ADR 128 (what never leaves the daemon), ADR 236 (absence is not an
  assertion), ADR 251 (§7 refused one audit row per model turn — the sprawl this must not become)

## Context

ADR 269 fixed a one-character type error that discarded $22.54 of measured spend across 48 refused
wake reports. The type error is not the interesting part. **Three weeks are.**

The defect was invisible for that long because the daemon refused 48 reports and recorded nothing
about having done so. The leases it refused then expired, so the only thing the ledger said was
`residency.wake_failed {reason: lease_expired}` — which reads, correctly per ADR 269's own wiki page,
as *the wake never landed*. It had landed. It had run to completion, printed `cost=$1.3093`, and
posted that figure twice.

The failure is epistemic, and it caught two people independently:

> **miley:** "residency.wake_cost is only ever written on the report path, so a lease that spawns and
> never reports is reaped as wake_failed with no number. Leases can 5x with zero priced wakes and
> **nothing is lying**."

> **stanley (opening the ADR 269 lane):** "the failure path pays and reports nothing."

Both readings of the code were accurate. Both conclusions were wrong, in the same direction, for the
same reason: **we reasoned from what the code WRITES and never asked what it REFUSES.** Absence of a
cost row is indistinguishable from absence of a cost when the refusal is silent. miley put the
sharper version of it afterwards — "I'd already noticed cost rows only exist on the report path, and
stopped at *so the path wasn't taken* instead of *so a rejected report is indistinguishable from no
report*."

A ledger that cannot say "I refused this" will keep producing that mistake, and the next one will
not be found by someone happening to `tail` a logfile that nothing reads and nothing alerts on.

**Why this route and not validation generally.** Every other rejected request on this server is a
retry away from success. A refused `team_send` costs nothing; the sender still has the message. A
wake report is categorically different: it is the **receipt for a session that has already spawned,
already run, and already cost money**. Refusing it silently destroys the only record that the spend
happened. That is the property that earns a ledger row, and it is narrow — ADR 251 §7 already refused
one audit row per model turn on exactly the bloat argument, and this must not become the wedge that
reopens it.

## Decision

**When the daemon refuses a wake report, it says so on the ledger before it throws.**

1. **A new audit action, `residency.wake_report_rejected`**, appended by the wake-report route when
   `WakeReportBodySchema` rejects the body. `result: 'deny'`.
2. **It must work when the body does not parse** — which is the whole difficulty, because there is no
   parsed body to source fields from. Only an already-string `lease_id` is salvaged by hand; the
   lease is then looked up for the seat, `act`, and `edge`. A body that cannot name its own lease is
   **still audited**, without one. A `lease_id` naming no lease is audited with `target: '?'` — no
   seat is invented (ADR 236).
3. **Field paths and TYPE names, never values** (ADR 128). Detail is
   `{ act?, lease_id?, edge?, fields: [{ path, code, expected?, received? }] }`, bounded to 8 issues
   so a pathological body cannot write an unbounded row into the ledger the O&E reads. `expected` and
   `received` are zod's type words — `integer`, `float`, `number`, `string` — which carry nothing out
   of the rejected payload.
4. **The 400 does not change.** The throw is delegated to the existing `parseOrBadRequest`, so the
   response a host sees is byte-identical to what it saw before this ADR. Auditing a refusal must not
   alter what a refusal *means*.
5. **`WakeMetrics` gains `reports_rejected`, and it is NOT folded into `failed`.** A refused report
   is not a failed wake; it is a successful wake whose record was destroyed. Folding them would repeat
   the ADR 269 mistake of letting a refusal wear a failure's clothes. `musterd report` prints it as a
   warning, and prints nothing at zero — unlike `unpriced_sessions`, silence here is the honest steady
   state.

## Consequences

- The next wire-shape disagreement between a host and this daemon is one query, not one lucky
  `tail`. It also becomes a number a human sees without asking for it.
- **`reports_rejected > 0` invalidates every other wake number in the same report**, and the printed
  line says so. Rejected receipts are spend the report structurally cannot see — the same bias ADR
  252 documented for `unpriced_sessions`, arriving through a different door.
- A pinned or un-upgraded host that disagrees with the daemon now shows up as itself rather than as
  a fleet of seats that mysteriously stopped answering.
- The ledger grows by one row per refusal. At the observed rate that is 48 rows in three weeks; if it
  is ever more than that, the rows are the least of the problem.

### Limitations, and what is left open

- **This audits the wake-report route only.** The principle that earns it is stated above — audit a
  rejection when the rejected message is the only record that a paid, irreversible thing happened —
  and other routes must argue it on their own merits rather than cite this ADR as precedent.
- **A report rejected before it reaches the schema is still silent.** Malformed JSON throws in
  `readJson`, and an auth failure throws earlier still; neither is audited here. Both are far louder
  on the host side (they are not silent 400s on an otherwise-working path) but the gap is real and
  named rather than papered over.
- **It cannot recover the $22.54, or any past refusal.** This is a going-forward instrument. The 48
  historical refusals exist only in `~/.musterd/host.log` and are quoted in ADR 269 because that is
  the only place they will ever exist.
- **ADR 252's genuinely-unreported wake is still unpriced.** A host killed mid-run, a sleeping
  machine — those report nothing at all, so there is nothing to refuse. `unpriced_sessions` still
  counts them and this ADR does not touch that.

## Observability & Evaluation

**Traces.** No new span. One new audit action.

**Eval.** The claim is that a refusal is no longer silent, and that the row is specific enough to
name the defect that motivated it.

*The discriminating evidence, run 2026-08-14* — the pre-#844 field type against the exact payload the
live host sent 48 times, mapped through this ADR's field extractor:

```json
{
  "lease_id": "01KZZB1PHVG7MF4FZBQ1RM8BZD",
  "fields": [
    { "path": "transcript_age_ms", "code": "invalid_type",
      "expected": "integer", "received": "float" }
  ]
}

contains the cost?  false
contains the value? false
```

That row, had it existed on 2026-07-24, names the ADR 269 defect on sight — the field, and the exact
type confusion — while carrying neither the `cost_usd` nor the offending value. Three weeks and
$22.54 turn on one line of JSON that was never written.

Behavioural coverage in `packages/server/src/transport/residency-http.test.ts`: the refusal is
audited against its lease with the field named and the value withheld; a body that cannot name its
lease is audited anyway; a lease id naming nothing invents no seat; an accepted report writes no row;
and `reports_rejected` surfaces on the report projection.

**Failure to watch:** `reports_rejected` sitting at 0 while `unpriced_sessions` climbs. On this
design that means spend is going missing through a door this row does not cover — the pre-schema
rejections in the Limitations above, or a host that has stopped posting altogether — and it must be
read as "the instrument does not cover this", never as "no reports are being refused".

**Experiment.** None. The alternative arm is the state ADR 269 measured: a daemon that discards
receipts it can read and records nothing about it. Running it deliberately would be re-measuring a
known defect at $1 a wake.
