# 180 — review after Bugbot: deterministic guards, an advisory reviewer

- Status: accepted
- Date: 2026-07-29

## Context

`Cursor Bugbot` was one of two required checks on `main` (`gates` was the other), and with
`required_approving_review_count: 0` it was in practice the only reviewer any PR got. It had no
in-repo configuration — it was wired entirely through the Cursor GitHub App and dashboard.

On 2026-07-29 it stopped reviewing, reporting `Bugbot couldn't run - usage limit reached`. The cause
was billing, not a bug: Bugbot draws from the Cursor **Other Models** pool — the $70/month of
third-party frontier-model usage included in Pro+ — rather than the Cursor-native pool (Grok 4.5 /
Composer 2.5), which sat at 4% used. Its review model is not selectable; only effort level is.

Two facts made this untenable rather than merely inconvenient:

- **Volume.** The team merges ~27 PRs/day (100 in the 3.7 days before this ADR). A $70 pool over
  ~800 PRs/month is a budget of ~$0.09 per review; no frontier-model review meets it.
- **Failure mode.** Because Bugbot was a _required_ check, an exhausted quota did not degrade the
  review — it blocked every merge, with no signal except a comment on the PR.

Measuring what those PRs actually contain reframed the problem. Of the last 100 merged:

| Shape                                                              | Count |
| ------------------------------------------------------------------ | ----- |
| Markdown only (ADRs, docs, ROADMAP)                                | 72    |
| Touches code                                                       | 28    |
| …of which touches `packages/protocol/src` or `packages/server/src` | 22    |

So ~72% of PRs were being reviewed by a frontier model despite `gates` already covering them
completely, and the population that genuinely needs a reader is ~22%.

## Problem

Bugbot was doing two different jobs under one name, and paying frontier-model rates for both:

1. **Mechanically checkable rules** — cross-package imports, ADR-gated changes, ADR immutability. A
   model was being asked to judge these on every PR, unreliably and at cost, when a script decides
   them exactly and for free.
2. **Genuine judgement** — the seat/lane ownership, presence-reaping, delivery and SQLite
   transaction invariants that the test suite structurally cannot cover.

Replacing it 1:1 with another always-on frontier reviewer would reproduce both the cost and the
merge-blocking failure mode.

## Decision

**Split the two jobs, and never let the model-based half gate a merge.**

1. **`gates` is the only required check on `main`.** `Cursor Bugbot` was removed from
   `required_status_checks`; the Bugbot app is disabled.

2. **Move the checkable rules into deterministic gates.**
   - `no-restricted-imports` (ESLint) blocks `@musterd/server` in `packages/cli/src` and
     `packages/mcp/src`. The one sanctioned exception is `commands/serve.ts`, which launches the
     daemon in-process per [ADR 002](002-dependencies.md); tests are exempt.
   - `no-console` (ESLint) in `packages/server/src` — the server emits single-line structured JSON
     (`07-conventions.md`), and an ad-hoc `console.*` is both a format break and the likeliest route
     for a token to reach stdout.
   - `change-adr:check` (`scripts/check-change-adr.ts`) fails a PR that changes
     `packages/protocol/src` or adds a runtime dependency without an ADR, and fails an in-place edit
     to an accepted ADR's `## Decision`. It is diff-based, so it runs as its own CI step rather than
     in the tree-based `format:check` chain.

3. **Keep one advisory reviewer, scoped and cheap.** `.github/workflows/review.yml` runs
   `scripts/review/pr-review.ts` on PRs touching `packages/protocol/src` or `packages/server/src`:
   a single Messages API call — review rules plus the diff, no repo exploration, no tool loop — on
   `claude-haiku-4-5`. It posts one rolling PR comment. It is **advisory by construction**:
   `continue-on-error: true`, absent from branch protection, and it must stay that way.

4. **Review rules live at `.github/REVIEW-RULES.md`** — one home, read by the reviewer and usable as
   a human checklist. It leads with what CI already enforces, so the model does not spend its budget
   re-reporting hard failures.

### Cost

