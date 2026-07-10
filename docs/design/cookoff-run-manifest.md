# cookoff run manifest — the pinned apparatus for the run ladder

> **Opened 2026-07-10** (Lane `01KX6QBY86YD9A7W696P31ABXQ`, Goal cookoff-value-experiment) as the
> concrete run record [ADR 051](../decisions/051-trace-eval-experiment-flywheel.md) calls for and
> [ADR 123 §7](../decisions/123-cookoff-measurement-protocol.md) leaves open. It pins the spend- and
> timing-sensitive variables the run ladder is scored under — frozen _before_ any cell runs, per
> [ADR 122](../decisions/122-cookoff-value-experiment.md)'s honesty rule — and records the smoke rung's
> apparatus de-risking. The experiment it serves is [`cookoff-experiment.md`](cookoff-experiment.md);
> the metrics are [`cookoff-measurement.md`](cookoff-measurement.md); the fixture is
> [`cookoff-scenario-repo.md`](cookoff-scenario-repo.md).

## 1. The pins (identical across every cell — the invariants that must not confound the delta)

| Variable               | Pinned value                                                                                                                                                    | Source                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Model**              | **Claude Sonnet 5** (`claude-sonnet-5`)                                                                                                                         | mid-tier budget, efficiency-first (owner)      |
| **Harness**            | **Claude Code** `2.1.205`                                                                                                                                       | the fixed harness (ADR 122 variable isolation) |
| **N** (multi-agent)    | **3** (cells C2 / C3 / D)                                                                                                                                       | ADR 122 matrix                                 |
| **Kickoff SHA**        | `ea5c6d4` (fixture `main` tip)                                                                                                                                  | scenario repo / `scoring.config.json`          |
| **Predicate set**      | **v1**                                                                                                                                                          | ADR 123                                        |
| **Scoring tool**       | `musterd archaeology` from product `0.2.0` @ `481b5d1` (PR #212)                                                                                                | archaeology reference collector                |
| **Exclude globs**      | frozen in `scoring.config.json` (node_modules, dist, lockfiles, snaps, `acceptance/**`, harness files)                                                          | ADR 123 §4                                     |
| **Wall-clock cap `T`** | **90 min per cell run** _(proposed — flagged for smoke calibration, §4)_                                                                                        | this manifest                                  |
| **Permission policy**  | one pinned Claude Code allowlist across all cells (repo read/edit/write + `git`/`pnpm`/`node`/`vitest`), so no cell pays approval touches another cell does not | ADR 123 §5                                     |

**Model is the same in every cell** — it is held fixed so the only deltas are musterd present/absent and
N=1/N=3 (ADR 122 variable isolation). The per-model coordination leaderboard is a _different_ axis
(vary model in cell D only) and is out of scope for the sell run.

**Cross-family judging is diagnostic-only.** Code-quality (the LLM-judged rubric, ADR 122 "scoring
beyond the guardrail") runs post-hoc with a **non-Claude** judge family (ADR 101 diversity applied to
evaluation). It never touches the headline — the hidden acceptance suites carry the outcome floor, so
the sell number needs no judge.

**Per-cell actor identities.** Each cell configures its own git seat identities (ADR 109) in that
cell's `scoring.config.json` `actors` list; a commit attributed to no configured actor fails the run
(ADR 123 §2). The reference-solution's `alix`/`boro`/`cyra` seats are the fixture's own validation
identities, not a cell's.

## 2. Spend authorization (owner-gated, 2026-07-10)

Owner (Nick) authorized **the smoke rung only**, then a check-in before more. Real money goes in one
rung at a time; each rung gates the next.

| Rung         | Cells               | Runs     | Authorized             |
| ------------ | ------------------- | -------- | ---------------------- |
| **Smoke**    | D                   | 1        | ✅ now                 |
| **Pilot**    | A + D               | 2 each   | ⏸ after smoke check-in |
| **Flagship** | A / B / C2 / C3 / D | 3–5 each | ⏸ after pilot check-in |

The apparatus checks that carry **no model spend** (archaeology recalibration, scoring-harness
validation — §3) are done ahead of the paid smoke build; only the cell-D agent build itself draws the
authorized smoke spend.

## 3. Smoke-rung apparatus de-risking (done 2026-07-10, no model spend)

The scenario repo, hidden suites, scoring script, and git archaeology are proven to run together
_before_ any paid cell:

- **Scoring harness — validated first-hand.** `score.ts --delivered reference-solution` reports
  **8/8 acceptance** and **12.2% wasted-work** (18 W1-abandoned lines), correctly attributed across
  the three distinct seats — `cyra`'s deliberately abandoned commit surfaces as 42.9% of _her_
  authored lines. The four-metric report rolls end to end.
- **Archaeology tool — runs on any repo, git-only, no daemon**, keying actor identity off git
  attribution (ADR 109) exactly as the control cells require.

### The finding-001 ≈37% recalibration gate is NOT reproducible — and should not gate the smoke run

`cookoff-experiment.md` and `cookoff-measurement.md` name the smoke rung's calibration gate as
"reproduce finding [001](../research/001-telemetry-gaps-p3-dogfood.md)'s ≈37% (36–40% band)." Run
first-hand this session, `musterd archaeology` over finding 001's actual P3-cutover session window
(37 commits, `bef7466..fa5a496`) reports **0.0%**, not 37% — and this is **correct tool behaviour, not
a bug**, for two structural reasons the git reference collector cannot work around:

1. **Single-actor history.** All of that session's commits are authored "Nick Sanders" — finding 001's
   own **gap 8** ("git can't attribute agents… only musterd's identity layer distinguishes the four").
   The W3-duplicate and W2-clobber predicates key on _different_ actors (X ≠ Y), so they structurally
   cannot fire; W4 churn needs conflicted merges that a linear squash history has none of.
2. **The abandoned branches are gone.** W1 (abandoned work) needs unreachable commits in the
   `rev-list --all` window. The session's abandoned branches were deleted post-merge (the P3 revert
   `d08cf43`→`afdc881` stays _in_ delivered ancestry, so it is not abandoned), leaving nothing for W1
   to catch today.

