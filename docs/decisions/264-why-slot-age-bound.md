# 264 — The `why` slot is bounded by age when nothing else can retire it

- **Status:** accepted 2026-08-13
- **Relates to:** ADR 049 (the orientation brief this repairs), ADR 084 (one server-side projection,
  rendered by both surfaces), ADR 173 (absent-is-not-unknown / abstain-by-showing — the rule this
  bounds rather than overturns), ADR 231 (#662 — every handoff carries its lane in `meta`, which is
  what makes the bare population finite), PR #745 (the discharge rule for handoffs that name a lane).

## Context

`team_next` / `musterd next` close with a `why —` line: the latest handoff addressed to this seat or
the team. It is the one line in the brief written by a person for a reader, and it is read as a
standing instruction.

PR #745 gave it a discharge rule: a handoff whose named lane has left play (submitted for acceptance
or terminal) is skipped. That rule keys on a **recorded fact** — the state of a lane the handoff
names, in `meta` since ADR 231 or in prose for the population that predates it.

A handoff that names no resolvable lane has no such fact. `handoffNamedLaneOutOfPlay` returns false
for it, permanently, and nothing else looks at it. The consequence was not theoretical:

**Measured 2026-08-13 by replaying the real orientation query for every member against the live
ledger:**

- **21 of 22 seats** had a lane-less handoff in the `why` slot. Exactly one seat's `why` named a
  live lane.
- **19 of those seats read the same line** — a 38-day-old completion notice from stanley, `"@izzo
ADR 100 landed — PR #133 (squash 9a3cea9), lane resolved"`, addressed to one seat, broadcast to
  the team, and thereafter served to nearly everyone as their standing instruction.
- The lane that prompted this found its own case (a 15-day-old handoff telling miley to add
  `jsx-a11y` coverage that had shipped in #493 two weeks earlier) by noticing the _content_ was
  dead. That is the only detection method the surface offered, and it took fifteen days.
- Of 35 handoffs in the ledger, 11 name their lane in `meta`, 16 in prose, and 9 name none at all.

The `why` slot had therefore inverted: the line designed to carry the most weight was, team-wide, a
month-old announcement about finished work.

## Decision

**A handoff that names no resolvable lane gives up the `why` slot after `WHY_BARE_MAX_AGE_MS` = 14
days.** Everything else is unchanged.

Three deliberate limits keep this from becoming a general staleness heuristic:

1. **Age is the last resort, used only where no recorded fact exists.** A handoff naming a live lane
   keeps the slot however old it gets — that lane _is_ the fact, and it outranks the clock. Age is
   consulted only for the case where nothing can ever retire the handoff otherwise.
2. **The `why` slot only. Wake candidacy is untouched.** `handoffNamedLaneOutOfPlay` is shared with
   the wake path and keeps ADR 173's posture exactly. The trade genuinely differs: a wake that
   should not have fired costs money and a handoff that stops asking costs work, and only one is
   recoverable — but a dead instruction in the brief is not an abstention, it is misdirection, paid
   by every seat every session.
3. **The bound is set from the data, not from taste.** Across the 24 handoffs whose named lane
   resolved, the subject work closed in a **median 0.9d, p75 3.1d, p90 5.1d, p95 6.6d, max 12.8d**.
   Fourteen days sits above the entire observed distribution: it can retire nothing that has ever
   still been live, while retiring every stale line in the ledger today.

**And whatever is served is dated.** The CLI already rendered the handoff's date; the MCP rendering
did not, so the harness surface — the one agents actually read — gave no way to tell a live
instruction from a month-old one. `team_next` now renders `(15d ago)` beside the author. This is the
half that generalises: the bound retires the dead, the age lets a reader judge the living.

## Consequences

- 21 seats stop being handed dead instructions; the 19 reading the ADR 100 notice lose it
  immediately, since every bare handoff in the ledger today is older than 14 days.
- A genuinely long-lived handoff that names no lane will now expire. The mitigation is the one ADR
  231 already established — name the lane, and the recorded fact governs instead of the clock. The
  measured cost of _not_ bounding it is 21 seats; the measured cost of bounding it, against this
  ledger, is zero handoffs that were still live.
- `deriveNext` takes an injectable `now`, so the bound is testable without touching the clock.
- This does **not** add a discharge act for handoffs. That remains the principled end state — only a
  recorded fact earns a label — but it requires compliance and would have cleared none of the 21
  existing lines. It is the next increment if the bound proves too blunt.

## Observability & Evaluation

**Traces.** None new. The `why` row already carries `from`, `ts` and `goal_id`; the age now rendered
by `team_next` is derived from `ts` at read time, so there is nothing extra to record. A handoff
retired by the bound simply stops appearing — visible as `why: null` in the brief.

**Eval.** Dataset: the replay above — for every member of `revive`, the newest 20 handoffs addressed
to them or the team, resolved to whichever holds the `why` slot. Baseline, measured 2026-08-13
before this change: **21 of 22 seats served a lane-less handoff, 19 of them the same 38-day-old
notice; 1 of 22 served a handoff naming a live lane.** After: no seat's `why` may be a lane-less
handoff older than 14 days, so the expected reading is 0/22 stale. Re-run at 14 and 30 days —
the second reading is the one that matters, since it is the first window in which a handoff written
_after_ this ADR can have aged out.

**Experiment.** None. Observational before/after against the live ledger; the population is the
whole team, so there is no control arm to hold back. The signal that the bound is wrong is
qualitative and must be watched for rather than computed: a seat reporting that a handoff went quiet
while its work was still live. One such report justifies raising the bound or building the discharge
act instead; none within 30 days is the evidence that age was a sufficient proxy here.

## Falsifier

Re-run the replay: for every member, walk the newest 20 handoffs addressed to them or the team and
take the first still in play. If any seat's `why` is a lane-less handoff older than 14 days, this
did not hold. If a seat reports a handoff that expired while its work was genuinely still live, the
14-day bound is set too low and the measured distribution above should be re-taken.
