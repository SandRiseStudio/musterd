# cookoff measurement protocol — wasted-work predicate set v1 + interventions counting

> **Frozen 2026-07-10** by [ADR 123](../decisions/123-cookoff-measurement-protocol.md), closing the
> first two "open before the smoke run" items of [ADR 122](../decisions/122-cookoff-value-experiment.md) /
> [`cookoff-experiment.md`](cookoff-experiment.md). This is the operational spec the git-archaeology
> tool implements and the run ladder scores against. Disclosed before any run, per ADR 122's honesty
> rule. Changes to the predicates after the first smoke run require a new predicate-set version via
> ADR — a frozen ruler must not bend to fit the result.

## 1. Scope and grounding

wasted-work % is defined abstractly in ADR 122 §5 (artifact survival + authorship attribution,
collector-agnostic). This doc freezes the **git reference collector**'s operational predicates —
the concrete rules a script can evaluate with no judgment calls mid-run. The reference measurement is
finding [001](../research/001-telemetry-gaps-p3-dogfood.md)'s forensic method (the ≈37% anchor),
whose two hard-won rigor lessons are baked in as exclusions:

- a **surviving reimplementation is not waste** (the `b866c90` lesson — counting the handshake's
  reimplementation would have inflated waste by ~950 lines);
- the two dominant real-world waste modes are **dependency-failure reverts** and **byte-identical
  dup pairs** — the predicates must catch both without a human in the loop.

## 2. Run frame (what the predicates evaluate over)

- **Run window** — from the kickoff commit (the scenario repo's pinned starting SHA, identical in
  every cell) to **run end**: all tickets reported done by the agents, or the wall-clock cap `T`
  (pinned per manifest, ADR 051), whichever is first.
- **Delivered state** — the tip of the integration branch (`main` in the scenario repo, merged per
  the [ADR 106](../decisions/106-unified-git-workflow.md) workflow) at run end. Work in flight at
  run end is not delivered.
- **Actor identity** — git attribution only ([ADR 109](../decisions/109-seat-git-attribution.md):
  per-worktree seat identity; `Co-authored-by` trailer survives the squash). Never the daemon —
  cells A/C2/C3 have no daemon. Each agent in every cell gets a distinct git identity at setup; a
  commit whose author matches no configured actor fails the run (apparatus bug, not a data point).
- **Unit of account** — **authored lines**: added lines in commits authored inside the run window,
  after exclusions (§4). Line counts are the finding-001 unit and are diff-derivable in every cell.

## 3. The predicates (evaluate in order; first match claims the line)

Every authored line is classified exactly once. Precedence: **W3 → W1 → W2 → W4 → survived.**
Duplicate-scope is the trap the fixture engineers for, so duplication outranks abandonment (a
branch abandoned _because_ it duplicated another is duplicate work, not generic abandonment).

### W3 — duplicated work

Lines authored by actor Y that re-produce work already authored by actor X (X ≠ Y):

- **Exact:** commit patch-id equality (`git patch-id --stable`) across different-actor commits, or
  byte-identical file content introduced independently on two branches. The **later-authored** copy
  is the waste.
- **Overlapping hunks:** two different-actor commits on different branches touch the same file with
  intersecting post-image line ranges, where the intersection is **≥ 8 contiguous non-blank
  normalized lines** (whitespace collapsed) **or ≥ 50% of the smaller hunk**. Only the intersecting
  lines of the later commit count.

### W1 — abandoned work

Lines in commits **not reachable from the delivered state** and with **no patch-equivalent commit**
(`git cherry` / patch-id) in delivered history. Catches abandoned and superseded branches. The
patch-equivalence test is the surviving-reimplementation exclusion: rebased or re-landed work is
not waste.

### W2 — clobbered work

