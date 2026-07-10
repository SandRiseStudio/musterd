# cookoff — the controlled experiment that proves musterd's value

> **Design frozen 2026-07-10** (facilitated brainstorm; supersedes the "prove musterd's
> measurable value" open thread). Captures how musterd is evaluated on three nested targets —
> **the model**, **the harness**, and **musterd itself** — through one reusable instrument, the
> **cookoff**. The commercial crux is the third target: a sellable, measurable proof that musterd
> adds value. This doc is the fuller narrative and the reasoning; the tight decision is
> [ADR 122](../decisions/122-cookoff-value-experiment.md). Corrections via ADR + update this doc.

## Why this exists

musterd's whole thesis — that coordinated agents beat siloed ones — has been asserted from dogfood
anecdote (finding [002](../research/002-telemetry-caught-broadcast-journal.md) "it caught us
journaling") and one forensic number (finding [001](../research/001-telemetry-gaps-p3-dogfood.md):
wasted work ≈ 37% of code produced). Neither is a controlled comparison. To sell musterd we need to
say a number out loud and defend it against a skeptic: **with musterd vs. without, on the same
task.** This doc designs the experiment that produces that number, and — because the same instrument
answers the model and harness questions when you vary a different term — folds the whole
`model-experimentation.md` evaluation agenda into one fixture.

The design is **sell-first**: it starts from the claim we want to make and reverse-engineers the task
that makes the claim honest, rather than building a generic benchmark and hoping a dramatic number
falls out. A task designed sell-agnostically risks measuring nothing.

## Who we are selling to (the frame that disqualifies options)

**ICP: solo builders and small teams**, not enterprise yet. For this ICP the user _is_ the buyer, so
the pitch has to hit a **felt pain**, not an ROI table. The three pains, from our own dogfood logs:

- **clobbered / duplicated effort** — agents redoing or overwriting each other's work;
- **money** — paying twice for the same diff in API tokens, on a personal card;
- **attention** — spending the evening _refereeing_ agents instead of building.

Every metric below is chosen because it maps to one of those pains. The competitor comparison
(CrewAI, OpenAI Agent SDK) sells to a _different_ buyer and confounds two variables at once, so it is
explicitly Phase 2 — for this ICP the real incumbent is not a framework, it is **"me plus a markdown
file."**

## The metrics: one headline, two supports, one guardrail

Carried forward from finding 005's discipline: **headline number + supporting numbers + a quality
guardrail + diagnostic axes — never a single collapsed score.** Style ≠ outcome (the terse,
protocol-disciplined seat did the least work; the chattiest wrote the sharpest code), so no axis is
ever a Member ranking.

| Role         | Metric                    | Pain it maps to               |
| ------------ | ------------------------- | ----------------------------- |
| **Headline** | **wasted-work %**         | clobbered / duplicated effort |
| Support      | interventions-to-done     | attention                     |
| Support      | tokens-to-done            | money                         |
| Guardrail    | acceptance-test pass rate | (quality floor — see below)   |

**Wasted-work %** — share of authored code that never survives to the delivered state, or that
duplicates another actor's work: overlapping hunks across branches, lines authored then overwritten
by a different actor before merge, branches abandoned after supersession, conflict-resolution churn.
Finding 001's ≈37% is the baseline anchor and the reference measurement method.

**interventions-to-done** — count of times the human had to step in (answer a question, break a tie,
un-stick a stalled agent, resolve a conflict by hand). This is finding 005's autonomy axis promoted to
a team-level outcome, and it **absorbs "time saved"**: for a solo builder, time saved _is_ attention
not spent. Wall-clock is reported but never headlined — it is the noisiest metric in agent experiments
(API latency, rate limits, parallelism luck).

**tokens-to-done** — total tokens across all agents to complete the same task. It **internalizes
coordination overhead**: musterd's own coordination traffic is inside this number, so if musterd wins
here it wins _net_ — answering the "but coordination costs tokens too" objection by construction.
Finding 001's 1%-coordination-vs-37%-waste split predicts the win, but this proves it.

**Guardrail, never headline: acceptance-test pass rate.** Each ticket ships with a hidden test suite
the agents never see (they see ticket text; scoring sees tests). This blocks the degenerate strategy
of zeroing wasted work by _doing nothing_ — the gpt failure mode in finding 005. Objective,
judge-free, so the headline experiment needs no LLM judge at all.

## The instrument: the cookoff scenario

**cookoff** is a fixed scenario you run configurations through — same recipe, different kitchens,
judged plates. It is:

- **A bespoke small codebase.** Bespoke matters: it cannot be in any model's training data, or the
  agents solve from memory and the coordination signal vanishes.
- **A backlog of 6–8 tickets engineered to contain coordination traps.** A cleanly decomposable task
  would let the uncoordinated control sail through and show nothing — so the traps are the point.
- **Hidden acceptance test suites**, one per ticket, that define "done" objectively.

### The trap taxonomy (drawn from our own dogfood pain)

The core cookoff uses the first three; the last two are level-2 variants (below).

- **Shared surface** — several tickets all touch the same module (router, schema, config).
  Uncoordinated agents clobber each other or generate merge-conflict churn.
- **Duplicate scope** — two tickets whose wording overlaps ("add input validation to X" / "harden the
  X endpoint") so uncoordinated agents both build the same thing. This is dup-rate bait — exactly what
  Lanes exist to prevent.
- **Hidden dependency** — ticket B silently requires ticket A's output. Uncoordinated, B either
  duplicates A's work or builds against a stale interface.
- **Cross-cutting refactor collision** _(variant)_ — one ticket restructures what the others build on;
  features built on the old structure are dead on arrival. Directly exercises the ADR 111 stale-plan
  machinery. Dramatic, but reads as contrived to a skeptic — secondary.
- **Mid-run spec change** _(variant)_ — the owner amends a requirement halfway. Exercises `steer` /
  `defer`, but has a control-fairness problem (how does the change reach the uncoordinated agents
  equitably?), so it is held as a level-2 variant, not the core.

## The matrix: five cells, two honest controls

The comparison holds everything fixed except the coordination medium and N. A skeptic attacks the
control, so the control is where the credibility lives — we run **two**.

| Cell   | Setup                                            | Role                                    |
| ------ | ------------------------------------------------ | --------------------------------------- |
| **A**  | 1 agent, no musterd                              | single-agent baseline                   |
| **B**  | 1 musterd agent                                  | musterd's single-agent overhead/benefit |
| **C2** | N agents, human-dispatched, then independent     | the **honest incumbent**                |
| **C3** | N agents sharing a `TASKS.md` claim/status board | the **DIY-musterd** control             |
| **D**  | N musterd agents                                 | the product                             |

- **C2 — human-dispatch** is what solo builders actually do today: the human splits the tickets across
  agents up front, then they run independently. It does _not_ dissolve the traps — the duplicate-scope
  pair looks like two different tickets so a human plausibly splits them; the shared surface collides
  regardless of assignment; the hidden dependency bites whoever gets ticket B. The "just assign
  carefully" objection is answered by the fact that careful assignment _is what the human did_, and the
  traps fired anyway. The human's dispatch effort counts as interventions, fairly.
- **C3 — the markdown board** is DIY musterd, and it pre-empts the number-one technical objection:
  _"why wouldn't I just use a shared file?"_ Its failure modes are predictable and each maps to a
  musterd primitive: stale claims nobody clears → Lanes with liveness; no way to interrupt a running
  agent mid-task → `steer` (ADR 111 machinery); write races on the file; zero visibility into who is
  stuck → `seen_latency` / `open_loops`. If musterd beats the markdown board, the objection is dead.
- **C1 laissez-faire** (N agents, full backlog each, "coordinate however you like") is **rejected as a
  strawman** — nobody runs agents this way, so a win against it looks manufactured.

**D beating both C2 and C3 is the complete argument.** One design invariant across every cell: the
**ticket artifact is identical** — the same `TASKS.md` text everywhere; in the musterd cells the
tickets are seeded as Goals/Lanes from that same text. Hold the work constant; vary only the
coordination medium.

## Variable isolation

Model, harness, task, and N all confound the number if left free. So: **same codebase, same tickets,
same model family, same harness (Claude Code)** in all five cells; the only deltas are musterd
present/absent and N=1/N=3. Each cell runs **3–5 times** because single-run agent variance is brutal.

## Measurement is collector-agnostic; git is the reference collector

**wasted-work is defined abstractly** — effort producing artifacts that don't survive to the delivered
state, or that duplicate another actor's artifact — over "workspace snapshots + authorship
attribution." **Git is one collector of that data — the recommended, richest one — chosen by the
benchmark, not required by the value story.** This matters because musterd is designed to work without
git (git is recommended, not mandatory), so the _pitch_ must never say "musterd needs git." It says:
_wasted work is real wherever agents work; here is how we measure it on git; here is the seam for
everything else._

Two constraints fall out:

1. **The metric must be computable from git alone in the control cells.** Cells A and C have no musterd
   telemetry — if wasted-work needed the daemon, the control could not produce it and the comparison
   would die. So the definition is git-derivable (overlapping hunks, pre-merge clobbers, abandoned
   branches, conflict churn), with **actor identity from git attribution, not from musterd** — the same
   trick as ADR 109. Whatever method produced finding 001's 37% is the reference implementation, and it
   doubles as the seed for the parked self-diagnosis tool.
2. **No non-git collector exists today.** Verified in this session: ADR 090's delivery ledger is a
   _message-journey_ read model (logged → seen → answered per directed act) — an excellent collector for
   the _supporting_ metrics in musterd cells (`seen_latency`, `open_loops`, much of interventions), but
   it never sees code artifacts and **cannot** carry wasted-work. A harness-side workspace-snapshot
   collector is the plausible future increment (arguably a batond feature) — **reserved, not designed.**
   interventions and tokens are already git-free.

## One instrument, three experiments

The unifying insight: the cookoff serves all three eval targets by varying **one axis at a time** while
holding the rest fixed.

- **Vary musterd presence / N** (A / B / C2 / C3 / D) → **the sell.** This document's design.
- **Vary model family** in the cell-D config → the **per-model coordination leaderboard**
  (`model-experimentation.md` Track A), straight onto the team + `model.family`-dimensioned metrics
  (#207). Reported as diagnostic profiles, never a single ranking — style ≠ outcome stays load-bearing.
- **Vary harness** in the cell-D config → **harness evaluation.** Attestation coverage (finding 005's
  100% for resident MCP seats vs ≈5% for fire-and-exit CLI) becomes a benchmark row; residency,
  reachability, and whether a `steer` actually lands mid-task all differ by harness.

## Scoring beyond the guardrail

The headline experiment needs no judge — the hidden acceptance tests carry the outcome floor. **Code
quality** stays a _diagnostic_ axis, scored by a rubric-based LLM judge with one constraint borrowed
from our own product: **cross-family judging** — the judge model must be a different family than the
author seat (ADR 101's diversity-flag idea applied to evaluation itself). This holds only until the
fine-tuned coordination-judge exists.

## The flywheel: the experiment produces the dataset

Every flagship run produces labeled coordination transcripts across all five cells — **that is the
coordination-traces dataset** the reserved `coordination-dataset` roadmap item wants, and that the
fine-tuned coordination-judge (ADR 110 Stage 2) is gated on. The sell experiment and the research
ladder feed each other; the dataset is a _byproduct_ of running the cookoff, not a separate build. On
the ADR 056 ladder: **cookoff scenario + runs → coordination-dataset → benchmark + leaderboard → a
`docs/research` finding → judge model** (last).

## The run ladder (mid-tier budget, efficiency-first)

Real money only goes in once the apparatus is proven. Each rung gates the next.

1. **Smoke** — 1 run, cell D only. Does the whole apparatus work: scenario repo, hidden tests, scoring
   script, git archaeology?
2. **Pilot** — A + D, 2 runs each. Is there _any_ signal? If D−A shows nothing dramatic, fix the traps
   before spending more.
3. **Flagship** — A / B / C2 / C3 / D × 3–5 runs, fixed model + harness. The runs that produce the
   published number.

The scenario repo and scoring harness are one-time costs that amortize — they become the Track A /
ADR 052 baseline infrastructure regardless of which axis a later run varies.

## The sell

The publication format is a **`docs/research` finding** — finding 002 ("we pointed our own tool at our
own team and it caught us journaling") is the proven marketing genre, and the flagship number ships the
same way. The headline sentence writes itself once the number exists:

> _Without coordination, three agents redo N% of each other's work. With musterd, that drops to M%._

with the two supports (interventions, tokens), the acceptance-test guardrail, and the **C2 + C3
double-control** as the credibility spine.

## Parked / reserved (do not re-litigate; revisit when triggered)

- **Self-diagnosis funnel** — "run one command on any multi-agent repo → see YOUR wasted-work % →
  musterd is the fix." Benchmark-first won this session; feasibility of measuring wasted work on
  arbitrary repos without musterd is unverified. The cookoff's git-archaeology tool is the natural seed
  if this revives, and it reframes the control as _every prospect's existing repo_.
- **No-git wasted-work collector** — harness-side workspace snapshots; plausibly a batond feature.
  Reserved, not designed. Needed so the value story never hard-couples to git.
- **Level-2 variants** — the refactor-collision and mid-run-spec-change traps (the latter has a
  control-fairness problem to solve first).
- **Phase 2 — competitor comparison** — a cell C4 running CrewAI / the OpenAI Agent SDK. Deferred: it
  changes harness _and_ coordination simultaneously (uninterpretable confound) and makes a different
  claim than "musterd vs. the status quo."

## Open before the smoke run

- Freeze the **wasted-work operational predicates** (dup-hunk threshold, clobber-detection rule,
  abandonment rule); start from finding 001's method.
- Define the **interventions counting protocol** — what exactly counts as a touch, logged uniformly in
  the non-musterd cells (a human run-log discipline).
- Pin the **flagship model + harness version**.

## Related

- [ADR 122](../decisions/122-cookoff-value-experiment.md) (the frozen decision this doc details).
- [`model-experimentation.md`](model-experimentation.md) (Track A leaderboard — the model-axis run),
  ADR 051 (the flywheel's experiment axis), ADR 052 (obs-evals baselines), ADR 056 (the research
  ladder), ADR 082 (the coordination telemetry this measures on), ADR 090 (why the delivery ledger
  can't carry wasted-work), ADR 101 (model as a variable; cross-family judging), ADR 106 (the git
  workflow that defines "merged"), ADR 109 (git-attribution actor identity), ADR 110 (the judge at the
  end of the ladder), ADR 111 (the stale-plan machinery the refactor variant exercises).
- Findings [001](../research/001-telemetry-gaps-p3-dogfood.md) (the 37% anchor),
  [002](../research/002-telemetry-caught-broadcast-journal.md) (the proven finding genre),
  [005](../research/005-multimodel-parallel-work-telemetry.md) (style ≠ outcome; harness attestation
  coverage).
