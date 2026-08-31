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

## 2. Spend authorization (owner-gated, 2026-07-10; ladder climbed 2026-07-20)

Owner (Nick) authorized **the smoke rung only**, then a check-in before more. Real money goes in one
rung at a time; each rung gates the next. Smoke ran 2026-07-17; nick authorized the pilot the same
morning; flagship followed the same day after the pilot check-in (finding
[006](../research/006-enforcement-induces-coordination-cookoff-pilot.md)).

| Rung         | Cells               | Runs     | Authorized                          |
| ------------ | ------------------- | -------- | ----------------------------------- |
| **Smoke**    | D                   | 1        | ✅ 2026-07-17                       |
| **Pilot**    | A + D               | 2 each   | ✅ 2026-07-20 (after smoke check-in) |
| **Flagship** | A / B / C2 / C3 / D | 3 each   | ✅ 2026-07-20 (after pilot check-in) |
| **D-res**    | D + residency       | —        | ⏸ defined §3b, not authorized      |
| **E**        | too-big-for-solo    | —        | ⏸ design in progress, not authorized |

The apparatus checks that carry **no model spend** (archaeology recalibration, scoring-harness
validation — §3) ran ahead of the paid smoke build. D-res and E still have no spend row — do not
launch them on leftover flagship authorization.

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

## 3b. Cell **D-res** — the residency row (pinned 2026-07-14; **defined, NOT authorized**)

The harness-axis cell-D variant ADR 122 §6 and ADR 131's O&E both name (research finding 005's
resident-vs-CLI coverage axis). Same pins as cell D in every respect (§1: model, harness version,
N=3, kickoff SHA, predicate set, wall-clock cap) with ONE delta: the three seats are **enrolled in
harness residency** under a running `musterd host` (wake actuator resident for the whole run;
`reply-only` tool policy is NOT used here — the run needs edits, so `seat-policy` under the pinned
cell allowlist), where plain cell D runs fire-and-exit CLI sessions.

Measures, beyond the standard cell scoring: **attestation coverage** (finding 005's 100% resident
vs ≈5% fire-and-exit — provenance + model + build fields present per occupancy), **steer-lands
rate** (does a mid-task `steer` reach a working/woken seat inside the ADR 125 window), and **wake
latency / answer rate** for acts that arrive while a seat is between sessions (from
`musterd report residency`). Runs when the ladder resumes, after the pilot rung, under its own
spend authorization row in §2 — this section defines it so the definition predates the data.

## 4. Still open (flagged at freeze; status as of 2026-08-31)

- **Wall-clock cap `T`** — proposed 90 min/run. Calibrated by the runs themselves: pilot A finished
  in 2m45s–4m36s, D in ~7–35 min; flagship stayed inside the cap. 90 min remains the safety cap, not
  a pass/fail deadline. Cell E treats it as a **censoring boundary** (incomplete-at-cap), not a
  hidden acceptance threshold (`~/cookoff-run/e-ladder/e1-apparatus-check.md`).
- **Billed-cost roll-up** — still open. Tokens-to-done is reported raw (finding 006: D ≈7.7× solo
  output tokens). The public-pricing multiplier was not wired into `score.ts` before the flagship.
- **Per-cell setup runbook** — ✅ **A / B / C2 / C3 / D filled** in
  [`cookoff-cell-runbook.md`](cookoff-cell-runbook.md) from the 2026-07-17 smoke + 2026-07-20
  pilot/flagship scripts. D-res and E stay unfilled until their spend gates (honesty rule).

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
