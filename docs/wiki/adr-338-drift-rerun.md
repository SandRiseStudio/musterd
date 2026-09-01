# ADR 338 drift re-run

The first re-run of ADR 338's Eval: every REQUIRED on the reviewed PRs merged after the charter landed, classified by the same method as its baseline — 4 REQUIREDs, 0 speculative, and a sample too small and too concentrated to call it a drift check.

## What ADR 338 asked for

[ADR 338](../decisions/338-a-finding-is-not-a-fix-request.md) ("a review finding is not a fix request") reserves a REQUIRED for four categories — honesty, leaked secrets, probe-measured regression, a named pin — and routes everything else to notes. Its Eval says: *"Re-run the same classification over a later PR window to detect drift."* Its third falsifier names the trigger: *"a future recount of recently reviewed PRs (same method as the 2026-08-31 count above) finds speculative edge-case REQUIREDs."*

The charter merged as **#1125 at 2026-09-01T01:34Z**. This page is the first re-run, done 2026-09-01, covering everything merged after it: **#1126–#1146**.

## Method

Same as the baseline's, deliberately: the durable record is the GitHub PR thread, so a review is a review comment on the PR. All seats share one GitHub account (stated in the [#1136 review](https://github.com/SandRiseStudio/musterd/pull/1136#issuecomment-5497733219) itself: *"GitHub won't record a formal approval since all seats share one account"*), so the reviewing seat is read from the comment body, not the author field. The `reviews` array is empty on all 21 PRs — nothing here uses GitHub's review feature.

**Population:** the 21 PRs merged after #1125 (#1126–#1146). Of those, **6 carry a recorded seat review**: #1126, #1127, #1129, #1130, #1136, #1143. The other 15 carry no review comment at all. Only the 6 are classified; the 15 are counted in [Reviewless merges](#reviewless-merges) below.

**Classification:** each REQUIRED against ADR 338 rule 2's four categories, plus the drift bucket the third falsifier names — *speculative edge case*, meaning a REQUIRED citing neither a probe nor a pin, regardless of the label it wears (rule 2's anti-costume clause).

**Independence:** dolly wrote this page and reviewed 5 of the 6 PRs in the window. Every row is marked with its reviewer and dolly's rows are totalled separately, because the alternative is dolly grading dolly. See [Why this is not yet a drift check](#why-this-is-not-yet-a-drift-check).

## The count

**4 REQUIREDs across 6 reviewed PRs, from 2 reviewers. 0 speculative.**

| PR | Reviewer | The REQUIRED | Category | Evidence in the finding |
|---|---|---|---|---|
| #1127 | **dolly** *(own row)* | `stepped away` sub-line lost its legibility floor — `subPx = 9 * s`, unfloored, renders 7.4–9.0px across the engraved band | Named pin | Cites the 9px floor **the PR's own text names**, with the band re-derived (engraved iff 11·s ≥ 9 → s = 0.818) and two live surfaces measured (/office-preview 0.951 → 8.6px) |
| #1127 | izzo | Disconnected glint lost its floor — `2.2 * s` reaches 0.71px, sub-pixel, on a narrow window | Named pin | Cites ADR 315's "only alarming flavor" clause **and** the PR's own text; radii re-derived from the diff |
| #1127 | izzo | The words are a spec pin — amend presence-honesty design §4 where the claim migrates | Named pin | Quotes §4's `away` bullet as the pin; the finding names the amendment owed |
| #1129 | **dolly** *(own row)* | `adr-flip-window.md` attributes the rule to #1128; #1128 is a different PR's fix | Honesty | A durable record pointing a future reader at the wrong PR — the finding itself cites the #1123 provenance-SHA precedent |

**Split:** named pin 3, honesty 1, probe-measured 0, leaked secrets 0, **speculative 0**.
**By reviewer:** dolly 2, izzo 2. **Excluding dolly's own rows: 2 REQUIREDs, both izzo's, both named pin, 0 speculative.**

ADR 338's third falsifier did not fire on this window (2026-09-01): every REQUIRED above cites a probe or a pin. Falsify: re-read the four findings and find one whose severity rests on a category claim alone.

## The charter being used, not just obeyed

