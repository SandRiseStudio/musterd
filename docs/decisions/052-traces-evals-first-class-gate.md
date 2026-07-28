# 052 — Traces & evals as definition-of-done: the first-class gate

- Status: accepted
- Date: 2026-06-24 (gate built 2026-06-26)

## Context

The 2026-06-24 flywheel decision (ADR 051) sets the strategy: musterd emits coordination-native traces;
batond runs the eval/experiment engine. A strategy only becomes real if every new agent-facing feature
_ships_ with its traces and evals, the way it already ships with tests and updated docs (the definition
of done, `07-conventions.md`). Otherwise telemetry is retrofitted later, which observability.md §1
explicitly calls out as always worse.

musterd already enforces structural discipline mechanically: `pnpm format:check` runs Prettier +
`roadmap:check` (ADR 041) + `arch-trees:check` (ADR 043, a _checker not generator_ so each entry carries
a curated description). This is the muscle to reuse for a traces/evals gate.

## Problem

Make "traces + an eval" a first-class deliverable of every agent-facing feature — alongside code and
docs — cheaply, this week, without a platform and without cargo-culted evals written just to pass.

## Decision

- **ADR template gains an "Observability & Evaluation" section.** Every ADR for an agent-facing
  feature must answer:
  - **Traces** — what spans/events does this emit (coordination acts + agent-turn detail per ADR 051)?
  - **Eval** — what is its success metric, against what **dataset** and **baseline**? (An eval with no
    baseline is theater — the baseline requirement is the anti-cargo-cult guard.)
  - **Experiment** — what experiment would validate it (may be "none yet", but named)?
    Non-agent-facing or purely mechanical ADRs may write "n/a — <reason>".
- **Definition of done gains a clause:** an agent-facing change is done only when its emitted traces and
  its eval (or an explicit, reasoned `n/a`) are present and described in the same commit — peer to the
  existing tests/docs clauses.
- **A `format:check` guard enforces it (to build this week).** Add an `obs-evals:check` step to
  `pnpm format:check`, modeled on `check-arch-trees.ts`: a **checker, not a generator** — it fails an
  agent-facing ADR that lacks a non-empty "Observability & Evaluation" section (or an explicit `n/a`
  with a reason). It enforces _presence and shape_, leaving the content hand-authored, exactly as the
  arch-tree checker enforces the file set but not the descriptions.

## Consequences

- Cheap and compounding: from now on, features built through Waves 1–3 carry traces + evals by default,
  so batond's engine (ADR 051) has real data to consume when it lands — no retrofit.
- Reuses an existing, trusted mechanism (`format:check` + the ADR 043 checker pattern); low new surface.
- **Now built (2026-06-26):** the ADR template section (`07-conventions.md`), the DoD clause, and the
  `obs-evals:check` guard (`scripts/check-obs-evals.ts`, wired into `pnpm format:check`) all landed.
  The checker mirrors `check-arch-trees.ts`: it enforces _presence and shape_ (the section exists and
  answers Traces / Eval / Experiment, or is an explicit `n/a — <reason>`), never content.
- **Grandfathering (pragmatic):** the gate enforces from **ADR 060 onward**. ADRs 001–059 predate it and
  are exempt — 052 is the gate itself and 056 already carries the section voluntarily; the rest are
  pre-gate history we do not retrofit. The DoD clause in `07-conventions.md` still asks every agent-facing
  change for the section regardless of number, so the practice runs ahead of the mechanical cutoff.
- Risk — gaming via empty/`n/a` sections — is bounded by the baseline-and-reason requirements and normal
  review; the gate guarantees the _question is asked_, not that the answer is good.
- Implements the day-to-day discipline ADR 051 depends on. Composes with ADR 041/043 (the checker
  family) and `07-conventions.md` (template + DoD).

### Amendment 2026-07-28 — a dataset nobody can read is not a dataset

The gate enforces that an eval **names** a dataset. It never asked whether the people expected to
compute the eval can **reach** it, and that gap has been quietly load-bearing.

Found while computing ADR 169's review metrics from an agent seat: `musterd audit` answers
`this resource is admin-only (visibility_level: admin)`. The metrics were defined over `lane.closed`
/ `lane.ready_for_review` / `lane.review_sent_back` audit rows, so the seat expected to analyse them
could not read them. The two data points that eventually got computed were reconstructed from lane
events that happened to cross that seat's inbox while it was online — obtainable only by having been
in the room, which is not an instrument.

**Measured across the corpus (2026-07-28):** of the 112 gated ADRs, **14 name the audit log as their
eval dataset** — 092, 108, 109, 115, 120, 146, 147, 148, 149, 150, 153, 155, 163, 169 — and a further
35 reference it incidentally. None of them note that computing the eval requires an admin credential.
So roughly one in eight evals this gate has collected is, in practice, computable by exactly one
person on the machine.

**The rule this adds:** an obs-evals section that names a dataset must also make the **access path**
answerable — either the dataset is readable by the seats expected to analyse it, or the section says
plainly that the eval requires an admin (or human) run. Naming an unreachable dataset satisfies the
letter of this ADR while defeating its purpose, which is that evals actually get computed.

Deliberately **not** enforced by the checker yet. A mechanical rule would fail 14 existing ADRs on
the next CI run, and retrofitting them is a decision for the team rather than a side effect of
writing this paragraph. The rule stands as review guidance until someone decides whether the backlog
gets an amnesty (like the ADR 060 grandfathering above) or a sweep.

**And the fix for the audit case specifically is a projection, not a permission change.** Widening
`GET /audit` would trade a documentation problem for a governance one: that log carries claim
refusals, grant issue/revoke, key rotation, policy changes. The eval-relevant _counts_ leak none of
that and belong in `musterd report`, which is already the non-admin insight surface (ADR 090/091 put
delivery and MAST views there). Same shape as ADR 168's conclusion about hooks: add the narrow
reader, do not loosen the broad one.

## Observability & Evaluation

n/a as an agent-facing feature — this is a build-time documentation gate, not a runtime act, so it emits
no coordination traces. Its own success is measurable, though: the **eval** is the share of in-scope ADRs
(≥ 060) that carry a non-cargo-culted section — metric is reviewer-judged section quality, **dataset** is
the ADR corpus, **baseline** is the pre-gate state (only 056 carried it voluntarily). The **experiment**
worth running once batond exists: do features whose ADR named a real eval actually ship measurably better
coordination outcomes than those that wrote `n/a` — i.e. does the gate change results, not just paperwork?
