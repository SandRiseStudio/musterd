# 006 — Enforcement induces coordination where guidance cannot: the cookoff pilot

**Question.** The cookoff smoke + A/B runs left a stark negative: across six headless seats in two
runs, **zero of eight seeded lanes were ever claimed** — every agent soloed the whole backlog, and
wasted-work sat at 65.5–82.6%, whether the primer was passive (advertisement) or actively directive
(guidance). The escalation-ladder question this pilot answers: does **structure** — ADR 150
enforcement gates that _deny_ an edit to a contended surface unless the seat owns a covering lane,
and route costly actions through a to-human `ask` — lift coordination off that floor, repeatably?
And against what cost baseline: what does the same backlog cost a **solo** agent with no
coordination surface at all?

**Setup (pinned manifest, ADR 051; runbook `../design/cookoff-cell-runbook.md`).**

- **Fixture:** the Skiff scenario repo (bespoke ferry-billing service, 8 trap tickets), kickoff SHA
  `ea5c6d4`, delivered ref `main`, hidden acceptance suites overlaid at scoring time (ADR 123
  predicate set v1, `score.ts`).
- **Cells:** **A ×2** (`N=1`, musterd absent — one CLI session, flat `TASKS.md`, no daemon/MCP) and
  **D-enforcement ×2** (`N=3` musterd seats, fresh clone/daemon/db/team per run, the exact cell-D3
  procedure). Model Claude Sonnet 5, harness Claude Code, identical kickoff text and permission
  allowlist everywhere; the musterd MCP surface present only in D (it is the treatment).
- **Enforcement config (D only):** contended-surface classes `src/tariff.ts` + `src/config.ts` at
  posture **block** (Gate A: an Edit requires owning a covering lane) and costly-action class
  `push-remote = git push*` at **block** (Gate B: deny emits a to-human `ask`). PreToolUse
  gate hook verified per seat before launch. Gate B asks deliberately left unanswered — the
  no-answer behaviour is itself an ADR 147 measurement.
- **Metrics:** headline wasted-work % (git archaeology, W1–W4), guardrail hidden-acceptance pass
  rate, supports interventions-to-done and tokens-to-done; plus claim-rate, ask-count, and the
  deny→response compliance profile from the `lane.gate`/`action.gate` audit rows.

**Baseline.** The 2026-07-17 A/B (both guidance rungs): 0/8 lanes claimed, 0 asks, 65.5% / 82.6%
wasted-work, 6/6 seats soloed. Cell-D3 (2026-07-19, first enforcement run): 8/8 lanes claimed,
0.59% wasted, 8/8 acceptance, 1 ask (route-around).

**Result.**

| run | N   | lanes claimed | wasted-work      | acceptance | interventions | asks | tokens in/out | wall    |
| --- | --- | ------------- | ---------------- | ---------- | ------------- | ---- | ------------- | ------- |
| A1  | 1   | —             | **0.0%** (0/138) | 8/8        | 0             | —    | 57.7k / 24.7k | 4m36s   |
| A2  | 1   | —             | **0.0%** (0/123) | 8/8        | 0             | —    | 65.1k / 23.4k | 2m45s   |
| D4  | 3   | **8/8**       | 6.04% (9 W3)     | 8/8        | 0             | 1    | 108k / 174k   | ~34m38s |
| D5  | 3   | **8/8**       | 10.64% (15 W3)   | 8/8        | 0             | 2    | 131k / 131k   | ~7m36s  |

### 1. The enforcement effect replicates — n=3, 9/9 seats

With D3, every enforcement run claimed **8/8 lanes** (9/9 seats coordinated) vs **0/8 in every
guidance-only run** (6/6 seats soloed). The compliance profile repeats too: deny → claim → retry →
allowed, with genuine division of labour and in-band contention negotiation (D4 saw two lane
reassignments settled via `status_update`). The escalation ladder now reads: advertisement failed,
guidance failed, **structure flipped the behaviour in every run that had it**.

### 2. Wasted-work: an order of magnitude under the uncoordinated floor, but not zero

