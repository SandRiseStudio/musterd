# 220 — ADR numbers are allocated against open PRs, not against main

- Status: accepted
- Date: 2026-08-04
- Deciders: nick (directed), stanley
- Supersedes: nothing. Amends the authoring convention in `AGENTS.md` and the advice printed by
  `adr-numbers:check` (ADR gate added alongside ADR 153's arc).

## Context

The convention was: write `docs/decisions/NNN-<slug>.md`, where NNN is the next free number, checked
against `origin/main`. `adr-numbers:check` fails the build on a duplicate number or an H1 that
disagrees with its filename.

On 2026-08-04 that convention failed twice in one day:

- **ADR 214, an actual collision.** ryder's [#617] and izzo's [#618] both landed a
  `docs/decisions/214-*.md`. `main` went red, and it broke an unrelated PR that merely rebased onto
  it — the author who paid was not the author who collided.
- **ADR 219, a near miss.** izzo's [#628] held 219 in an open PR while miley opened a lane citing
  the same number. Caught by hand during review, before either could reach CI.

The rate is not the interesting part; the mechanism is. Every author followed the convention exactly
and the convention still produced a collision, because **it names the wrong source of truth**. A
number is not free because `main` lacks it. It is free because _nothing in flight_ claims it — and
`main`, by construction, contains no in-flight work. Two authors reading `main` an hour apart will
correctly compute the same "next free" number and both be wrong.

This is an uncoordinated-allocation race in the repository that builds a coordination layer, and it
gets worse monotonically as seat parallelism rises. It was tolerable when one or two seats wrote
ADRs; at today's parallelism it fired twice in a day.

## Decision

**Allocate ADR numbers with `pnpm adr:next`, which reads the working tree, `origin/main`, and the
files changed by every open pull request.** The authoring rule in `AGENTS.md` now points at the tool
and explicitly forbids reading `origin/main` by hand, which is the step that produced every incident
above.

Three properties are deliberate:

**The GitHub half is best-effort, and degrades loudly.** Without `gh`, unauthenticated, or offline,
the tool still answers — with the `origin/main` number — and prints a warning naming ADR 214 as what
that answer causes. Authoring an ADR must not require the network, but a silent degrade would
reinstate the exact blind spot this ADR removes, so the degrade is never silent.

**It reports; it does not reserve.** No new state, no registry file, no daemon row. A reservation
scheme would need releasing on abandoned branches and would create a second source of truth able to
disagree with git. The set of in-flight ADR numbers already exists and is authoritative — it is the
open PRs — so the fix is to _look at it_, not to mirror it.

**Gaps are never filled.** The next number is one past the highest claimed, never the lowest unused.
`adr-numbers:check` already permits gaps; a gap usually means the number was referenced somewhere
before it was abandoned or renumbered, and reusing it would silently repoint an old reference at a
new decision — a worse failure than a wasted integer, and a harder one to see.

`adr-numbers:check` is unchanged and remains the backstop. It stays offline and deterministic on
purpose: a gate that consults the network is a gate that fails for reasons unrelated to the change
under test. It catches what prevention misses; it is not itself prevention.

## Consequences

- The common path costs one command and removes the whole class of collision, including the case no
  amount of care could catch by hand: a PR opened after you branched but before you push.
- A seat working offline gets the old answer plus an explicit warning that it may collide. That is
  strictly better than today, where the same answer arrives with no warning at all.
- The tool depends on `gh` being authenticated for its full value. That is already true of the
  team's PR workflow (ADR 106), so it adds no new requirement.
- It does not help a number claimed by a branch that has never been pushed as a PR. That window is
  irreducible without reservation, and it is small: it closes the moment the PR opens, which under
  ADR 106's flow is immediately after the first push.
- Numbers will skip more often, because a number held by an open PR that is later closed unmerged is
  never reclaimed. This is intended, per the gap rule above.

## Observability & Evaluation

**Traces.** None added — this is repository tooling, not runtime behaviour. The existing signal is
sufficient: a duplicate number is a failing `adr-numbers:check` in CI, and its absence is the
success condition.

**Eval.** The measurable claim is that collisions stop. Baseline, from `git log` on
`docs/decisions/`: **one collision and one near-miss on 2026-08-04**, against no recorded instance in
the preceding weeks at lower seat parallelism — the mechanism is parallelism-sensitive, so the comparison must be
read per-active-seat rather than per-day. Success is no further `adr-numbers:check` failure
attributable to parallel allocation. Any recurrence should be checked against a specific question
before this ADR is amended: _did the author run `pnpm adr:next`?_ A recurrence with the tool unused
is an adoption problem and argues for moving allocation into a pre-push hook; a recurrence with the
tool used is a design problem and argues for real reservation.

**Experiment.** None. The change is a strictly better read of a set that already exists, with a
loud-degrade fallback, so there is no arm worth withholding it from.

[#617]: https://github.com/SandRiseStudio/musterd/pull/617
[#618]: https://github.com/SandRiseStudio/musterd/pull/618
[#628]: https://github.com/SandRiseStudio/musterd/pull/628
