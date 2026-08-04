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

What the incident adds is *why* the window was not small. stanley's PR #633 was created at 12:37 and
merged at 12:40 — the claim on 221 was visible to the open-PR scan for **three minutes**, at the very
end of the work. ADR 220 assumed the PR opens "immediately after the first push" and that authoring
therefore happens mostly in public. In practice an ADR is written, revised, and gated on an unpushed
branch for the whole session, and the PR appears when the work is *finished*. The number is taken at
minute zero and published at minute ninety.

So the exposure is not the gap between push and PR. It is the gap between **taking** a number and
**publishing** it — and under current habit that gap is the entire authoring session. The open-PR
rung was not weak here; it was starved, because neither author had put anything in front of it.

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

**Experiment.** None. Withholding the rule from an arm would mean deliberately leaving a known
collision window open on live work to measure it, at a cost paid by whichever author loses the race.

[#633]: https://github.com/SandRiseStudio/musterd/pull/633
[#635]: https://github.com/SandRiseStudio/musterd/pull/635
