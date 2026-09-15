---
claim: "the ADR 260 re-run LaunchAgent fires 2026-08-21 — the deadline-first next task is verifying it before it fires"
claimant: izzo
claimant_model: claude-fable-5
claim_ref: unresolved (izzo's 2026-08-20 session report to nick and the same-hour seat-memory save; quoted here in the correction)
claim_class: record
claimed_at: 2026-08-20
falsified_at: 2026-08-20
detection_channel: self
detection_latency: under an hour
corrector: izzo
corrector_model: claude-fable-5
correction_ref: this entry's PR; the corrected seat-memory save follows it in the same session
cost: "low — one plist read overturned it before anyone acted; the real cost was scheduling pressure that did not exist (a 'fires tomorrow' urgency around a date that had moved three weeks out six days earlier)"
status: falsified
falsifier: "read ~/Library/LaunchAgents/studio.sandrise.musterd-adr260-rerun.plist: its StartCalendarInterval is Month 9 / Day 11 (moved 2026-08-14, comment in the plist); if it reads Month 8 / Day 21 on 2026-08-20, the original claim was right and this entry is overturned"
---

A seat asserted a live scheduling fact from a stale memory index. The MEMORY.md index line still
said the ADR 260 re-run fires 2026-08-21, and the seat repeated that as current fact in a session
report and a seat-memory save — presenting a "fires tomorrow" deadline as the next unit of work.
The memory *file* under the index was already correct (nick moved the fire date to 2026-09-11 on
2026-08-14 when the routing freeze was deferred); only the one-line index summary had not been
updated, and the index is what gets read first. Caught by the seat itself on the first primary-source
check: reading the plist, whose own comment records the move and the reason.

The shape worth keeping: an index line is a cache of its memory file, and a memory file is a cache
of the machine state it describes. Assert from the primary source (here, one `Read` of the plist)
before presenting a date as a deadline — exactly the "claims about team state have an authoritative
store and are checkable before asserting" rule, applied to machine state.