finding 001's ≈37% was a **forensic reconstruction** from transcripts + line-count proxies, which the
finding itself flags as "order-of-magnitude… a qualitative inventory, not a benchmark." It measured a
concept the git predicate set v1 computes differently, over history that lacks the two things the git
collector needs. **It is the conceptual anchor, not a reproducible gate.**

**Re-specified smoke calibration gate:** the tool's real, reproducible anchor is the fixture's
**multi-seat `reference-solution` — 12.2%, non-zero, per-actor** (validated above). It fires precisely
because the fixture supplies what finding 001's history lacks: distinct ADR 109 seat identities and a
preserved abandoned branch. The cookoff cells carry both (each agent a git identity; in-run branches
preserved via the `--single-branch --branch main` per-cell clone), so the tool is in its valid domain
on every cell. **The smoke rung gates on the reference-solution anchor, not finding 001.** A one-line
correction to the two design docs is proposed under this manifest's authority.

## 4. Still open (flagged for the smoke run, not this freeze)

- **Wall-clock cap `T`** — proposed 90 min/run; calibrate against the smoke cell-D build's actual
  time-to-done before the pilot (like the W3 dup-hunk thresholds, ADR 123 §7).
- **Billed-cost roll-up** — tokens-to-done gets its public-pricing multiplier now the model is pinned
  (Sonnet 5); wire it into `score.ts` before the pilot so the tokens support number is comparable.
- **Per-cell setup runbook** — the clone/seed/identity/permission-policy steps per cell (C2 dispatch,
  C3 `TASKS.md` board, D musterd Goals/Lanes) — authored when the smoke rung runs.

## Related

[ADR 122](../decisions/122-cookoff-value-experiment.md), [ADR 123](../decisions/123-cookoff-measurement-protocol.md),
[`cookoff-experiment.md`](cookoff-experiment.md), [`cookoff-measurement.md`](cookoff-measurement.md),
[`cookoff-scenario-repo.md`](cookoff-scenario-repo.md),
[ADR 051](../decisions/051-trace-eval-experiment-flywheel.md) (the manifest this realizes),
[ADR 101](../decisions/101-model-as-a-variable.md) (model pin + cross-family judging),
[ADR 106](../decisions/106-unified-git-workflow.md) (what "delivered" means),
[ADR 109](../decisions/109-seat-git-attribution.md) (actor identity),
finding [001](../research/001-telemetry-gaps-p3-dogfood.md) (the conceptual 37% anchor + why it is not
a reproducible gate).
</content>
</invoke>