Lines authored by X that reach the delivered state's history but are **deleted or overwritten by a
different actor Y before run end**, excluding deletions that are part of W3-classified duplication
resolution. Detected by line-history walk (`git log -L` / blame of the deleting commit's pre-image).
Self-rework (X revising X's own lines) is never waste — iteration is normal work.

### W4 — conflict churn

For every merge in delivered history, replay the auto-merge (`git merge-tree`). Lines where the
actual merge result differs from the clean auto-merge result (manual conflict resolution, "evil
merge" content) count as churn, attributed to the merge's author. Squash-merge cells (ADR 106
default) surface this instead as rebase-conflict rework, caught by comparing the pre-rebase and
post-rebase patch-ids of the same branch: non-equivalent re-landed lines count as W4.

### The number

```
wasted-work % = (W3 + W1 + W2 + W4 unique authored lines) / total authored lines in window
```

Reported with the per-predicate breakdown (the diagnostic axes — finding 005's discipline: never a
single collapsed score without its decomposition).

## 4. Exclusions (uniform across cells)

- Generated artifacts: lockfiles, `dist/**`, snapshots, vendored code (frozen glob list in the
  scenario repo's scoring config).
- Whitespace-only and blank lines (normalized before counting).
- The kickoff scaffold: lines present at the pinned starting SHA.
- Merge-commit lines that are pure ancestry (only W4 deltas count on merges).
- Self-rework, per W2.

## 5. Interventions counting protocol

**Definition — one intervention = one human touch directed at an agent or its work product after
kickoff.** The kickoff prompt itself (identical text per cell, one per agent) is protocol, not an
intervention.

### Touch taxonomy

| Code | Touch                                                                | Notes                                                       |
| ---- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| I1   | **dispatch** — assigning or splitting work                           | C2's up-front dispatch counts, one per assignment (ADR 122) |
| I2   | **unstick** — prompting a stalled or looping agent to continue       |                                                             |
| I3   | **answer** — answering an agent's question or approval request       |                                                             |
| I4   | **tie-break** — deciding between conflicting approaches or ownership |                                                             |
| I5   | **conflict-resolution** — hand-resolving a merge or clobbered code   |                                                             |
| I6   | **correction** — pointing out broken/wrong work, asking for rework   |                                                             |

### Uniformity rules

- **Run log discipline:** every touch is logged as it happens — `{timestamp, cell, run, agent,
code, one-line note}` — in a per-run `interventions.log` committed with the run artifacts. In the
  non-musterd cells this hand-kept log is the only record, so it is kept in _all_ cells and
  reconciled against the message log in musterd cells.
- **musterd cells pay full fare:** every directed act the human sends through musterd (answer,
  `steer`, tie-break, dispatch) is an intervention with the same codes — coordination through the
  product is not free steering.
- **Same human** runs every cell of a run set; the human intervenes only when an agent is blocked,
  stalled, or visibly diverging — no proactive coaching in any cell.
- **Harness permission prompts** are neutralized, not counted: permission policy is pinned identical
  across cells in the manifest so no cell needs approval touches the others don't.
- **interventions-to-done** = total touches in the run window. Reported with the per-code breakdown.

## 6. tokens-to-done (freezing the counting rule)

Total tokens across all agents in the run window, from harness usage records (Claude Code `.jsonl`
`usage` fields): input + output + cache-read + cache-write, each also reported separately, with a
**billed-cost roll-up at the pinned model's public pricing** as the comparable number (cache tiers
weight differently; raw-sum alone misleads). musterd MCP tool traffic is inside the agents'
transcripts, so coordination overhead is internalized by construction (ADR 122 §2). Wall-clock is
logged per run and reported, never headlined.

## 7. Still open (not this freeze)

- **Pin the flagship model + harness version** — a spend/timing decision for the run-ladder Lane;
  the manifest (ADR 051) records it when the smoke run is scheduled.
- The dup-hunk thresholds in W3 are frozen for v1 but flagged for calibration review against the
  smoke run's transcripts — any change is predicate set v2, disclosed before the runs it scores.

## Related

[ADR 123](../decisions/123-cookoff-measurement-protocol.md) (the freeze),
[ADR 122](../decisions/122-cookoff-value-experiment.md) (the experiment design),
[`cookoff-experiment.md`](cookoff-experiment.md) (the narrative),
finding [001](../research/001-telemetry-gaps-p3-dogfood.md) (reference method + 37% anchor),
[`lanes-and-the-multi-agent-tax.md`](lanes-and-the-multi-agent-tax.md) §3.4 (the measured waste
modes), [ADR 109](../decisions/109-seat-git-attribution.md) (actor identity),
[ADR 106](../decisions/106-unified-git-workflow.md) (what "delivered" means),
[ADR 051](../decisions/051-trace-eval-experiment-flywheel.md) (the pinned manifest).
