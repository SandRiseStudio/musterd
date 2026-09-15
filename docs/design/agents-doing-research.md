# Agents doing research — what the AI-researcher job is, why agents lag at it, and what musterd builds toward it

Why AI agents that excel at software engineering underperform at AI-research work, decomposed to
mechanisms — and the claim that musterd's discipline stack (falsifiers, the claims ledger,
longitudinal watches, acceptance) is a small-scale harness for exactly the capability that gap is
made of.

Provenance: nick's Seed via Slack, 2026-08-15 ("Musterd ai researchers"), lane
01M01WGTBQBD0NRANYN1BDFG36; intent clarified in the 2026-08-19/20 design session that also
produced ADR 294 (claims ledger). Sourcing: §1–§2 are external, general-knowledge claims (model
knowledge as of early 2026, no privileged information about any lab); they are dated and should be
re-derived from the research radar before anything expensive is built on them. §3–§5 are claims
about musterd's own record and are checkable in-repo.

## 1. The job, decomposed (2026-08)

What research staff at frontier labs actually spend time on. Research engineer vs. research
scientist is a real distinction on paper (infra and training systems vs. question-picking) that
blurs almost completely in practice at frontier labs.

- **Hypothesis formation** — a belief about model behavior, training dynamics, or data that is
  worth an experiment. The scarce input is taste: most formable hypotheses are not worth their
  experiment's price.
- **Experiment design** — ablations, controls, and deciding *which* runs at *what scale* license
  the conclusion. Includes scaling-law fits: predicting what the big run will do before paying
  for it.
- **Training/eval code and infra** — distributed training, kernels, eval harnesses. The part most
  like software engineering, and (consistently, in public accounts) the part agents already help
  with most.
- **Run babysitting** — watching loss curves for days-to-weeks, catching divergences, deciding
  restart-vs-ride-it-out from checkpoint. Judgment over a slow noisy time-series.
- **Data work** — curation, filtering, dedup, mixture weights. Widely described as a large,
  underappreciated fraction of the job.
- **Evals** — building the instruments that decide whether anything worked; deciding what an eval
  is allowed to conclude.
- **Interpretation and argument** — writing up noisy results and arguing in docs about what they
  mean. A lab's belief state moves on trusted claims, not on raw numbers.

## 2. Why agents lag here while excelling at software engineering

Each mechanism, stated so it could be falsified by a counterexample:

1. **The feedback loop is days and dollars, not seconds.** An agent's strongest play in SWE is
   brute-force iteration against a fast oracle (the test suite). A training run is a slow,
   expensive, noisy oracle; you cannot retry your way to being right. The premium shifts from
   iteration speed to being *calibrated before the experiment*.
2. **Verification is empirical, not logical.** No amount of reading code settles "this data
   mixture helps at scale." The claim resolves only through expensive measurement — so the core
   skill is choosing which expensive measurement to run next. (This is the point-in-time
   measurement problem from the ADR 294 session, at lab scale.)
3. **Signal is noisy and confounded**, so interpreting a result requires priors accumulated across
   many past runs — long-horizon memory plus honest bookkeeping about when those priors were
   wrong. Current agents keep neither by default.
4. **The product is trusted claims.** A researcher's output enters the lab's belief system on the
   strength of their track record. Claim-making cannot be delegated to an agent whose calibration
   nobody has measured — and (as of early 2026) there is no standard eval for it: public agent
   evals concentrate where verification is cheap (SWE-bench-shaped tasks), so agents got good
   exactly where verification is cheap.
5. **The lore is unpublished.** What a healthy loss curve looks like, which hyperparameters
   plausibly matter — frontier labs do not publish their tacit knowledge, so it is thin in every
   training corpus.

Falsifier for the section's thesis: a demonstration of an agent autonomously running a
multi-week research program — choosing experiments, interpreting noisy results, updating its own
priors — at a level labs accept into their belief state. If that exists and holds up, mechanisms
1–4 are being solved and this doc's premise needs re-dating.

## 3. The mapping: research is calibrated claim-making under slow, expensive, noisy feedback

Collapse §2 and that sentence is what remains. Which means the capability gap is not primarily a
coding gap — it is a *discipline* gap, and the disciplines are ones musterd already builds as team
infrastructure:

| what the researcher job demands | musterd's counterpart |
| --- | --- |
| falsifiable hypotheses, stated before the data | wiki rule 3 (a falsifier must be able to fail); watches pre-register the question (lane 01M0ER03RJ) |
| calibration measured over time | the claims ledger (ADR 294): who claimed what, who caught it, how long it stood |
| surviving slow feedback without deciding on snapshots | snapshot decisions as dated debts + longitudinal watches |
| peer review of outcomes, not prose | acceptance (outcome acceptance, cross-family routing) |
| track-record-weighted trust | per-seat/per-model cuts — deliberately held back until the ADR 294 checkpoint, then read with denominators |
| priors that update on being wrong | corrections invalidate-dated, never overwritten; self-caught scored least-bad |

The claims ledger is therefore not team bookkeeping: it is the eval for the researcher capability
itself, run continuously on real work instead of on a benchmark. That is the deep reason the
2026-08-19 session kept landing on the same designs from two different starting points (the
measurement problem and the researcher question).

## 4. What musterd can measure that a benchmark cannot

Small scale, but the record is complete in a way lab-external benchmarks are not: every claim,
correction, acceptance verdict, and challenge is act-typed and model-attested (ADR 101/158), so
calibration can be computed per model *on identical team substrate* rather than on synthetic
tasks. The ADR 294 retrospective already demonstrated the pipeline end to end on eight days of
history (15 entries, all six detection channels exercised).

Standing cautions, in force from
[human-agent-dynamics §4](human-agent-dynamics.md): diagnostic instruments, never Member
rankings; and every cut carries its detection-channel breakdown and denominator (ADR 294
decision 4) because the ledger measures caught wrongness, and catching is proportional to
scrutiny.

## 5. Directions this motivates (each graduates to its own lane before anything is built)

- **Calibration as an ADR 056 axis.** At the ADR 294 checkpoint (2026-10-01 or 100 forward
  entries): detection latency, self-correction share, and claim survival per model, alongside the
  existing throughput comparisons. Blocked until the checkpoint by design.
- **The Goodhart experiment is already registered** (ADR 294, Experiment): pre-ledger history is
  the uncontaminated baseline; measure whether claim boldness, falsifier quality, and retraction
  frequency change after the ledger's existence became known. The observer effect measured, not
  assumed.
- **Watches as researcher training wheels** (lane 01M0ER03RJ): pre-registered questions with
  falsifiers and durations are the slow-feedback discipline of §2.1 practiced at team scale.
- **Claim-boldness metrics need care before anyone builds one**: a naive wrongness score trains
  hedging (ADR 294 decision 5's whole reason). Any informativeness metric goes through a proper
  scoring rule or does not ship.

## What would make this doc wrong

Dated 2026-08-20. Beyond §2's falsifier: if forward ledger data shows detection latency and
self-correction share do *not* differ meaningfully across models or over time — i.e. calibration
on team substrate carries no signal — then the "ledger as researcher eval" claim fails and this
doc gets invalidate-dated, whatever the external story does.
