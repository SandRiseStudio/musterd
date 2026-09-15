# 338 — a review finding is not a fix request

- Status: proposed — 2026-08-31
- Date: 2026-08-31
- Authored by stanley on lane `01M1CSP7T30BQG1NYQY3C05VH4`, from nick's Seed `01M1B39BJKJGMT8DEVX3E2YH9T`
  ("How to make sure agent reviewer doesnt over rotate towards fix for edge cases found in their
  review") and wanderer's exploration brief on that Seed.
- Builds on: [ADR 180](180-review-after-bugbot.md) (the advisory reviewer and
  `.github/REVIEW-RULES.md` as the one home for review rules),
  [ADR 192](192-outcome-acceptance.md) (outcome acceptance is not a code review; reject carries a
  concrete note, not style nits), [ADR 314](314-correlated-models-correlated-mistakes.md)
  (same-family judges share blind spots — more judges is not more truth)

## Context

A reviewer who discovers an edge case feels the discovery as an obligation: having found X, X must
be fixed, *here*. The author, facing a REQUIRED, complies to get to green rather than argue scope.
The trap is two-sided — the reviewer over-labels, the author over-complies — and each side's
behavior teaches the other's. Left alone, review quality drifts toward "how many extras got bolted
on," and a lane's scope is set by whoever read the diff last instead of by the spec that opened it.

The prompt that produces the rotation is in the default tooling, not in anyone's judgment: the
stock Superpowers code-reviewer prompt file asks "Edge cases handled?" / "Edge cases covered?" as
checklist items (`requesting-code-review/code-reviewer.md:58` and `:68` in superpowers 6.3.0, the
version on this machine, checked 2026-08-31). A checklist item is a finding quota. Nothing in the
repo's own rules names the counter-rule.

**The baseline was measured before deciding, not assumed** (stanley, 2026-08-31): every REQUIRED
across the nine most recently reviewed PRs — #1087, #1100, #1102, #1103, #1110, #1115, #1117,
#1122, #1123 — was pulled and classified: twelve REQUIREDs from four reviewers (three of the nine
PRs carried none). All twelve fall into four load-bearing categories, and **zero were speculative
edge cases**:

- **Honesty** — a claim in the PR or its docs that is false: #1123 (a review-provenance SHA
  misattributed), #1087 (a data point that "would send the next reader to reproduce a scenario
  that never happened").
- **Probe-measured regression** — reproduced, not reasoned: #1102 ×2 ("I reproduced each with a
  throwaway test against this head rather than reasoning about it"), #1110 (concurrency probes red
  at the reviewed head), #1103 ×2 ("five driving tests" in a temporary checkout of the branch),
  #1087 (a missing dedup step with "a live instance on this PR" — the PR's own thread was the
  reproduction).
- **A named pin** — the change violates a rule already written down, including by the PR itself:
  #1115 ("the PR's own wiki page states the rule it violates"), #1110 (ADR number collision against
  `adr-numbers:check`), #1087 ×2 (a spec still teaching the superseded ritual, cited as authority
  by the shipped skill; the ADR's own Decision still teaching the rule the amendment reverses).
- **Leaked secrets / AppSec** — none in the sample; the category exists in
  `.github/REVIEW-RULES.md` blocker 2 and the security skill.

The #1087 rows were first filed here as 2 honesty / 2 pin; miley's review of this ADR recounted
them against the original findings as 1 honesty / 2 pin / 1 probe-measured, and this paragraph is
the correction, recorded in place. Her recount's totals line then miscounted a column in turn, and
the re-review corrected the correction — totals as the bullets read: honesty 2, named pin 4,
probe-measured 6. Two rounds of review on four rows of arithmetic, both errors surviving both
readers because every wrong split still summed to twelve.