Measured on a representative 5-file server diff: ~10k input / ~1k output tokens ≈ **$0.015 per
review** at Haiku 4.5 list price. Against ~175 in-scope PRs/month that is **≈ $3/month**, versus the
$70 pool Bugbot exhausted. The script logs per-run token counts and estimated cost to the CI log so
the number stays visible rather than drifting silently.

### Rejected

- **Another always-on frontier reviewer** (Opus/Sonnet on every PR) — ~$210–800/month at this volume,
  and mostly spent on markdown.
- **An agentic reviewer** that explores the repo — ~5× the cost of single-pass for little gain at a
  ~320-line median diff.
- **Making the reviewer a required check** — this is precisely what turned Bugbot's billing problem
  into a merge outage.
- **`pull_request_target`** — would let the reviewer run with secrets on fork PRs. Not worth the
  injection surface; fork PRs simply get no review.

## Consequences

- **PRs land on `gates` alone.** The safety net is narrower and more honest: what is mechanically
  checkable is now blocking and exact; what needs judgement is a comment a human or seat can weigh.
- **Three of Bugbot's rules became permanent** — they run on every PR, cost nothing, and cannot be
  skipped by an exhausted quota.
- **The advisory reviewer can fail silently.** An API outage, a missing key, or a fork PR yields no
  comment and no signal. That is the deliberate trade for never blocking a merge; it also means the
  reviewer must not be treated as coverage.
- **`packages/web` accessibility is uncovered.** ESLint still ignores `packages/web` (a jsx-a11y
  config is the standing TODO in `eslint.config.js`), and Bugbot was the only thing looking at it.
  That gap is now total and is handed to the web owner, not closed here.
- **Fewer eyes on the 78% of PRs outside protocol/server.** Accepted deliberately: `gates` covers
  them, and the evidence is that frontier review of markdown was pure cost.

## Observability & Evaluation

**Traces** — `scripts/review/pr-review.ts` writes model, file count, input/output tokens and
estimated USD to stderr on every run, so per-PR review cost is visible in the CI log. The `review`
job's presence or absence on a PR records whether the diff was in scope. `change-adr:check` names
the ADR that satisfied a gated change.

**Eval** — the question is whether the advisory reviewer earns ~$3/month: **finding-acceptance rate**
— of findings posted, the share that lead to a code change before merge. Baseline: Bugbot's own
findings on the last ~50 in-scope PRs before it was disabled, which are still readable in PR
comments. A rate at or above that baseline means the cheap model lost nothing that mattered; near
zero over ~30 in-scope PRs means the reviewer should be dropped rather than upgraded, since the
deterministic guards are what actually carry the load.

**Experiment** — none yet. The natural one, if acceptance is ambiguous: shadow a sample of in-scope
PRs with `REVIEW_MODEL=claude-sonnet-5` and compare findings against the Haiku run on the same diff,
which isolates model capability from rule quality. Worth running only if the Haiku acceptance rate
is genuinely borderline — not as routine tuning.

## Amendment (2026-09-02): the Eval was read, and the reviewer is dropped

The finding-acceptance rate above was never computed until [ADR 180 reviewer eval](../wiki/adr-180-reviewer-eval.md) (dolly, 2026-09-02): **0 of 55 findings** posted on the 22 commented PRs among the last 80 led to a code change before merge, zero received a reply, and the Bugbot baseline the Eval named was itself **0–1 of 94** — Bugbot's median gap from first finding to merge was 0 minutes. The rule this section wrote fires on both arms: the cheap model lost nothing that mattered, and near-zero over 176 in-scope PRs (not ~30) means drop, not upgrade.

Decision 3 is therefore retired: `.github/workflows/review.yml` and `scripts/review/pr-review.ts` are removed in the same PR as the eval page. Decisions 1, 2 and 4 stand — `gates` is still the only required check, the deterministic guards are what carried the load, and `.github/REVIEW-RULES.md` remains the one home for review rules as the human/seat checklist [ADR 338](338-a-finding-is-not-a-fix-request.md) builds on. The shadow experiment reserved for a borderline rate is not run; a reviewer nobody reads is not improved by a better model.

The Consequences line "the advisory reviewer must not be treated as coverage" turned out to be the whole story: it was not treated as anything.
