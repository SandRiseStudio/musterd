# 288 — Goal retract: a withdrawal is a signal, never a deletion

- Status: accepted
- Date: 2026-08-19
- Relates to: ADR 048 (declared skeleton, derived flesh), ADR 084 (lanes join the Plan),
  ADR 256 (goals are the board's front door), ADR 257 (retire the numeric wave),
  ADR 258 (shipped goals carry evidence)

## Context

A Goal is a projection over the append-only message log (ADR 048/084): a `message` act to `@team`
carrying `meta.goal`, no new act, no new table. Nothing about a Goal is a row, so nothing about a
Goal can be deleted — and until now nothing could be *withdrawn* either. The board has needed that
three times: `verify-adr111-scratch` ("delete after" was in its own title), ADR 256's rollout note
"retire the scratch goals", and `launch-readiness` (2026-08-19, merged into `launch`). Each time
the remedy was the same hack — retitle to "RETIRED —" and shelve with `wave: later` — leaving a
permanent decoy row on the exact surface ADR 256 shipped to keep legible for strangers.

The cautionary scar cuts the other way too: ADR 257 records how goals once *nearly vanished
silently* when a schema tightening would have dropped legacy declarations from the fold with no
error. Whatever withdrawal looks like, it must be loud, attributable, and reversible.

## Decision

- **`meta.goal_retract { goal_id }` on an ordinary team-visible `message` act** — the ADR 258
  pattern (`goal_outcome`), reused verbatim. No new act, no new table, no row deletion. ADR 048's
  standing bet holds.
- **Latest signal wins, by `ts`, against the newest declaration.** A retract after the newest
  declaration marks the Goal `retracted: { by, at }` in the read projection; a re-declaration
  after the retract clears it. Retraction is therefore reversible by the same verb that created
  the Goal.
- **Hidden by default, never gone.** `goal list` / `team_goals` / the web grid hide retracted
  Goals but count them ("N retracted — `--all` / `include_retracted` shows them"). `nextGoal`
  never offers one. The declaration and the retraction both stay in the log forever.
- **Lanes on a retracted Goal stay visible.** The grid drops the Goal's card but its lanes fall to
  the undeclared-goal card, exactly as lanes naming a never-declared id do — work never disappears
  because its Goal was withdrawn.
- **Retraction is unauthenticated, like declaration** (ADR 048: warn-never-block,
  roster-governance-not-work-approval). Provenance is carried (`retracted.by`), not enforced.
- Surfaces: `POST /teams/:slug/goals/retract`, `musterd goal retract <id>` (+ `goal list --all`),
  `team_goal_retract` (+ `team_goals {include_retracted}`), and the grid filter.

## Alternatives rejected

- **Row deletion / a stored `deleted` flag** — reverses the derive-don't-store posture ADR 258
  re-affirmed this month, and reintroduces exactly the silent-disappearance failure ADR 257 met.
- **A new `retract` act** — ADR 048's seam explicitly avoided new acts for goal metadata; the
  outcome note (ADR 258) already proved the meta-on-message pattern carries this weight.
- **Keep the retitle-and-shelve convention** — leaves permanent decoy rows on the front door and
  makes withdrawal unqueryable; conventions in titles are invisible to `nextGoal` and the grid.

## Consequences

- The "RETIRED —" title hack is obsolete; `launch-readiness` and `verify-adr111-scratch` get
  retracted for real once this lands.
- A retracted Goal that later matters again is one `goal declare` away — and the round trip is
  honest history, not an edit.
- The fold gains one more signal type read out of the same ts-ordered scan; pre-declaration
  retractions queue like early outcome notes, so signal ordering cannot drop one.

## Observability & Evaluation

- **Traces:** every retraction is an ordinary team message in the append-only log
  (`meta.goal_retract`, with sender and ts) — the audit trail is the mechanism itself. Surfaces
  count hidden goals out loud ("N retracted"), so a withdrawn Goal is never silently gone.
- **Eval:** after 5 real retractions, read them back: did any get re-declared (was reversibility
  used)? Did any lane sit attached to a retracted Goal for >7 days (the orphan-card path working,
  or work forgotten)? If the count of title-hack retirements ("RETIRED —" prefixes) is not zero
  by then, the verb failed to displace the convention.
- **Experiment:** none — this is a small closed seam, not a behavior change worth a cell.
