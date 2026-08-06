# 245 — The migration ladder must step strictly upward, and a gate says so

- Status: accepted
- Date: 2026-08-06
- Deciders: nick (asked for the gate), stanley (built it), izzo (the v32 collision, from the other
  side of it)
- Relates to: [ADR 220](220-adr-numbers-allocated-against-open-prs.md) / [ADR 223](223-adr-numbers-are-published-not-just-read.md)
  — the same problem one field over, and the prior art for what actually prevents it

## Context

Migration versions are picked by hand on a branch. Twice now, two branches have claimed one number:
izzo (ADR 232) and stanley (ADR 234) both wrote **v32** in the same week, and nothing caught it but a
merge conflict. On 2026-08-06 the same shape nearly recurred at v34/v35 and was avoided only by
asking in-band — which worked, and cost nothing, and is not a mechanism.

The folklore reason to care was _"the applied schema depends on merge order"_. That is wrong, and the
truth is worse.

## Problem

`runMigrations` walks `MIGRATIONS` in **array order** and skips anything it has already passed:

```ts
for (const m of MIGRATIONS) {
  if (m.version <= applied) continue;
  …
  applied = m.version;
}
```

So a version that does not step **strictly** upward is not reordered, not merged, not resolved late —
**it never runs at all.** On a fresh database, permanently, with no error raised anywhere, while
`schema_meta` records a perfectly plausible number.

This was verified by replaying that exact loop rather than argued from a reading: a ladder of
`[1, 2, 2, 3]` applies migrations 1, 2 and 3, silently drops the second `2`, and reports version 3.
Whatever table or column that entry created does not exist, on every machine initialised after the
collision, and the schema version claims otherwise.

That makes an unchecked ladder the sharpest failure shape in this repo's schema layer, and until now
the only thing standing between us and it was a merge conflict we got lucky with — twice.

## Decision

**1. `pnpm migrations:check` enforces one invariant: versions increase strictly, in array order.**
In the `format:check` chain with the other gates. Duplicates and downward steps are both failures,
reported with the offending line, the colliding line, and the remedy — and they are named
**separately** (`duplicate` vs `descending`) because the fixes differ: one needs renumbering, the
other needs reordering. Two ways to break it, two names.

**2. Gaps are explicitly fine.** The runner applies whatever has `version > applied`, so a skipped
number costs nothing, and a renumbered branch legitimately leaves one — ADR 244's v36 arrived exactly
that way. This follows `check-adr-numbers`, which likewise tolerates gaps and fails only on
collisions. Enforcing density would fail honest branches to catch nothing.

**3. The gate parses the source rather than importing it.** `migrations.ts` pulls in the protocol
package and the schema DDL; importing would make a format-chain gate depend on a successful build,
and a gate you cannot run on a broken tree is missing when you most need it. Offline and
deterministic, like every other gate in the chain.

**4. Finding nothing is a failure, not a pass.** If the parse ever matches zero entries — the file
moved, the shape changed — the gate exits non-zero and says it cannot see the ladder. A gate that
silently stops checking is worse than no gate, because the team stops looking.

**5. It is the BACKSTOP, not the fix, and the ADR says so rather than letting anyone believe
otherwise.** Being offline, it can only see versions that already coexist in one tree — by which
point someone has burned a red CI run or a rebase. Prevention is picking the number with knowledge of
what is in flight, which is what ADR 220's `adr:next` does for ADRs and what asking kimi in-band did
for v35. A `migrations:next` that reads open PRs is the natural sibling; it is **deliberately not in
this increment**, because izzo is concurrently fixing how `adr:next` discovers in-flight claims (lane
`01KZA3NJR0`), and cloning a discovery mechanism on the day it is being corrected would put two tools
answering "what number is free" by different means — the shared-predicate trap wearing a tooling
costume. It follows his, and reuses his helper rather than paralleling it.

## Consequences

- One more gate in `format:check`. It is O(lines of one file) and needs no build, so it costs
  nothing measurable.
- The gate cannot catch the case where two branches each add a _correct_ ladder that only collides
  once merged — git usually conflicts there, and that is what caught v32. Its real value is the case
  git does **not** catch: **a botched conflict resolution that leaves two entries sharing a number.**
  That is not hypothetical — resolving the ADR 244 rebase produced exactly that shape locally before
  it was spotted by hand. Stating the narrow scope honestly is better than implying broader cover.
- A one-line `{ version: N, … }` entry is now parsed as well as the multi-line form. The first draft
  anchored to line-start only and would have gone blind on an inline entry while still reporting
  success — caught by its own tests, and worth recording as the reason the parser is shaped the way
  it is.

## Observability & Evaluation

**Traces.** None: this is a build-time gate, not a runtime path. Its output is its own signal — a
success line naming the count and range walked (`✓ 36 migration(s), v1…v36, strictly ascending`),
deliberately not a bare exit 0, so a gate that verified something never looks like a gate that found
nothing.

**Eval.** The question is whether the gate ever fires on a real collision, and it can only be
answered by waiting. Two data points exist already, both pre-gate: v32 (caught by merge conflict) and
the ADR 244 rebase (caught by hand). Record any future trip. **If a year passes with zero trips while
in-flight collisions keep being resolved by conversation, the honest reading is that coordination is
the mechanism and the gate is ceremony** — at which point the effort belongs in `migrations:next`
instead, and this gate should be judged on that rather than kept for having once seemed prudent.

**The counter-metric that would condemn it:** a collision that reaches `main` _despite_ the gate. The
only way that happens is the parser going blind, which is why decision 4 exists and why the empty
parse is a hard failure.

**Experiment.** None. The invariant is not a hypothesis — it is a property of the runner's loop,
demonstrated above, and the gate either encodes it or does not.
