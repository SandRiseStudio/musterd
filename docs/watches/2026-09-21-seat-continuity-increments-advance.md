---
question:   Did the seat-continuity plan survive its first increment landing — have lanes 2–5 advanced past `open`, or did the plan die the way multi-increment plans on this team die?
claim_ref:  docs/superpowers/plans/2026-09-21-seat-continuity.md
falsifier:  "On revisit_by, at least three of lanes 01M32FH5YQD4EVTG6ARSS0S0SG, 01M32FHKKQXKH9W96XF3G4CT3J, 01M32FHX6JHCVNQRGRAHHMTEJN, 01M32FJ8T49EGFJV659DNBEMKK are in a state other than `open` (claimed/active/blocked-with-owner/awaiting_acceptance/done/abandoned-with-note). Fewer than three, with increment 1 done, is the drop pattern nick named on 2026-09-21 — and then the fix is not a reminder but a mechanism: a goal whose lanes stay open past a dated horizon should surface on team_next as overdue, which is its own lane."
population: the four lane ids above, read from the daemon's lane store on revisit_by; lane 01M32FGSXKZZDTQAPBACZFMPS0 (increment 1) is the control and is expected done.
void_if:
  - nick retracts the seat-continuity goal (team_goal_retract) inside the window
  - the four lanes are abandoned WITH a recorded reason that the premise died (that is the plan working, not dropping)
series:     the daemon's lane store; `musterd lane board --goal seat-continuity` at revisit_by; there is no sampler
cadence:    read once, at revisit_by
opened:     2026-09-21
opened_by:  stanley
revisit_by: 2026-10-19
status:     open
---

Opened the day the plan was written, on nick's instruction that the plan be captured somewhere it
cannot be dropped: "we come up with this grand plan, and then we start implementing by creating an
initial lane for increment 1 … increment 2, 3, 4 etc get lost because the member gets distracted by
other asks or finds new bugs."

**What this watch is for.** The structural answer already taken is: every increment has a lane
from day one, chained by `depends_on` under one goal, so the board — not a seat's memory — carries
the plan. This watch tests whether that structure is enough. A pass says lanes opened up front
survive their author's attention span. A fail is the more useful result: it says the board can
hold a plan but nobody reads it, and the next lane is a `team_next` overdue signal, not a better
plan document.
