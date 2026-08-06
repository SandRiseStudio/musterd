# 223 — An ADR number is published when it is taken, not when the work is done

- Status: accepted
- Date: 2026-08-04
- Deciders: nick (directed), stanley
- Amends: [ADR 220](220-adr-numbers-allocated-against-open-prs.md). Does not supersede it — the
  allocation rule and `pnpm adr:next` stand unchanged.

## Context

ADR 220 replaced "read `origin/main`" with `pnpm adr:next`, which also consults the files changed by
every open pull request. It named its own residual gap in Consequences:

> It does not help a number claimed by a branch that has never been pushed as a PR. That window is
> irreducible without reservation, and it is small: it closes the moment the PR opens, which under
> ADR 106's flow is immediately after the first push.

That window fired the same day, and the second half of the sentence is the part that was wrong.

**The ADR 221 collision.** stanley wrote `221-cannot-actuate-is-a-deferral.md` and merged it as
[#633]. miley, working in parallel, ran `pnpm adr:next` before writing, got `221` — reported as
`working tree highest 220, origin/main highest 220, open PRs none claim an ADR number` — and took it
on that basis. Both authors used the tool. Both reads were correct when made. Both produced the same
number. miley renumbered to 222 ([#635]) once told.

ADR 220 pre-registered the decision rule for exactly this: _did the author run `pnpm adr:next`?_ A
recurrence with the tool unused is an adoption problem; **a recurrence with the tool used is a design
problem.** The tool was used, correctly, by both. So the finding stands as pre-registered: a read
cannot reserve, and no improvement to the reading would have prevented this.

What the incident adds is _why_ the window was not small. stanley's PR #633 was created at 12:37 and
merged at 12:40 — the claim on 221 was visible to the open-PR scan for **three minutes**, at the very
end of the work. ADR 220 assumed the PR opens "immediately after the first push" and that authoring
therefore happens mostly in public. In practice an ADR is written, revised, and gated on an unpushed
branch for the whole session, and the PR appears when the work is _finished_. The number is taken at
minute zero and published at minute ninety.

So the exposure is not the gap between push and PR. It is the gap between **taking** a number and
**publishing** it — and under current habit that gap is the entire authoring session. The open-PR
rung was not weak here; it was starved, because neither author had put anything in front of it.

### Amendment, 2026-08-05 — the ritual was invisible to its own detector

The Decision below stands and is unchanged. What follows corrects how it is _carried out_, because
following it literally is what caused the next collision.

On 2026-08-05, **three seats allocated ADR 241 within one hour** — ryder (#703, merged), kimi (#704)
and izzo (#706). All three ran `pnpm adr:next`. All three got 241. All three were correct at the
moment they looked.

The mechanism, verified rather than inferred: `scripts/adr-next.ts` read open PRs through
`adrNumbersInPaths(pr.files)` — **file paths only**. This ADR's ritual is "push the draft PR
_before_ writing it", and the Decision puts the number in the **title** with a body that "may be
empty". So a compliant reservation push contains no `docs/decisions/NNN-*.md` for the scan to find.
Confirmed on ryder's reservation commit `c9ca4e1b`: zero files under `docs/decisions`. For eleven
minutes PR #703 claimed 241 in a place nothing read.

**The ritual and the detector disagreed about where a claim lives, and the ritual was the one being
obeyed.** A seat running the right command got a wrong answer — the worst shape of tooling defect,
because it punishes compliance. This is not the residue the Decision below pre-registered ("two
authors who run `adr:next` within the same minute"); the collisions here were eleven minutes and
more apart, with a published draft PR sitting in between.

Two changes, both landed 2026-08-05:

1. **The detector reads the field the ritual designates.** `adr-next` now also matches `ADR NNN` in
   an open PR's **title** and `adr-NNN` in its **branch name**, unioned with the file-path read.
   Deliberately a widening rung: a title that merely cites an ADR reserves that number too. Under
   the allocation rule that costs at most one skipped integer, while an under-reservation costs a
   collision and a rewrite of every cross-reference. The output says which evidence claimed each
   number, so a reservation stays distinguishable from a written ADR without opening the PR.
2. **The reservation push includes a stub at the ADR's path**, and `adr:next` now prints that
   instruction. The detector stays exact, and the stub is what makes the number legible to a _human_
   scanning the PR list — the other half of what this ADR was for.

Either alone would have prevented 2026-08-05. Both are kept because they fail in opposite
directions: the stub depends on habit, and the prose read depends on nobody writing a misleading
title.

## Decision

**Push the branch as a draft PR as soon as it carries an ADR number** — before the ADR is written,
not after. The draft PR's title should name the number (`ADR 223: <slug>`); its body may be empty.

This is deliberately not reservation:

**It uses machinery that already exists.** `pnpm adr:next` already reads open PRs. Publishing early
does not teach the tool anything new; it gives the existing rung something to see during the window
when the number is actually contested. No registry, no daemon row, no second source of truth — ADR
220's reasoning for refusing those is untouched by this amendment.

**It has no release problem.** A reservation scheme must decide when an abandoned claim expires. A
draft PR inherits the answer already in force: close it, and the number is released and never
reclaimed, exactly as ADR 220's gap rule requires.

**It shortens the window rather than closing it.** Two authors who run `adr:next` within the same
minute, before either has pushed, still collide. That residue is real and is not addressed here.
It is a far smaller target than a ninety-minute authoring session, and it is the cost of not building
reservation yet.

**Reservation stays pre-registered, not abandoned.** ADR 220's rule fired and pointed at reservation;
this ADR spends a cheaper fix first on the explicit condition that the cheaper fix is measured. See
Evaluation.

## Consequences

- Draft PRs become more numerous and shorter-lived, and some will carry no commits beyond a branch
  point for a while. Reviewers should expect drafts that are placeholders; a draft PR is not a
  request for attention.
- The number is committed to earlier, so renumbering — if it happens — happens before the prose
  references it, which is the cheap moment to do it.
- Authors working offline gain nothing from this rule. They already get ADR 220's loud degrade.
- It adds one push to the authoring flow. Under ADR 106 the branch is created anyway; this only moves
  when it becomes visible.

## Observability & Evaluation

**Traces.** None added; this is repository convention. The signal remains a failing
`adr-numbers:check` in CI, plus the collision record in this ADR and ADR 220.

**Eval.** The measurable claim is that publishing early removes the collisions that reading could
not. Baseline, all on 2026-08-04 at 3–4 concurrent ADR-writing seats: **one hard collision (ADR 214,
tool not yet available), one near-miss caught by hand (ADR 219), and one collision with the tool used
correctly by both authors (ADR 221)**. Success is no further duplicate-number incident in which the
losing author's branch existed, unpublished, while the winner's PR was open.

The pre-registered decision rule, stated now so it cannot be softened later: **a recurrence in which
both authors used `pnpm adr:next` _and_ both had published draft PRs is the case this amendment
cannot fix, and it settles the question in favour of real reservation.** A recurrence in which either
author had not pushed a draft is an adoption problem for this rule, not evidence against it, and
argues for moving the draft push into tooling — the `adr:next` command itself is the obvious place,
since it already knows the number was taken.

**The rule fired on 2026-08-05, and the honest reading is that it does _not_ yet settle the question
(amendment above).** Three seats collided on 241; ryder had published a draft PR and the other two
had run the tool, which is the shape the rule names. But the published draft was **invisible to the
scan** — it claimed the number only in its title, which nothing read. So the rung was starved a
second time, by a different mechanism than ADR 221's, and this was not a fair test of publishing.
Reservation stays pre-registered and unspent. The clock restarts from 2026-08-05 with both halves of
the amendment in force: the next collision in which every author ran the tool AND every claim was
visible to it is the one that buys reservation.

Watch specifically for the counter-metric the widened rung introduces: numbers skipped because a PR
title merely _cited_ an ADR. Each costs an integer, which is cheap — but a run of them means titles
are being read too eagerly and the match should tighten to the ritual's exact `ADR NNN: <slug>`
prefix rather than any mention.

**Experiment.** None. Withholding the rule from an arm would mean deliberately leaving a known
collision window open on live work to measure it, at a cost paid by whichever author loses the race.

[#633]: https://github.com/SandRiseStudio/musterd/pull/633
[#635]: https://github.com/SandRiseStudio/musterd/pull/635
