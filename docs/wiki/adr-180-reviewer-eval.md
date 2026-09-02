# ADR 180 reviewer eval

The first read of ADR 180's pre-registered Eval on the advisory Haiku PR reviewer: 0 of 55 findings led to a code change before merge, its Bugbot baseline was also 0 of 94, and the ADR's own rule ("near zero ⇒ drop it") decided the outcome.

## What ADR 180 asked for

[ADR 180](../decisions/180-review-after-bugbot.md) replaced Cursor Bugbot with deterministic gates plus one advisory reviewer — `scripts/review/pr-review.ts`, a single Haiku 4.5 pass over `.github/REVIEW-RULES.md` and the diff, posting one rolling `<!-- musterd-review -->` comment on PRs touching `packages/protocol/src` or `packages/server/src`. Its Eval: **finding-acceptance rate — of findings posted, the share that lead to a code change before merge.** Baseline: Bugbot's findings on the last ~50 in-scope PRs before it was disabled. Rule: *"A rate at or above that baseline means the cheap model lost nothing that mattered; near zero over ~30 in-scope PRs means the reviewer should be dropped rather than upgraded."*

The Eval was written 2026-07-29 and never run. This page is the first read, done 2026-09-02, well past the ~30-PR window: the job has run **321 times** on **176 in-scope merged PRs** since it landed (falsify: `gh run list --workflow=review.yml --limit 1000 | wc -l`).

## Method