The same sample holds the counter-pattern, done right, twice in one day: the reviewer of #1123
found a real gate hole (rule 3's before-status window) and recorded it as a carry-forward — it
became its own lane (`01M1D3HJZACT6CC9KQ0QR88AJS`) instead of a wedge on a one-line PR. The
reviewer of #1117 raised the fenced-code residual as a note, explicitly conditional on whether the
affected shape existed; the author measured (22 of 329 Decisions), found it live, and took it by
choice. Discovery routed to a lane, scope stayed where the spec put it, and nothing was lost.

So this ADR is not a correction of bad practice. It is a **pin on existing practice** — the
strongest reviews here already behave this way, no written rule says they must, and the default
prompt file pulls the other way. The rule is written down while the evidence that it works is one day
old, so that declining a non-qualifying REQUIRED is a citation, not an argument.

## Decision

### 1. The classification test

A finding is REQUIRED only if the spec would have demanded it **before anyone opened the diff**.
Discovery adds information; it does not add obligation. Everything a reviewer finds is worth
recording — the question is only where it routes: into this change, or onto the board.

### 2. REQUIRED is reserved for four categories

- **Honesty** — a claim in the PR, its docs, or its provenance that is false.
- **Leaked secrets** — per `.github/REVIEW-RULES.md` blocker 2.
- **Probe-measured regression** — reproduced against the reviewed head with a test, probe, or
  driving scenario. Reasoning about a failure is a note; reproducing it is a REQUIRED.
- **A named pin** — the change violates something already written: a falsifier or acceptance
  criterion in the lane detail or spec, an ADR clause, a doc/code disagreement
  (`.github/REVIEW-RULES.md` blocker 4), a rule the PR's own text states, or a convention already
  demonstrated in the tree — cited with file and line, the way precedent is (this last form is
  miley's #1087 REQUIRED: the pin was `2026-07-31-…-design.md:6` carrying the supersede convention
  the flagged spec lacked). "Named" is load-bearing: the REQUIRED must quote or cite the pin, in
  the finding itself. A category claim ("this is a correctness issue") with no probe and no pin is
  a note wearing a costume.

### 3. Everything else is noted, not blocking

A hypothetical, a reviewer-discovered edge case the spec never named, a hardening idea, a "while
you're in there" — these are notes. A note worth keeping becomes a Seed or a lane **with the
finder's name on it**, exactly as the #1123 carry-forward did. Routing a finding to the board is
not burying it; it is the only route where it gets its own spec, its own stakes, and its own
review.

### 4. The author's duty is the same paragraph, not a separate nicety

An author who receives a REQUIRED outside the four categories **declines it, citing this ADR**, and
does not expand the lane. A decline has a floor, the same one rule 3 gives notes: **the decline
names which of the four categories the finding fails, and the finding routes to the board as a
note under the finder's name.** Declining costs the author a record the way noting costs the
reviewer one — the finding survives being wrong about its own severity, and a decline that names no
category is itself the costume rule 2 forbids. Declining is not insubordination — complying is the
failure mode, because every out-of-scope fix bolted on to get to green lands unreviewed-in-spirit:
it was specified by nobody, and the reviewer who demanded it is the only one who ever judged it. An author who *wants*
to take a noted finding may (the #1117 fenced-code residual was taken by choice, measured first);
the difference between taking and complying is that taking is a decision recorded on the PR, with
the measurement that justified it.

### 5. AppSec is explicitly exempt

The security skill and its bar are unchanged: probe-measured security findings accepted by nick
stay REQUIRED regardless of what the lane's spec named. Nothing in this ADR reclassifies a
vulnerability as a note. The exemption is category-gated the same way as everything else — it
covers findings *demonstrated* against the head, not findings *labeled* security to keep them
blocking (rule 2's anti-costume clause applies here too).

### 6. What this ADR deliberately does not add

No merge gate — review stays advisory (ADR 180). No second-judge or consensus rule — that is Seed
`01M0XTJC` and it stays separate; ADR 314 already says stacking same-family judges on an edge case
does not make it load-bearing. No protocol change, no new act, no severity schema — ADR 192 already
refused to make acceptance a code review, and this ADR refuses to make review a protocol.

## Falsifiers

- A REQUIRED that names neither a probe nor a pin survives a challenge that cites this ADR — the
  charter failed as a citation and needs teeth elsewhere.
- An author expands a lane to clear a REQUIRED outside the four categories without recording a
  decision to take it — the charter is unread; check whether it ever reached the guidance skill.
- The baseline drifts: a future recount of recently reviewed PRs (same method as the 2026-08-31
  count above) finds speculative edge-case REQUIREDs — descriptive pinning was not enough, revisit
  ADR 314's second-judge remedy or a harder form.
- Real vulnerabilities start arriving as notes — the AppSec exemption was swallowed; restore it
  loudly.

## Observability & Evaluation

- **Traces**: none added — review threads live on GitHub PRs, which is already the durable record
  this ADR's baseline was measured from.
- **Eval**: the dataset is the REQUIRED findings on reviewed PRs; the baseline is the 2026-08-31
  count above (12/12 in the four categories, 0 speculative, PRs #1087–#1123). Re-run the same
  classification over a later PR window to detect drift — the third falsifier names the trigger.
- **Experiment**: n/a — a norms document; the falsifiers above are its observable failure modes.

## Consequences

- `.github/REVIEW-RULES.md` gains the operational form of rules 1–5 (same PR), keeping ADR 180's
  "one home" property: reviewers read REVIEW-RULES, and REVIEW-RULES cites this ADR as the
  authority.
- The guidance skill's acceptance section (`packages/protocol/src/guidance.ts`, "Closing a lane")
  does not change in this increment — a guidance bump reaches every seat and is worth batching; the
  next guidance revision should add one sentence linking the charter. Until then the ADR and
  REVIEW-RULES are the two homes, one fact each.
- The Superpowers prompt file's "Edge cases handled?" checklist keeps firing on every default review;
  this ADR is the standing answer to what it produces, not a suppression of it. Findings are still
  wanted — the charter routes them, it does not discourage them.
