# 203 — A claim refuses a lane a live teammate owns

- Status: accepted
- Date: 2026-08-01
- Authored by dolly (lane `01KYXWNX9RAWZ6QXSZ67C7PNT6`), after causing the collision it fixes
- Builds on: [ADR 083](083-lanes-phase1-intent-dependency.md) (lanes, and the warn-never-block posture this
  deliberately makes one exception to), [ADR 196](196-roster-hygiene-departed-claims-observer-cap.md)
  (departed seats' in-flight lanes are released — the same live-vs-departed line drawn here),
  [ADR 169](169-two-stage-close.md) (the close edge's audit row, whose comment
  already assumed a claim row existed).

## Context

`lane_claim` was a bare PATCH of `owner_seat`. Nothing checked whether the lane was already owned.

On 2026-08-01 that produced the exact failure the board exists to prevent. miley claimed lane
`01KYX8J5XD` at 22:00:48. dolly claimed the same lane at **22:06:34 — 5m47s later** — and the server
said yes: `owner_seat` moved, `[lane] claimed` went to the team feed, and the caller got a success.
Both seats built. Two PRs landed doing overlapping work (#571, #572), including the _same_ refactor
discovered independently, and one had to be conflict-resolved by hand.

This is not a race. Six minutes is not a window anyone can be asked to close by reading the board
faster — and the claimant _had_ read it, immediately before claiming.

## Problem

Three defects, each of which hid the next:

1. **No ownership guard.** The one invariant musterd sells — "never build in a lane a teammate owns"
   — was advice, not a check. `lane_claim`'s own description said it "runs the contention checks";
   it ran surface-overlap warnings and never looked at `owner_seat`.
2. **A stale `claimed_at` laundered the takeover.** `updateLane` kept `existing.claimed_at` on any
   ownership change, because the release path (owner → open → owner) was assumed to be the only way
   an owner changed. A **direct** owner → owner move never passes through null, so the new holder
   inherited the previous holder's stamp. The `lane_claim` response therefore reported the lane as
   claimed at 22:00:48 — the incumbent's time — and the taker read it as their own. The single field
   that could have said "someone has held this for six minutes" instead corroborated the mistake.
3. **No audit row.** `lane.claimed` did not exist. Every other lane edge writes one, and the comment
   on `lane.released` even reads "traceable for the same reason a claim is" — an assumption the code
   never honoured. Reconstructing the collision from the audit log turned up nothing but the release
   that undid it, which is why the first written diagnosis of this incident was **wrong about which
   seat claimed first**.

## Decision

### 1. A self-directed claim on a live owner's lane is refused (409)

A **claim** and a **handoff** are the same PATCH, and the server can tell them apart by the one
signal it already holds: _who the new owner is_. Taking it for **yourself** is a claim; naming
**someone else** is a handoff — a deliberate give-away that must keep working. So the guard fires
only on self-directed takeovers.

It fires only while the incumbent is **live**. An offline or departed owner's lane stays claimable,
which is the same line ADR 196 drew when it released departed seats' in-flight lanes: absence is not
ownership. The error names the incumbent, so the answer ("ask them to hand it over, or pick another
lane") is actionable rather than a bare conflict.

**This is a deliberate exception to ADR 083's warn-never-block posture.** Surface overlap is advisory
because two lanes touching one file is often fine and only the humans can judge. Two seats owning one
lane is never fine, and the cost of being wrong is measured in duplicated PRs, not in friction.

### 2. A new owner always starts a new tenure

`claimed_at` re-stamps whenever `owner_seat` actually changes, instead of only when it passes through
`null`. This restores what the field's own comment already claimed it meant, and removes the signal
that made a takeover indistinguishable from a first claim.

### 3. Every ownership acquisition writes `lane.claimed`

With `kind: 'claim' | 'handoff'` and `previous_owner`, because after the fact those are the same
PATCH and only the audit can separate them.

> **Completed 2026-08-01 (#579).** As shipped, this section covered the PATCH edge only — a lane
> _born_ owned (`lane_open {claim:true}`, the most common acquisition there is) wrote no row, so
> the heading overclaimed. The birth edge now writes `lane.claimed` too, marked `at_open: true`
> with `previous_owner: null` so a reader can tell a birth from a takeover. A lane opened
> _without_ `claim` writes nothing — an unowned lane being born is not an acquisition.

## Consequences

- The board's core guarantee is enforced rather than advised; `lane_claim`'s description now matches
  what it does.
- A seat that meets the refusal has a named person to talk to — the coordination move, not a retry.
- Handoff is untouched, including handing a lane to a live seat.
- Lane ownership finally has a full audit trail: acquired, released, closed.
- A takeover of an offline owner's lane is still allowed, now recorded rather than silent.

## Observability & Evaluation

- **Traces.** `lane.claimed` on every acquisition (`kind`, `previous_owner`,
  `takeover_of_offline_owner`); the refusal surfaces as a 409 to the caller.
- **Eval.** Baseline: one confirmed double-build (2026-08-01, ~1h of duplicated work across two
  seats, one hand-resolved conflict) and zero audit rows describing it. Success: no lane reaches two
  owners while both are live, and any takeover of an offline owner is attributable from the audit
  log alone.
- **Experiment.** n/a — a correctness guard on an invariant the system already claimed to hold.
  There is no arm in which permitting silent double-claims is the better outcome, so there is nothing
  to compare against. The honest measurement is the counter above, not a trial.
- **Watch for.** A seat blocked by a stale live-presence reading — if a crashed session keeps a seat
  "live" past its presence timeout, its lanes become unclaimable until the reaper catches up. The
  refusal names the incumbent, so the failure is legible rather than mysterious, and `lane_release` /
  `reclaim` remain the escape hatches.
