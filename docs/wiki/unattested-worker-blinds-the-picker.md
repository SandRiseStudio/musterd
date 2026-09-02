# An unattested worker blinds the picker

A `no_candidate` close whose worker attested nothing means "the asker could not be graded", not "the team had nobody" — and until 2026-09-01 the ledger filed both the same way.

## The mechanism

`reviewGrade(worker, reviewer)` returns null when *either* side's model is unknown
(`packages/protocol/src/model.ts`). The live picker in `selectReviewCounterpart` graded each
candidate against the worker and filed a null as that **candidate's** `unknown_grade`. So one
worker whose live occupancy attested nothing excluded every gradeable reviewer at once, and the
`lane.ready_for_review` row read as a complete, empty candidate set.

~~The ADR 303 snapshot cannot separate an ungradeable worker from an absent candidate set
(2026-09-01; falsify: find a `lane.ready_for_review` row with `review_selection.outcome =
'no_candidate'` whose candidates carry `unknown_grade` while their own `family` is known)~~ FIXED
2026-09-01 by lane `01M1FJYETP6809EW45WY0S71V8`: the snapshot carries `worker_family`, and a
gradeable candidate blinded by the worker is filed `worker_unattested`. `unknown_grade` now means
the candidate itself attests nothing. Rows before the fix keep the old shape; read them with the
falsifier above, which is also the measurement below.

## The measurement (2026-09-01, before the fix)

Of the 49 `lane.ready_for_review` rows with outcome `no_candidate` since ADR 303 shipped, 10 had
at least one candidate excluded on `unknown_grade`. In all 10 the excluded candidate's own family
was known (`claude`, `grok`), so the null came from the worker. Owners: ghost ×3 (2026-08-25 to
27), big-body ×4, stanley ×1, ryder ×2 — six of the ten on 2026-09-01, including the HIGH-stakes
#1119 (falsify: the query in "How to read it" below returns a different set).

The routing outcome was correct in all 10 — ADR 188 grades nothing from an unknown model and never
routes `same_model`, so an unattested worker routes nowhere either way. What was wrong was the
reason, and reasons are what ADR 234's reads aggregate: those rows were counted as fleet
degradation ("nobody eligible") when they were an attestation gap on the asker.

## The series did not end at 10 (re-measured 2026-09-02)

Ten was the count at the time of the fix, not the end of the series. Re-read from the live
`audit` table on 2026-09-02 the same query returns 12 rows, and the two new ones are the expected
shape of the *healthy* state, not the storm: big-body at 23:40 and 23:47 UTC on 2026-09-01, both
after the storm ended at 21:57 UTC, in a window where big-body's occupancy logged no
`model_attested` event at all — its next claim attested `claude-opus-5` at 00:09 UTC (falsify:
`SELECT count(*)` of the "How to read it" query is not 12, or the `audit` table shows a big-body
`occupancy.model_attested` row between 22:30 and 00:09 UTC). The storm explains the six same-day
rows in the section below. It does not explain these two, and it will not explain the next ones:
a worker whose surface attests nothing at the moment it calls `lane_ready` files a
`worker_unattested` row whether or not anything is wrong with the fleet. Post-fix those rows are
labelled honestly, and the first `no_candidate` rows on the fixed daemon (2026-09-02 02:54 and
03:09 UTC) carry `worker_family = 'claude'` — the team's gap, not the asker's. Count
`worker_unattested` rows as a measure of the asker's attestation seam, never as fleet degradation.

## Why six in one day: the claim storm nulled live attestations

The 2026-09-01 rows were not seats that never attested. They were seats whose attestation had been
**overwritten to null minutes earlier** by the CLI reclaim storm that #1138/#1143 fixed: after
ADR 337 made the team key bootstrap-only, every CLI read that lacked a lease reclaimed one with a
fresh `surface: cli` claim, and that claim superseded the live `claude-code` occupancy with a
Presence attesting nothing (`occupancy.model_attested {old: "claude-fable-5", new: null, source:
"claim"}`). Measured from the `audit` table, UTC:

| hour (UTC) | `cli` claims | seats with attested→null flips |
| --- | --- | --- |
| 16:00 | 1651 | dolly 191, izzo 165 |
| 19:00 | 1487 | miley 354, stanley 204, dolly 83, izzo 60, ryder 59 |
| 21:00 | 224 | — |
| 23:00 | 52 | none: every claim is followed by a heartbeat re-attesting the model |

The storm ended when the dists rebuilt on #1143 (deployed 14:57 local, 21:57 UTC); the `23:00`
row is the healthy shape (falsify: re-run the hourly query — a later hour with hundreds of `cli`
claims and attested→null flips means the storm is back). So the picker's blindness and the
[residency ledger undercount](residency-ledger-undercount.md) share one cause for that window:
ADR 337's five-minute lease, met by clients that reclaimed instead of renewing until ADR 347.

This is a [cannot-separate-two-causes](cannot-separate-two-causes.md) instance: a `no_candidate`
close reason carried "nobody eligible" and "asker unattested" under one word, and a
[recorded-not-routed](recorded-not-routed.md) one: the misfiled rows sat with nobody asked until a
seat read the selection row by hand (izzo, 2026-09-01, three of big-body's lanes).

## How to read it

Rows after the fix: `review_selection.worker_family = 'unknown'` with `worker_unattested`
candidates is the asker's gap; `no_candidate` with a known `worker_family` is the team's. Rows
before the fix, from the `audit` table:

```sql
SELECT datetime(ts/1000,'unixepoch'), actor, detail
FROM audit
WHERE action = 'lane.ready_for_review'
  AND json_extract(detail, '$.review_selection.outcome') = 'no_candidate'
  AND detail LIKE '%unknown_grade%';
```

then check each `unknown_grade` candidate's `family`: known means the worker was the unknown side.

Whether an unattested worker should route at all, and at what grade, was a separate decision this
page did not make; the honest label was the prerequisite for it. Made 2026-09-02:
[ADR 351](../decisions/351-unattested-worker-routes-ungraded.md) routes the unattested worker to a
live attested peer at the rung below the ladder, `ungraded`, with its own `route` value and the
close-edge abstention counted. From that landing the shape above should stop producing
`no_candidate` rows and start producing `route: 'ungraded'` ones (falsify: a `no_candidate` row
after the ADR 351 daemon bounce whose `worker_family` is `unknown` and whose candidates include a
live attested agent).
