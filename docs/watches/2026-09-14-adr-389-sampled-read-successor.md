---
question:   Over thirty days of `guardian.sampled` rows, does the stack sample ever read `wedged` on a stall that `/health` recovered from on its own — ADR 389's one-instance disarm number — and does it read parked or not-taken on everything else? Asked over a window long enough to reach the floor the seven-day predecessor could not, and with the `???` (V8 JIT) shape named in advance.
claim_ref:  docs/decisions/389-the-wedged-daemon-recovery-policy.md
falsifier:  "ONE row with `wedged: true` whose tick is followed by `guardian.stall_recovered` (health returned with no restart) disarms the class and re-opens ADR 389 §1 — the sample was not decisive. The converse does not arm anything: a month of `wedged: false` / `taken: false` rows says only that no wedge occurred, and a month of `wedged: true` rows each followed by a real outage says the sample agreed with the outcome on this host, which is the precondition for building the restart (ADR 389 §4), not the eval of it."
population: every `guardian.sampled` line in `~/.musterd/guardian/guardian.log` between 2026-09-14 and revisit_by, each joined to the `guardian.stall_recovered` / `guardian.alerted` / `guardian.down_deferred` lines of the same and the next tick. The four rows written before this watch opened (2026-09-06 and 2026-09-14 09:00–09:33) are excluded by date; they are recorded in the predecessor's resolution and all four have the falsifier's shape.
void_if:
  - fewer than 5 `guardian.sampled` rows exist in the window. The predecessor saw ONE in seven days and the log shows about one every two days since #1308; below 5 the read measures how often the daemon stalled, not what the sample said when it did, and MUST NOT be read as the falsifier
  - `parseSample`, `LOOP_POLL_FRAMES`, `WEDGED_FRAME_SHARE` or `RUNTIME_IMAGE` change within the window (packages/cli/src/guardian/sample.ts) — the verdict then moves under the measurement. A change that decides what `???` means is exactly this clause: it re-opens the question, it does not answer it
  - the guardian's tick cadence or probe bounds change within the window, because the "persisted across ticks" condition that gates the sample moves with them
series:     `grep guardian.sampled ~/.musterd/guardian/guardian.log` — the guardian writes one line per sampled tick, armed or not, promoted or not. There is no second sampler; the guardian log is the whole instrument
cadence:    read once, at revisit_by
opened:     2026-09-14
opened_by:  ryder
revisit_by: 2026-10-14
status:     open
---

Opened by the resolution of `2026-09-05-adr-389-sampled-read.md`, which voided on volume: one row in
seven days against a floor of five. That is not a verdict on the sample, it is a measurement of how
rarely the daemon stalls now that #1308 removed the SQLite trigger — the rate fell from 7–13
clean-exit-unreachable ticks a day to about one every two days.

**Why thirty days, the number nick cut.** The cut was right for the rate the watch was opened under
and wrong for the rate it met. At one row every two days a floor of five needs ten days at best, and
the predecessor's own reasoning holds: the falsifier needs one row, so more days do not make it
likelier, only later. Thirty is the smallest round window that clears the floor with margin, and
ADR 297's rollover check is the reader nothing had in the ADR's original "30 days".

**What the reader must not do.** The four rows in hand all read `wedged: true` with `frame: ???`,
`entry: null`, share ≥ 0.996, and every one was followed by `stall_recovered` within four minutes.
That is the falsifier's exact shape, four times, and the temptation is to call it now. The
pre-commitment forbids it below the floor, and the successor keeps the floor for the same reason the
predecessor set it: five rows written on a stall that healed are a *pattern* of the sample being
non-decisive; one or four are anecdotes the reader already knows about. If the window reaches five
and they look like the four, the class is disarmed and ADR 389 §1 re-opens on the specific question
the rows pose: `???` means the main thread was executing JavaScript (V8 JIT code carries no symbol)
and the loop was not polling — *held* by the ADR's restated rule — yet `/health` came back on its own
every time. A restart fired on any of them would have killed a daemon that was about to recover,
which is the one direction the class must never be wrong in.

**What this watch cannot tell you** is unchanged: it reads the sample's agreement with the outcome,
not any restart's success, because no restart exists. A positive month leaves the arming decision to
a human reading these rows; it does not arm anything.
