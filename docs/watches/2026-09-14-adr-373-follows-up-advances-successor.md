---
question:   Do lanes named by a `Follows-up: <lane-id>` marker advance past `open` more often than lanes opened in the same window from any other source — asked over a window long enough to reach the floor the predecessor could not?
claim_ref:  docs/decisions/373-a-recorded-intention-names-its-lane.md
falsifier:  "A `Follows-up:`-sourced lane advances no more often than a lane from any other source. ADR 373 pre-commits to DELETING the intents gate on that result rather than widening it. A higher advance rate does not prove the marker caused it; it only leaves the gate standing."
population: every `Follows-up: <lane-id>` first written between 2026-09-12 and revisit_by (first appearance by `git log -S`, so a marker copied into a second document is one marker), against every lane opened in the same window from any other source, both read from the daemon's lane store at revisit_by. The predecessor's backfill (the six lanes marked on 2026-09-03 in #1251) is excluded by date.
void_if:
  - fewer than 8 `Follows-up:`-sourced lanes exist in the window (the predecessor saw ONE in seven days; below the floor a null measures volume, not behaviour, and MUST NOT be read as the falsifier)
  - the scanned surfaces or `FORWARD_RE`/`STRUCTURAL_RE` change within the window (scripts/intents.ts), because the candidate set then moves under the measurement
  - lane states are backfilled or migrated within the window
series:     the daemon's lane store plus `pnpm intents:ingest --dry-run` over the repo at both ends; there is no sampler
cadence:    read once, at revisit_by
opened:     2026-09-14
opened_by:  ryder
revisit_by: 2026-11-13
status:     open
---

Opened by the resolution of `2026-09-04-adr-373-follows-up-advances.md`, which voided on volume: one
marker in seven days against a floor of eight. That is not a verdict on the marker, it is a
measurement of how often ordinary work writes a forward reference — about one a week once the
2026-09-03 backfill is excluded.

**Why sixty days when ADR 373 called ninety the pathology.** The ninety-day objection was that
nothing would read it. That objection is now structural rather than cultural: `revisit_by` breaks
`format:check` on rollover (ADR 297 rule A), so an unread window records itself as `void:
unattended` instead of vanishing. What ninety days could not buy in 2026-09-04 — a reader — the
checker now supplies. Sixty days at the observed rate is roughly the floor; a second void on volume
would then be the finding, and the honest disposition of the gate follows from ADR 373's own rule.

**What this watch cannot tell you** is unchanged from its predecessor: association, not cause. A
seat that writes the marker has already decided the work is worth a lane. The falsifier is
one-directional on purpose.
