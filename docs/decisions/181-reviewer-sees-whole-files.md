# 181 — the reviewer reads whole files, not a diff keyhole

- Status: accepted
- Date: 2026-07-29

## Context

[ADR 180](180-review-after-bugbot.md) specified the advisory reviewer as "a single Messages API call
— review rules plus the diff, no repo exploration, no tool loop". It shipped that way in
[#488](https://github.com/SandRiseStudio/musterd/pull/488), with the diff rendered at `-U15`.

The first end-to-end smoke test ([#489](https://github.com/SandRiseStudio/musterd/pull/489)) planted
a realistic defect in `packages/protocol/src/lanes.ts`: a new `paused` lane state added to
`LaneStateSchema` and to the web label map (which the compiler demands), but **not** to
`LANE_CONTENDING_STATES`. A paused lane would therefore stop contending — its surface silently drops
out of overlap warnings and the ADR 150 edit guard, so a second seat can claim the same surface with
no warning. `pnpm typecheck` is clean, because the contending set is a `Set<LaneState>` rather than a
`Record`, so nothing checks it.

The reviewer ran correctly and reported **no findings** (1,660 input / 6 output tokens).

It was not a model failure. The `-U15` window around the enum change ended two lines into
`LANE_CONTENDING_STATES` — the model saw the set open and saw `'claimed',`, then the context stopped.
It was never shown the thing it was asked to notice.

## Problem

Most of what this reviewer exists for is **omission**: a value added in one place and not the
matching place; a field parsed at one boundary and not another; a state that gains a name but not its
semantics. ADR 180 named exactly these as the target — "seat/lane ownership", "delivery", "presence
reaping".

An omission is invisible in a diff hunk. A hunk shows what changed; the bug is what _didn't_. Any
fixed context window is a guess about how far away the matching place lives, and `-U15` guessed
wrong on the very first real case.

## Decision

**Send the full post-change body of every changed in-scope file, alongside the diff.**

- The diff still leads, so the model knows what to focus on; the bodies follow, with an explicit
  instruction that omissions are the target and the bodies are where they are visible.
- Bodies are included smallest-first under a `MAX_BODY_CHARS` budget (200k chars ≈ 50k tokens), so
  one large file cannot starve the rest. Files that do not fit are named in the prompt as
  diff-only, rather than silently dropped.
- `--dry-run` reports diff size, how many bodies were included, and the approximate token count, so
  the prompt's shape is verifiable without spending a call.

This supersedes only the "plus the diff" clause of ADR 180's decision 3. Everything else about the
reviewer stands: single pass, no tool loop, `claude-haiku-4-5`, path-scoped to protocol/server,
`continue-on-error`, and **never a required check**.

### Cost

The smoke-test diff grew from ~1,660 to ~4,300 input tokens — from ~$0.002 to ~$0.005 per review. At
~175 in-scope PRs/month that is **≈$1/month**, still an order of magnitude under ADR 180's ~$3
estimate, which assumed larger diffs than the median PR actually carries. The reviewer logs actual
tokens and cost per run, so the real figure stays visible rather than inferred.

## Consequences

- **The reviewer can now see omissions**, which is the class of bug it was justified on. Whether it
  reliably _reports_ them is the open question ADR 180's eval already asks.
- **Cost scales with changed-file size, not diff size.** A one-line change to a 400-line file now
  costs what a 400-line change costs. That is the point — but it means a PR touching many large
  server files is meaningfully more expensive than the median, and `MAX_BODY_CHARS` is the backstop.
- **A keyhole is a false negative, and a false negative is invisible.** "No findings" from a
  truncated prompt is indistinguishable from "No findings" from a clean diff. That is the real
  lesson: a reviewer that cannot see the answer reports success. Worth remembering before trusting a
  quiet run.
- **ADR 180 shipped with a defect that its own test caught before any real PR relied on it.** The
  smoke test cost about a fifth of a cent.

## Observability & Evaluation

**Traces** — unchanged from ADR 180: model, file count, input/output tokens and estimated USD to
stderr on every run. `--dry-run` additionally reports body inclusion and omitted files, which is what
makes a keyhole visible before it costs a false negative.

**Eval** — the ADR 180 eval (finding-acceptance rate) stands, with a precondition this ADR adds:
before trusting any "No findings", confirm the prompt actually contained the code the finding would
have to come from. The regression case is concrete and repeatable — re-plant the `paused`
lane-state omission and confirm the reviewer reports it. Baseline: the pre-fix run, which reported
nothing on that exact diff.

**Experiment** — none yet. If acceptance stays low even with whole files, the next question is
whether the _rules_ or the _model_ is the limit, which is the shadow comparison ADR 180 already
describes.
