# 393 — Fold projects residency enrollment onto the roster

- Status: accepted
- Date: 2026-09-14
- Relates to: ADR 365 (the ledger kind — fold appends, projects nothing), ADR 371 §4
  (`residency.enrolled` / `residency.revoked` join the ledger set), ADR 131 (enrollment is the
  roster's `wakeable` flag), ADR 361 (a wake runs where the seat is enrolled — `claimWakeLeases`
  filters `host === this host`)
- Lane: `01M1T3GWEAJVJ4SS4N309B0T9T`

## Context

ADR 371 §4 put `residency.enrolled` and `residency.revoked` on the ledger so the audit trail
crosses. The fold still "projects into nothing" (ADR 365 Decision 1). The roster does not read
`audit`. It reads `listWakeableMemberIds` → the `residency` table (`transport/http.ts` member
summary, `wakeable: residency.has(s.member.id)`).

Measured 2026-09-04 on delta (`docs/perf/cloud-seat.md` finding 6): the hub's `residency status`
listed the laptop's five seats, not delta; the hub roster showed delta plain `offline` while the
VM showed `offline · wakeable`. The wake decision was already the joiner's (folded messages, host
poll). The lie was the roster.

The census (`docs/wiki/federation-data-census.md`) recorded the `residency` table as residence 3,
"no, by design". That was true of the *actuator* (leases, host liveness, `claimWakeLeases`). It
was false of the *label*: once the audit crossed and the table did not, every surface that answers
"can we reach this seat" disagreed with the machine that actually can.

## Problem

Make the hub roster tell the truth without making the hub the actuator, and without shipping the
standing grant (a local secret).

ADR 365 Decision 1 is frozen: the ledger kind appends and never projects. Changing that for every
ledger verb would fold a peer's wakes into this machine's rate cap — the thing §3 pinned
`MINTED_HERE` to prevent. The carve-out has to be the two verbs whose *table* is the roster, not
the six whose *audit rows* are the rate state.

## Decision

**The fold projects `residency.enrolled` and `residency.revoked` into the `residency` table.
`claimWakeLeases` still filters `host === this host`. The standing grant never crosses.**

1. **Same tag, two verbs, a projector.** The events stay `kind: 'ledger'` — they already ship.
   After the mistag check and before the audit insert, `projectResidencyLedger` upserts or deletes
   the `residency` row. An unknown seat name is git lag and stops as `unresolved_seat` (block,
   don't skip). `residency.session_captured` sets `resumable_*` when a row is already here, and
   is a no-op when it is not — the origin's own rule.
2. **`applyFoldedEnrollment` does not write `grant_id`.** Grants are residence 3. A first insert
   stores `grant_id` null; a re-enroll leaves whatever grant this daemon already holds. The origin
   keeps minting and revoking grants locally as it does today.
3. **The hub is not the actuator.** `claimWakeLeases` already derives only for `r.host === host`.
   A folded row whose `host` is the joiner's hostname produces no lease on the hub's poll. Wake
   caps, attempt caps, and `hostAsleepMs` stay on `MINTED_HERE` rows. This is a roster fact, not a
   wake-economy fact.
4. **No new kind, no protocol schema change.** The wire already carries the detail (`harness`,
   `host`, `authorized_by`, optional `policy`). The fold learned to read it.

### Rejected

- **Roster reads `audit` instead of the table.** `residency status`, `seatWakeabilityFacts`, and
  the ADR 191 wake-pool all already join the table. A second reader would drift.
- **A seventh kind.** The events already have a tag. A new kind would dual-ship or break ADR 371
  §4's set.
- **Copy `grant_id`.** The token never travelled; the id is meaningless off the origin and would
  FK-fail or dangle.

## Consequences

- The hub roster shows a joiner-enrolled seat as `wakeable`. `musterd residency status` on the hub
  lists it. `musterd status` on the demo floor can name delta `wakeable · resumable` when a
  session has been captured there.
- ADR 365 Decision 1 still holds for the six wake verbs and the rest of the ledger set. This ADR
  is the named exception, not a silent widening.
- `wake_leases` and `host_liveness` stay local. A folded enrollment does not make a remote host
  look reachable from here (`host_reachable` is undefined until this daemon has heard a poll).
- An unresolved seat on enroll/revoke stops the fold. Members replicate via git; a stop that
  outlives a roster pull is a roster defect, not a residency one.

## Observability & Evaluation

**Traces.** No new span. The existing fold-stop line for `unresolved_seat` now also fires when a
folded `residency.enrolled` / `residency.revoked` names a seat this roster lacks (git lag). A
stop that outlives a roster pull is the defect. No new log line: a successful projection is
silent, same as `lane.*`.

**Eval.** Dataset: two in-process daemons, one HTTP enroll of `ada` on the joiner, one round-trip
(`sync/ledger.test.ts` case 5). Baseline, measured 2026-09-04 on delta (`docs/perf/cloud-seat.md`
finding 6): hub roster showed the seat plain `offline`; hub `residency status` listed the laptop's
five seats, not delta. After: hub `listWakeableMemberIds` contains ada, the folded row's `host` is
the joiner's, `grant_id` is null, a revoke on the joiner drops the hub row, and
`claimWakeLeases` on the hub for a host that is not the joiner's returns `[]`. Revert
`projectResidencyLedger` and case 5 fails. Live eval: two machines, one enroll — hub
`musterd status` shows the joiner's seat `offline · wakeable`; hub `POST /residency/wake-leases`
for the hub's hostname still derives nothing for that seat. A rise in hub `residency.wake_leased`
targeting the joiner's seat is the decision crossing, and means the host filter was lost.

**Experiment.** None — no flag, no rollout. A single-machine team folds no foreign enrollment.
