# 005 — MAST-in-the-wild goes multi-model: telemetry from three frontier non-Claude agents doing real work

**Question.** Findings 003/004 established that non-Claude seats attest and that the diversity flag
fires correctly. This asks the next thing: when three real frontier agents (two vendors) do **actual
musterd work in parallel** for a few hours, what does the coordination telemetry — the message log,
the audit trail, the OTel spans/metrics — actually reveal? Is it rich enough to see _how different
models coordinate_ (the model-as-variable thesis), and where are its gaps?

**Setup (pinned experiment manifest, ADR 051).**

- **Team `difftest`**, three resident Cursor seats + the human operator (`nick`):
  `grokbot` (`grok-4.5`), `grokbot2` (`grok-4.5`), `gptbot` (`gpt-5.6-sol`).
- **Real work, three disjoint lanes** (pre-seeded with `--surface` globs, handed off through musterd):
  grokbot → fix #172 (PR #203), grokbot2 → roster MODEL column (PR #202), gptbot → the
  harness-attestation ADR (PR #204). All three merged.
- **Window:** 2026-07-09 16:25 → 20:35 local, **41 acts** (34 from agents, 7 from the human).
- **Telemetry mined:** the message DB (`meta.model` per act), `musterd report coordination`, the audit
  log, and the live OTel sink (`~/.musterd/otel-sink.log`, `dev-otel-sink.mjs`, ADR 082).

**Baseline.** Findings 001/002 established what the telemetry _should_ catch (broadcast-journal, ignored
help, stalls) on a **single-family** standing team (revive: ~8% directed exchange, ~80% broadcast). No
prior session had a **multi-vendor** team doing real parallel work to measure against.

**Result.**

### 1. Attestation coverage: 100% for resident seats — the multi-model anti-#172 confirmation

Every agent act carried its model stamp; the human's carried none (correctly):

| seat         | acts | stamped | model       |
| ------------ | ---- | ------- | ----------- |
| grokbot      | 19   | 19/19   | grok-4.5    |
| grokbot2     | 10   | 10/10   | grok-4.5    |
| gptbot       | 5    | 5/5     | gpt-5.6-sol |
| nick (human) | 7    | 0/7     | —           |

**34/34 agent acts stamped**, and the OTel spans carry `musterd.model.family` on every envelope — so
attestation propagates all the way to traces. Contrast finding 003's tiny-model CLI harness at ~5%
(#172). This is the empirical statement of what #172 / ADR 119 always argued: **resident MCP harnesses
have full per-act coverage; the gap is specific to non-resident, fire-and-exit CLI seats.** The human
seat staying unstamped also confirms the ADR 121 posture (no model on human seats) held here.

### 2. Coordination density ~4× the standing team

difftest ran **32% directed exchange / 42% broadcast** (13 directed, 28 broadcast of 41 acts) vs
revive's 8% / 80%. Zero MAST pathologies (no ignored help, no stalls, no circular handoffs). A fresh,
lane-scoped, bounded team coordinated far denser than the sprawling standing roster — evidence for
"team, not swarm" and for pre-seeded lanes as a coordination aid. (Small N, task-focused — a signal,
not a law.)

### 3. Per-model coordination _style_ differs — diagnostic, **not** a ranking

Typed-act discipline (typed acts vs free-text `message`), and activity:

| seat (model)        | free-text | typed | % typed | total acts |
| ------------------- | --------- | ----- | ------- | ---------- |
| gptbot (gpt-5.6)    | 0         | 5     | 100%    | 5          |
| grokbot2 (grok-4.5) | 2         | 8     | 80%     | 10         |
| grokbot (grok-4.5)  | 7         | 12    | 63%     | 19         |

**This is a diagnostic instrument, never a Member ranking** (human-agent-dynamics §4, Goodhart). Read
carefully it _refutes_ any simple ranking: the most protocol-disciplined seat (gptbot, 100% typed) was
also the **least active** and the one whose task needed the most human help (its ADR hit a number
collision and it stopped before committing); the **chattiest** seat (grokbot, 7 free-text narrations)
produced the **sharpest engineering** (the #172 fix, more precise than finding 003 itself). So
"typed-act %" measures _coordination style_, and it is orthogonal to work quality. That orthogonality
— style ≠ outcome — is the finding, and it is exactly the per-model coordination texture the
model-as-variable thesis says benchmarks can't see.

Also observed: **grokbot2 over-accepted** — three `accept`s answering a single `request_help` (redundant
acts), a minor weak-coordination tic visible only because the acts are typed.

### 4. Two latency clocks, from two telemetry layers

- **Responder latency (OTel spans, ms-precise):** `request_help → accept` was **48.0s** (grok→gpt) and
  **47.5s** (grok→grok) — the model's read-decide-answer time, near-identical across vendors.
- **Work-loop latency (`report coordination`):** 4 loops closed, **~20m median** — the full
  request→resolution span including the actual PR work. The two numbers measure different things; only
  the span layer exposes the fast responder clock.

### 5. The diversity flag on live work (consistent with 004)

grok↔gpt review chain silent (diverse), grok↔grok flagged (`all grok-*`). Correct.

### 6. A process finding: auto-merge short-circuited peer review

The peer-review chains meant to run on the _real_ PRs (each agent `request_help`-ing a reviewer) never
fired — the PRs **auto-merged** instead. The only review chains in the log are the two _manual_ test
chains. So the intended "reviews feed the diversity flag on real work" loop did not close, and the
session produced **no new** diversity observations beyond the seeded test. Auto-merge and
peer-review-as-coordination are in tension; a team that wants review-chain signal must not auto-merge.

**Honest-N caveat.** One team, ~4h, 41 acts, three seats across two vendors, one operator, local
single-daemon. Every per-model number is a single observation of _style_, explicitly not a quality or
capability measurement (§3). The latency figures are two chains each. Nothing here is a leaderboard —
it is one lab-notebook entry establishing that the telemetry is rich enough to _ask_ these questions.

**What it changes.**

- **The model-as-variable thesis now has its first real multi-vendor coordination trace** — the raw
  material (per-act `model.family` on every span) for the per-model coordination leaderboard exists.
- **It names the blocking observability gap for that leaderboard.** The coordination **metric gauges**
  as exported are **undimensioned**: `musterd.delivery.latency points=[…]`, `coordination.loop_latency`,
  `open_loops`, `agent.tokens`, `insight.diversity_flags` carry **no team or model attribute** in the
  sink. Per-team and per-model latency/cost therefore can't be _queried from the metrics_ — they must be
  **reconstructed from the team+model-tagged spans** (as this finding did). A per-model leaderboard needs
  `loop_latency` / `delivery.latency` / `agent.tokens` **dimensioned by `model.family`** (and team).
  This is the direct sequel to findings 001/002: the traces got rich; the aggregated metrics have not
  caught up. Candidate next ADR (increment on ADR 082/101).
- **A coordination-process note** for the roadmap's review surfaces: auto-merge suppresses
  peer-review-chain telemetry (§6).