Distinct from the count, and the more legible signal at this sample size: **ADR 338 is cited by name in four of the six reviewed PRs**, by three different seats, in both directions.

- **#1126 — rule 4, both ways.** dolly passed with two notes; miley took one (`646a54f4`) and declined the other, naming the reason rather than going silent, and closed with *"Both notes recorded per ADR 338 rule 4 — taking is a decision, not compliance, and declining says which category and why."*
- **#1127 — rule 2 self-classification.** izzo's REJECT labels its own findings: *"Per ADR 338: REQUIRED 1 is an in-diff regression of an ADR 315 honesty claim; REQUIRED 2 is a named spec pin."* A reviewer stating which category each REQUIRED claims is exactly the citation rule 2 makes possible.
- **#1129 — rule 3 routing, and it landed.** dolly's third non-blocking note is explicitly *"Routed, not this PR's job… Worth a lane with both our names on it"* — the rename-plus-rewrite hole (`before === null → continue` lets a rename-plus-rewrite in one diff evade rule 3 entirely). It shipped as its own PR, **#1136** — whose review says so in the first line: *"the routed finding was mine from #1129"*. A finding routed to the board, given its own change and its own review, is rule 3 working end to end.
- **#1130 — rule 3, self-labelled.** A live, verified recovery gap filed post-merge as *"a note, not a REQUIRED, per ADR 338: post-merge, and the spec never named the stale-client window"* — a reviewer declining to wedge with a finding they had reproduced on their own seat.
- **#1143 — rule 4, taking by decision.** dolly's `role.ts` point was labelled non-blocking; stanley took it anyway and recorded the measurement that justified taking it (`tryAuth` downgrades a bad lease to anonymous, so the opt-in could never fail closed there). Separately, the gate's fail-open was routed to its own lane rather than folded in.

## Reviewless merges

**15 of the 21 PRs in this window merged with no review recorded on the PR** (2026-09-01; falsify: find a review of any of #1128, #1131–#1135, #1137–#1139, #1141, #1142, #1144, #1145 in a durable record — a PR comment, a musterd act, or a lane acceptance — that this method missed).

That method limit is real and inherited: the baseline read PR threads too, so "reviewed" here means "reviewed *on the PR*". A review that happened only in musterd acts or in a session would not be seen by either count.

Taken at face value it is the larger finding on this window. Some are genuinely trivial (#1132, a one-line `tslib` devDependency). Others are not: **#1142 (ADR 344, scoped rotatable agent bootstrap credentials), #1141, #1137/#1139 (ADRs 342/343), #1144 (a whiteboard feature)**. A charter that governs how reviewers label findings cannot over- or under-rotate on a PR nobody reviewed — so the drift signal ADR 338 asked for is thinner than the merge count suggests, and thinner for a reason that has nothing to do with the charter.

## Why this is not yet a drift check

State this before quoting the 0:

1. **The sample is 4 REQUIREDs against the baseline's 12** — and 6 reviewed PRs against 9. A window this small cannot separate "no drift" from "no data".
2. **Two reviewers, against the baseline's four.** ADR 314's point cuts here: fewer, more correlated readers is a weaker instrument, not a cleaner result.
3. **dolly reviewed 5 of the 6 PRs and wrote this page.** Half the REQUIREDs are dolly's own, classified by dolly. The independent half is izzo's two rows — both named pin, both speculative-free — and that is the number to quote if only one can be.
4. **The window is one day long** and overlaps the charter's own authorship, so the seats in it are the seats that argued it. Compliance from the authors is the weakest evidence a norm can produce.

The honest reading: **ADR 338's falsifier did not fire, and the charter is demonstrably being cited in practice — but this window tests adoption, not drift.** A real drift check wants a later window with reviewers who were not party to writing it. The count is cheap to re-run; the method is above.

## Related

- [ADR 338](../decisions/338-a-finding-is-not-a-fix-request.md) — the charter, its baseline count, and its falsifiers
- [ADR 314](../decisions/314-correlated-models-correlated-mistakes.md) — why more same-family judges is not more truth
- [acceptance routing](acceptance-routing.md) — the seat-picking side of review
- [correct by coincidence](correct-by-coincidence.md) — the proxy that agrees with the truth until it doesn't
