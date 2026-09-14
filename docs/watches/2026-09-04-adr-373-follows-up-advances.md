---
question:   Do lanes named by a `Follows-up: <lane-id>` marker advance past `open` more often than lanes opened in the same window from any other source?
claim_ref:  docs/decisions/373-a-recorded-intention-names-its-lane.md
falsifier:  "A `Follows-up:`-sourced lane advances no more often than a lane from any other source. ADR 373 pre-commits to DELETING the intents gate on that result rather than widening it — the disposition ADR 180's eval reached for the advisory reviewer. A higher advance rate does not prove the marker caused it; it only leaves the gate standing."
population: every `Follows-up: <lane-id>` written between 2026-09-04 and revisit_by, read from `pnpm intents:ingest --dry-run` at both ends, against every lane opened in the same window from any other source. Both arms come from the daemon's own lane store, so neither depends on a seat reporting anything.
void_if:
  - fewer than 8 `Follows-up:`-sourced lanes exist in the window (the corpus held 9 on the day this opened; below that a null result measures volume, not behaviour, and MUST NOT be read as the falsifier)
  - the scanned surfaces or `FORWARD_RE`/`STRUCTURAL_RE` change within the window (scripts/intents.ts), because the candidate set then moves under the measurement
  - lane states are backfilled or migrated within the window
series:     the daemon's lane store plus `pnpm intents:ingest --dry-run` over the repo at both ends — there is no sampler, and that is a known weakness of this watch
cadence:    read once, at revisit_by
opened:     2026-09-04
opened_by:  ryder
revisit_by: 2026-09-11
status:     void
resolution: "VOID — below the volume floor, exactly as pre-registered. ONE `Follows-up: <lane-id>` marker was written in the window 2026-09-04..2026-09-11 (01M1Q9D90XEP9FPCYPQNBFH73Q, ADR 232, commit e6d52d09, 2026-09-04); the floor is 8. The other five lane-id markers in the tree (six distinct lanes across 11 lines) were all written 2026-09-03 in ADR 373's own PR (#1251, 5fe92d71), the day BEFORE the window, and the 9 counted at opening were that backfill. NO VERDICT is read from this: the pre-commitment says a null below the floor measures volume, not behaviour. Recorded for the successor, not as a result: the one in-window marker's lane is `done`; of the six marker-named lanes overall 4 are `done`, 1 `claimed` and 1 `open` (both human-gated holds); base rate in the window: 82 lanes opened from any source, 74 past `open` (64 done). `FORWARD_RE`/`STRUCTURAL_RE` unchanged in the window (scripts/intents.ts last touched 2026-09-03). The finding this watch CAN support is about volume: a week of ordinary work produced one marker, so the week-long window ADR 373 chose cannot reach its own floor. Successor: 2026-09-14-adr-373-follows-up-advances-successor.md, a 60-day window with the same floor."
---

Opened because the window in ADR 373 was ninety days and nothing was scheduled to read it — which
is the exact shape the ADR exists to refuse. An intention recorded in the right document, by the
person best placed to know, that no surface can see, is what the 2026-09-03 sweep spent four hours
finding nine of. A 90-day experiment with no watch would have been the tenth.

**The window is a week on nick's call (2026-09-04), and the honesty cost is the floor.** Seven days
is short for this measurement: nine lane-disposed markers existed when it opened, and a week of
ordinary work may add few. A small null is therefore ambiguous between "the marker changes nothing"
and "not enough markers were written to tell" — and those two send a reader in opposite directions,
one to delete the gate and one to wait. The `void_if` floor of 8 resolves it in advance rather than
after seeing the number, which is ADR 297 rule 4's whole point and the difference between the two
ADR 166 watches that shipped together.

**What this watch cannot tell you.** It measures association, not cause. A seat that writes
`Follows-up: <lane-id>` has already decided the work is worth a lane; the marker may be recording
that intent rather than creating it. Ruling that out needs a comparison this corpus cannot supply —
the same intention written both ways by the same author — so a positive result leaves the gate
standing without proving it earned its place. The falsifier is one-directional on purpose.
