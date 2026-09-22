# 437 — A live claim gate lives in the list of claims, and its rule is the `claim` field

- Status: proposed
- Date: 2026-09-21
- Relates to: [ADR 320](320-positioning-the-value-prop-decided.md) (the positioning this copy
  executes; not reopened), [ADR 122](122-cookoff-experiment-design.md) /
  [ADR 123](123-cookoff-cell-runbook.md) (the measurement the gated figure comes from)
- Lane: `01M33675K30M9JMBZPPDJWP0KN`
- Source: `docs/brand/leave-behinds/security-position.md` §3.11 and §6.5

## Context

`security-position.md` is the document the outbound copy is written from. Its §3, "What the copy
may never say", is a numbered list of fifteen claims, and since 2026-09-20 (#1592) the rule is the
typed module `scripts/lib/forbidden-claims.ts` — §3's prose is the reasoning, the module is the
rule, and the two are edited in the same commit.

Item 11 governs the cookoff figure: the ~38× less wasted work measured in the July 2026 flagship
run, on a build now ~994 commits old. The refresh is lane `01M1VDRC6BAG`, blocked on a human hold
rather than on work.

## Problem

**Two clauses of one document give different answers about the same number, and nothing tells a
reader they have read half of it.**

- **§3 item 11** forbids "The 38× **without** its date, its denominator and its cost side." That is
  a conditional permission: attach all three and you have complied.
- **§6 item 5** says the refresh lane "gates any use of that number in outbound copy" and "The
  figure returns when the re-run lands, not before." That is a flat prohibition, which no caveat
  set satisfies.

A writer who reads §3 ships the number with its caveats and believes they passed. A writer who
reads §6 cuts it. Both are reading the governing document correctly.

**The module inherited the same contradiction, in a sharper form.** Item 11's `claim` field — the
field a writer reads as the rule — carries the permissive version, while the prohibition sits in
`why` as an aside: *"Gated by §6.5 until the re-run lands."* So the artifact that exists to be the
single source of the rule states the rule in a field that is not the rule.

`ForbiddenClaim.why`'s own doc comment already says *"the reason, not the rule"*. The type was
right and the data contradicted it, in the one entry where it mattered — which is why Decision 2
below is a restatement of the interface rather than a new constraint. #1592 moved the list into
that module and carried the glue across without seeing it; the author of that change is the author
of this ADR.

**This is measured, not anticipated.** A sweep on 2026-09-21 found four uses in `docs/demo.md`
alone:

| where | what it said |
| --- | --- |
| 4:45, the 6-minute pitch | "about 38 times less" — the figure, outright |
| 1:30, the 2-minute cut | "72% wasted… under 2%" — the same figure in components, undated |
| the running-late fallback | *"say the 72% → under 2% line"* — reach for it when short of time |

The third is the worst of them: the short-on-time path is where a gated number is most likely to be
said by reflex, and the 2-minute cut is spoken — at Startup Grind on 2026-10-07, in front of a VC
panel, and in the recording the launch post still lacks. Nobody can amend a sentence said to a room.
Fixed under §6.5 on nick's ruling (#1639), which decided the instance and not the cause.

§6.5's own text records the collision happening to its author: *"The first draft of the
platform-team page used it with all four caveats, which wanderer caught on the second-seat read:
the caveats were correct and complete, and the page still violated a gate I had written myself two
commits earlier."* That is §3-compliant copy failing §6, written down inside the clause that causes
it and read at the time as an authoring lapse rather than as a defect in the pair. The CFP abstract
then chose §6.5 and says so; `demo.md` chose §3.11 four times. Same author, same document, weeks
apart.

**The root cause is placement, not wording.** §3 is what you may never claim. §6 is "Open, and
owed" — a status list. A live gate was written into the status list, where it is discoverable only
by someone auditing what is outstanding, never by someone checking what they may say.

## Decision

1. **A live claim gate lives in §3 and in the module, never in §6.** §6 records what is *owed* —
   here, the re-run. It may describe a gate's history and reasoning; it may not be the only place
   the gate is stated. A rule a writer finds only by reading the status list is not a rule.

2. **The `claim` field is the rule**, as its own type already says. A condition that changes what a
   writer may ship belongs in `claim`, never in `why`. `why` explains; `instead` redirects; neither
   restricts. Where the two disagree, `claim` governs — and the disagreement is the bug.

3. **Item 11 becomes the flat prohibition while the gate is live**, in §3 prose and in the module,
   in the same commit: the figure may not be used in outbound copy **in any form, including its
   components** (the 72% / under 2% pair, or any restatement of the ratio), until lane
   `01M1VDRC6BAG` lands. Naming the components is load-bearing — the caveat-conditional wording
   never reached them, which is how three of the four uses survived a writer who believed they were
   complying.

4. **Restoration is an edit to item 11, made when the re-run lands, and to nothing else.** The
   permissive form returns as item 11's `claim` with the date, denominator and cost side of the
   *new* run attached. Until then no surface may carry it, and §6.5 is not the place that changes.

5. **Item 11 stays `tier: 'review'`.** The explicit forms ("38×", "38 times") are regexable; the
   components form is not, and neither is a ratio restated in prose. A regex over the explicit
   forms would report green over exactly the version that shipped three of the four times — an
   instrument that cannot see its own subject, which is the failure this team has now counted
   eight times. §3's own bar already says promotion needs a regex plus a clean mutation run, not
   confidence, and half a matcher does not clear it.

## Consequences

- `security-position.md` §3.11 and §6.5 and `scripts/lib/forbidden-claims.ts` item 11 are rewritten
  together, in one commit, per §3's own rule. §6.5 keeps its reasoning — *"a bar that bends to an
  argument is not a bar"*, and the account of the platform-team draft, which is the best evidence in
  the document that the pair was broken — and points at item 11 for what the rule is.
- `#1639` already brought `docs/demo.md` and the blog draft into line with Decision 3, before this
  ADR existed. Nothing else in the outbound set carries the figure: the three leave-behinds, the
  launch post, `README.md`, `PRODUCT.md` and the web content were swept the same day and are clean.
  The CFP abstract was already correct, deliberately, and says why.
- Decision 2 applies to all fifteen items, not only item 11. Nothing else currently states a
  restriction in `why`; this makes that a rule rather than a coincidence.
- The next writer who reaches for the figure meets one answer. That is the entire point, and the
  falsifier is in the next section.

## Observability & Evaluation

- **Traces:** none — this is a documentation gate, not a runtime path. Its record is the commit
  that changes item 11 and the PRs that cite it.
- **Eval:** `pnpm claims:check` continues to enforce the four `gated` items; item 11 stays with the
  eleven that a human read enforces, per Decision 5. The honest statement of coverage is that this
  gate is enforced by second-seat reads and not by CI, and saying so is part of the decision.
- **Baseline, to measure against:** four uses of the gated figure in one document on 2026-09-21,
  three of them in the form the conditional wording never reached, all written by an author who
  had read the governing document.
- **Falsifier, dated:** by 2026-12-21, a use of the cookoff figure — in any form, including its
  components — appears in outbound copy while lane `01M1VDRC6BAG` is still open, and its author
  reports having read either §3.11 or §6.5 and believed they complied. That would mean the split
  was not the cause and the fix was cosmetic. Absent that, this decision holds.
- **Experiment:** when the re-run lands, Decision 4 is exercised once — the restoration touches
  item 11 and nothing else. If it turns out to need edits in more than one place, Decision 1 did
  not take.
