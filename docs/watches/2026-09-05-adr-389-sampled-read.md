---
question:   Over one week of `guardian.sampled` rows, does the stack sample ever read `wedged` on a stall that `/health` recovered from on its own — ADR 389's one-instance disarm number — and does it read parked or not-taken on everything else?
claim_ref:  docs/decisions/389-the-wedged-daemon-recovery-policy.md
falsifier:  "ONE row with `wedged: true` whose tick is followed by `guardian.stall_recovered` (health returned with no restart) disarms the class and re-opens ADR 389 §1 — the sample was not decisive. The converse does not arm anything: a week of `wedged: false` / `taken: false` rows says only that no wedge occurred, and a week of `wedged: true` rows each followed by a real outage says the sample agreed with the outcome on this host, which is the precondition for building the restart (ADR 389 §4), not the eval of it."
population: every `guardian.sampled` line in `~/.musterd/guardian/guardian.log` between 2026-09-05 and revisit_by, each joined to the `guardian.stall_recovered` / `guardian.alerted` / `guardian.down_deferred` lines of the same and the next tick. Rows written before the daemon's checkout bounced onto e4f5a5e5 (#1335) carry the OLD parser's verdict — read those by their `frame` column, not their `wedged` flag; the parser correction is exactly what changed how a leaf is judged.
void_if:
  - fewer than 5 `guardian.sampled` rows exist in the window. Rows are written only on a clean-exit-unreachable tick (three failed 2 s probes, a failed 10 s confirm, launchd reporting no exit); the log shows 7–13 such ticks per day on 2026-09-01..04 and none yet on 09-05 after #1308's prevention landed. Below 5 the read measures how often the daemon stalled, not what the sample said when it did, and MUST NOT be read as the falsifier
  - `parseSample`, `LOOP_POLL_FRAMES` or `WEDGED_FRAME_SHARE` change within the window (packages/cli/src/guardian/sample.ts) — the verdict then moves under the measurement
  - the guardian's tick cadence or probe bounds change within the window, because the "persisted across ticks" condition that gates the sample moves with them
series:     `grep guardian.sampled ~/.musterd/guardian/guardian.log` — the guardian writes one line per sampled tick, armed or not, promoted or not (ADR 389 Observability, as corrected: the log, not the audit). There is no second sampler; the guardian log is the whole instrument
cadence:    read once, at revisit_by
opened:     2026-09-05
opened_by:  izzo
revisit_by: 2026-09-12
status:     open
---

Opened because ADR 389 said "arm only after 30 days of `guardian.sampled` data" and nothing was
scheduled to read it — the shape ryder's ADR 373 watch refused the day before. nick cut the window
to a week on 2026-09-05: *"30 days is way too long, how about a week."*

**Why a week is enough here, and what the floor is for.** The falsifier is one-directional and
needs one row: a single `wedged: true` on a stall that healed itself is the disarm. Thirty days
would not make that row more likely to appear; it would only delay reading whatever rows exist. What
a week *cannot* guarantee is that any rows exist at all — #1308 removed the known SQLite trigger the
day before this opened, and 2026-09-05 has produced no clean-exit-unreachable tick so far. A week of
zero rows is therefore ambiguous between "the sample is trustworthy" and "nothing happened to
sample", and those send a reader in opposite directions. The `void_if` floor of 5 decides that in
advance: below it the verdict is *void — volume*, which is itself worth knowing (a daemon that no
longer wedges needs no wedge recovery), and is not a pass.

**What this watch cannot tell you.** It reads the sample's agreement with the outcome, not the
restart's success — no restart exists to measure. ADR 389's Eval question ("of the incidents that
reached a restart, what fraction were followed by health holding three ticks?") starts only when
the class is armed, and this watch is the gate on whether that ever happens. A positive week leaves
the arming decision to a human reading these rows; it does not arm anything.

**How to read the series.** Each `guardian.sampled` line is JSON: `taken`, `wedged`, `frame`,
`entry`, `share`, `samples`, `pid`, `reason`, `promoted`. Join on timestamp to the surrounding
`guardian.down_deferred` (the first sighting, sample already taken) and either
`guardian.stall_recovered` (health came back — the disarm test applies to this row) or
`guardian.alerted` with class `daemon_wedged` / `daemon_down` (it did not). The one row that matters
is `wedged: true` followed by `stall_recovered`.