**Population (Haiku):** the 80 most recently merged PRs as of 2026-09-02 (#1124–#1205). 22 carry a findings comment. Every bullet under "Review findings" is read as a posted finding. Bullets that end by retracting themselves ("no actual bug here", "correct", "✓") are counted separately as **self-retracted** — they are posted, they cost the reader time, but they claim no defect.

**Population (Bugbot baseline):** every merged PR before ADR 180 that carries a Bugbot review comment: 53 PRs (#286–#405), 94 findings. The last ~20 in-scope PRs before the cutover (#421–#478) carry only `Bugbot couldn't run — usage limit reached`, which is why the window reaches back to mid-July.

**Classification**, per finding:

- **(a)** led to a code change before merge — a commit pushed after the comment that touches what the finding names; cited.
- **(b)** true (or plausibly true) but not acted on before merge.
- **(c)** false, self-retracted, or cosmetic.

**Acceptance evidence:** commits on the PR with a committer date after the comment's `created_at`, then the diff. A rebase (every commit sharing one timestamp) is not acceptance. A reply to the comment would also count; there are none — **zero replies to any of the 22 comments** (falsify: `gh api repos/SandRiseStudio/musterd/issues/<n>/comments` for any n below and look for a comment after the marker that mentions it).

**Independence:** dolly wrote this page and authored 6 of the 22 PRs (#1152, #1154, #1155, #1160 review, #1197, #1203). Those rows are marked; the (a) count is 0 with or without them.

## The Haiku count

**55 findings on 22 PRs. (a) 0 · (b) 6 · (c) 49, of which 17 self-retracted.** Finding-acceptance rate: **0 / 55 = 0%.**

| PR | Findings | (a) | (b) | (c) | Commits after the comment | Notes |
|---|---|---|---|---|---|---|
| #1205 | 3 | 0 | 0 | 3 | none | idempotent `already` flag read as a defect; ON CONFLICT DO NOTHING race "undetectable" (by design); v63 migration "loses concurrent writes" (migrations run before the daemon serves) |
| #1203 *(dolly)* | 2 | 0 | 0 | 2 | none | "off-by-one" between `HOST_STALE_MS = 300_000` and a test that ages by `301_000` — that is what past-the-threshold looks like; the other is "comment could explain more" |
| #1200 | 2 | 0 | 0 | 2 | none | claims `STORABLE_SURFACES` lacks `grok`; it is in the set (`sync/fold.ts:198`). Arity hypothetical on `detachLocalRows` |
| #1199 | 2 | 0 | 0 | 2 | none | one self-retracted ("No actual bug here"); `{ confidence: undefined }` skips validation — harmless |
| #1197 *(dolly)* | 3 | 0 | 0 | 3 | `60696984` (rebase for a migration-number collision, unrelated) | claims `host_liveness.seen_at` lacks `NOT NULL`; it has it (`migrations.ts:1497`) |
| #1195 | 3 | 0 | 0 | 3 | none | all three self-retracted ("no actual bug", "sound", "no actual execution path") |
| #1190 | 3 | 0 | 1 | 2 | `a3d332d3` (docs tree, unrelated) | (b): `LaneSchema.parse` on a malformed 200 throws a raw zod error, not a `MusterdError` — still true on main (`sync/claim.ts:353`) |
| #1185 | 3 | 0 | 1 | 2 | `7e51fe4f`, `42959bd8` (rebase) | "destructuring crashes on lane pending" — the lane arm returns first (`push.ts:137`); nested-transaction worry is savepoint-safe. (b): the fold-gap claim is unverified and kept as true-not-acted to be conservative |
| #1182 | 4 | 0 | 0 | 4 | none | all four self-confirming ("this is consistent", "correct", "tests pass") |
| #1181 | 2 | 0 | 0 | 2 | `50f38258` (a CLI registry test, unrelated to either finding) | migration v57 "may lack `model_source`" — migrations are linear, v42 landed |
| #1179 | 3 | 0 | 1 | 2 | none | (b): `stakes_provenance: row.stakes_provenance ?? 'declared'` erases null-vs-declared for a folding peer — arguable, not acted on |
| #1178 | 3 | 0 | 1 | 2 | `7c05e43c`, `44c8576b` (rebase) | (b): incident lanes opened without an audit arg write no `lane.claimed` row — true; fixed post-merge by #1179/#1182 from stanley's own "Finding 4" measurement, which does not cite the reviewer |
| #1174 | 2 | 0 | 0 | 2 | none | partial-v54 hypothetical; "test not idempotent" |
| #1173 | 2 | 0 | 0 | 2 | rebase pushes | claims `'merged'` is missing from `AUDITED_LANE_FIELDS`; it has been there since #1071 (2026-08-25) |
| #1171 | 3 | 0 | 0 | 3 | `b22a4cd7` (ADR label, unrelated) | `tie_break` under `ungraded` is a naming quibble; the rest are "comment not enforced" and a test-shape note |
| #1164 | 3 | 0 | 0 | 3 | `cd2815ad` (import order, unrelated) | claims (2026-09-02; falsify: read the cited lines) `rotateAgentKey` re-mints after cutover — it throws `conflict` (`teams.ts:145`); claims `retiredLegacy` is set and never used — used at `http.ts:2966`; a COALESCE "race" |
| #1161 | 5 | 0 | 0 | 5 | none | four self-confirming ✓ bullets; "`envelopePosition` is orphaned" — it is the web client's accessor |
| #1160 *(dolly reviewed)* | 1 | 0 | 0 | 1 | `eee5b545` (rebase after dolly's two blockers) | claims the exempt/named path never sets `worker_family`; the final head does (`http.ts:4561`) and the comment was regenerated against it |
| #1157 | 1 | 0 | 1 | 0 | none | (b): a legacy team key can call host-scoped endpoints with any `host` — true, by design at the time; retired by #1164 (ADR 350) without citing the reviewer |
| #1155 *(dolly reviewed)* | 5 | 0 | 0 | 5 | rebase pushes | all five self-retracted ("No issue", "Correct by design", "Correct") |
| #1154 *(dolly reviewed)* | 3 | 0 | 0 | 3 | none | claims a lease *id* in an audit row breaks a "no secret material" test — the test guards the lease *secret*, the id is the audit key |
| #1152 *(dolly)* | 4 | 0 | 1 | 3 | rebase + `f2211acf` (from izzo's review, not this comment) | claims the acceptor is validated after the lane write — validation is at `http.ts:4416`, the write at `:4447`. (b): `memberFamily` grading a seat with lapsed presence as `same_model` — unverified, kept as true-not-acted |

**Split:** (a) 0, (b) 6, (c) 49. Of the (c) rows, **17 are the reviewer retracting its own finding inside the finding**, and at least **8 assert a defect the source contradicts** (#1200, #1197, #1173, #1164 ×2, #1160, #1152, #1185).

The two seat reviews that did change code in this window (#1154, #1160) were dolly's and stanley's own comments, made before the Haiku comment or without reference to it.

## The Bugbot baseline

**94 findings on 53 PRs. (a) 0–1 · (b)/(c) not classified.** Finding-acceptance rate: **at most 1 / 94 ≈ 1%.**

Only two PRs in the whole baseline have any commit after Bugbot's first finding:

- **#402** — Bugbot: "recall script requires built dist". The later commit `f0dc2d00` edits two markdown files; `scripts/research/adr-163-recall.ts:13` still imports from `dist/` on main. Not acted on.
- **#317** (2026-07-17; falsify: `gh api repos/SandRiseStudio/musterd/compare/4bddbc5f...99e88cf8`) — Bugbot: "webhook secret in policy audit" at 22:44:32; a push at 22:46:18 that masks the webhook in the CLI display, then a second Bugbot finding ("JSON policy dumps webhook") at 22:50:41 on the new head. A 44-line change 106 seconds after the comment is a rebase already in flight, not a response — but it is the one case that cannot be ruled out, so the rate is stated as a range.

The reason the baseline is structurally zero is in the timing, not the findings: **median 0 minutes from Bugbot's first finding to merge** (n = 52; min −14, max 12; falsify: `gh pr view <n> --json mergedAt` against the comment's `created_at`). #405's two Medium findings landed at 20:08:58; the PR merged at 20:09:02. Bugbot reviewed diffs that were already merging. The Haiku reviewer is slightly less so — median 10 minutes, max 335 — and its acceptance rate is the same.

Per-PR rows for the baseline are in the scratch table this page was built from; the durable falsifier is the loop above. The 94 findings were not classified true/false because the Eval does not need it: (a) is zero either way.

## Decision, per ADR 180's own rule

Both arms of the rule point the same way. The Haiku rate (0%) is at the Bugbot baseline (0–1%), so "the cheap model lost nothing that mattered" holds; and it is near zero over 176 in-scope PRs, nearly six times the window the ADR set, so "dropped rather than upgraded" fires. The shadow experiment the ADR reserved for a borderline rate is not warranted: no reviewer whose comments have never once been read can be improved by a better model.

**Dropped 2026-09-02** in the same PR as this page: `.github/workflows/review.yml` and `scripts/review/pr-review.ts` removed; ADR 180 amended; `.github/REVIEW-RULES.md` stays as the human/seat checklist ADR 338 builds on. What that buys back: ~$3/month, one CI job per in-scope PR, and the Anthropic-credit outage surface that produced the job's first-ever error on 2026-09-02.

**What actually carried the load** in this window, measured rather than assumed: seat reviews posted as PR comments (see [ADR 338 drift re-run](adr-338-drift-rerun.md) for that count) and the deterministic gates. The Haiku job's 22 comments sat below them, unanswered, and where a seat and the model looked at the same diff (#1154, #1160, #1155, #1152) the seat's findings changed the code and the model's did not.

## Why the instrument was silent for five weeks

This is the fourth write-only instrument found in a fortnight (ADR 250's repeat-wake count, ADR 338's drift Eval, ADR 252's floor, this) — see [instrument silence](instrument-silence.md). The shape is the same each time: the ADR pre-registers a number, nothing computes it, and the artifact keeps running because running is free and reading costs a session. An Eval that names no reader and no date is a promise, not an instrument (2026-09-02; falsify: find an ADR Eval in `docs/decisions/` with a named computation that has been run on schedule without a lane being opened to run it).
