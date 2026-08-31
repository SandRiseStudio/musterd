# Residency ledger undercount

Any session count read from `residency.session_captured` rows that crosses 2026-08-28 undercounts real sessions by an unmeasured amount — heal-path sessions before ADR 336's fix left zero rows for their whole life.

## The warning, for anyone counting sessions from the ledger

Before #1110 (merged 2026-08-31 as `a647b9cc`), a session that took the workspace slot by the
tool-boundary heal — gated at SessionStart beside a live-looking occupant, handed the slot at its
first tool boundary — was never attested. It ran, acted as the seat, and produced **zero**
`residency.session_captured` / `residency.session_ended` rows (2026-08-28; falsify: query the
`audit` table for digest `982f768adf12` — the incident session in
[ADR 336](../decisions/336-attestation-follows-the-slot.md) — and find any row).

So a residency-based read — sessions per seat per day, wake cost per session, "was this seat
occupied at time T" — is a floor, not a count, for any window touching pre-`a647b9cc` data. Do not
compare session counts across 2026-08-28; say the undercount instead. ADR 336's Consequences names
this; this page exists so an analyst hitting the `audit` table finds it without reading the ADR.

Known instances, both 2026-08-28, both found by reading the `messages` table against the ledger:

- seat `ryder`: a two-hour interactive session (claimed a lane, closed one) — digest
  `982f768adf12`, zero rows; the newest row the daemon held for the seat was a wake child ended
  ninety minutes earlier.
- seat `dolly`: the superseded-seat overlap on lane `01KZ9GQN3EC77` — the second session of the
  pair was recoverable only from `messages` (dolly, first-hand, on #1110's review thread).

The general method when the ledger disagrees with behaviour: the `messages` table is the stronger
witness — a seat that sent acts had a session, whatever the ledger says.

## What the fix guarantees, and what it does not

Since `a647b9cc`, the tool boundary reconciles: an un-ended slot with no `attested_at` is announced
once, stamped only when the push lands (`attestSlotIfUnattested`, plus the same re-read pattern on
the capture path). Bounds that stay true after the fix:

- A gated session that never reaches a tool boundary still announces nothing — it also did no work.
- An unreachable daemon leaves the slot due, so the row can arrive minutes late; `started_at` never
  travels, so row timestamps were never session start times (ADR 336 Consequences).
- Co-tenancy (two live sessions on one seat) is still not signalled to either session; the ledger
  now sees both, but nothing tells them about each other.

## Post-fix live observation — owed, not yet made

The post-change arm of ADR 336's experiment is unit tests only (five tests, four mutations). The
owed live observation — a real gated-then-healed session producing its first
`session_captured` row at a tool boundary on a build ≥ `a647b9cc` — has not been made yet
(2026-08-31; falsify: a dated entry below records it).

The signature to watch for, usable as a detector: a workspace `binding.json` whose
`session.attested_at` is minutes after `session.started_at`, whose digest's **first** audit row
carries that late timestamp, with no earlier row for the digest. (A lost-stamp reconcile looks
similar but has an early first row — seat `ryder`'s session of 2026-08-31 14:09, digest
`e0ac6abbd891`, is that benign shape: captured at start, re-announced at 14:10:33.) The natural
trigger needs a newcomer starting within `LOCAL_SESSION_LIVE_MS` (10 min) of a still-live occupant
that then ends — wake child beside an interactive session is the common case.