0.59% → 6.0% → 10.6% across D3/D4/D5, vs 65–83% uncoordinated. All pilot waste is W3 duplication
authored by one seat per run (in both pilot runs, `dee` — the seat that over-claimed in D5).
Enforcement forces _claiming_; it does not by itself stop an owner from re-implementing a
neighbour's overlap. Run-to-run variance is real and the flagship's per-cell n must absorb it.

### 3. The solo denominator: on a backlog this size, one agent is the ceiling **and** the floor

Both A runs: 0% waste (definitionally near-guaranteed at N=1), **8/8 hidden acceptance**, ~24k
output tokens, under five minutes. D-enforcement output-token mean is **≈7.7× solo** (185k vs 24k)
and slower in wall-clock. This kills the D-vs-solo framing for good: on a backlog one competent
agent can hold in its head, coordination pays for nothing. **The honest sell is D vs uncoordinated
N** — people reach for parallel agents as work outgrows one context, and _that_ is where 65–83% of
authored lines burn. Cell A's job was to price the alternative honestly, and it did.

### 4. First **hold** observed on a Gate B deny (ADR 147 datum)

D5 `dee`, denied `git push`, raised the ask and **held** — exited with the work unlanded,
"scheduled a check-in to retry once that clears." Its teammate `del` then landed the tree via a
local `--ff-only` merge in the shared main worktree (route-around _by teammate_). D3's and D4's
askers route-around themselves (local merge, same outcome). So hold-vs-route-around is
seat-idiosyncratic even under an identical contract — direct input for the ask-contract parity
work: the deny string must say what holding buys, or a teammate's local merge will price it at
zero.

### 5. Guard held; gates attribute where identity lives

Interventions-to-done = 0 in all four runs — nobody wedged (the D3-attempt-1 lesson: the cell
allowlist **must** include the musterd MCP/CLI surface, since complying with a deny requires the
tools the deny names). One observability wart: gate rows can attribute to the **ambient human
identity** when a seat runs a gated command with its cwd in the shared main worktree — the same
family as the ADR 109 merge-attribution leak, now visible in the audit trail.

**Honest-N caveat.** One fixture, one model family, one harness; n=2 per pilot cell (n=3 for
enforcement counting D3); a backlog sized so a solo agent finishes in minutes. Wasted-work is a
line-level approximation read beside its guardrail, never alone. The B / C2 / C3 cells have not
run — the D-vs-C3 delta (musterd vs a markdown board at N=3) is the flagship's question, and the
73× spread between D's waste (≤10.6%) and uncoordinated N=3 (65–83%) is suggestive, not yet the
controlled comparison. No leaderboard, one lab-notebook entry.

**What it changes.**

- **The value claim has its first replicated mechanism:** declared-block surfaces + a verified
  PreToolUse gate move claim-rate 0/8 → 8/8 and wasted-work 65–83% → ≤10.6%, across three
  independent runs. This is the number the flagship (5 cells × 3–5 runs) is now worth spending on.
- **Positioning: never sell D against solo.** The pilot makes the cost of coordination visible
  (~7.7× output tokens, slower wall-clock at this scale) — the pitch is against uncoordinated
  parallelism, and cookoff now prices both sides of that comparison.
- **ADR 147 gets its variance datum:** hold and route-around both occur under the same unanswered
  ask; the contract needs parity (what does holding buy?) before the ask stream can claim it
  changes outcomes.
- **Runbook hardening** (apparatus traps now documented there): provisioning a cell while other
  harness sessions run clobbers shared harness config (`~/.claude.json` MCP entries, seat
  settings); a seat's `git clean` in the shared worktree can delete the clone's binding; both are
  pre-launch re-verification items.
- Artifacts: `~/cookoff-run/run-artifacts-pilot/` (scores, session logs, usage, audit snapshots;
  `PILOT-SUMMARY.md`). The coordination-dataset seed stays gated on the flagship transcripts + the
  ADR 051 opt-in/redaction posture.
