# 314 — Correlated models make correlated mistakes: the diversity charter

- Status: accepted (2026-08-24, nick)
- Date: 2026-08-24
- Lane: `01M0TXHHZTSRABBYYAS6B5AE2K`
- Relates to: [ADR 056](056-research-as-first-class-practice.md) (the research practice this
  charter was mis-filed under), [ADR 101](101-model-as-a-variable.md) (the diversity flag),
  [ADR 158](158-model-attestation-truth.md) (observed-over-declared),
  [ADR 169](169-two-stage-close.md) (the cross-family picker),
  [ADR 172](172-model-family-posture.md) (the family boundary),
  [ADR 187](187-durable-model-attestation.md) (live-only grading),
  [ADR 188](188-graded-review-ladder.md) (the grade ordering)

## Context

Eleven documents — ADRs 158, 163, 169, 172, 187, 229, 246, plus `landscape.md`,
`model-attestation-truth.md`, `the-standing-acceptor.md`, and ADR 101 before them all — cite
"ADR 056 diversity conclusions" and "correlated models make correlated mistakes" as an
established decision. The ADR 056 acceptance audit (lane `01M091HZWA`, 2026-08-24) found that
ADR 056 contains zero occurrences of "diversity" or "correlated"; three of the citations linked
to files that never existed (`056-correlated-failure.md`, `056-evaluation-framework.md`,
`../design/musterd-evaluation.md`). The thesis is real, load-bearing, and stated by nothing.
This ADR states it.

The prose that comes closest to a source is `agent-ontology.md` §5 (the monoculture problem),
which is a design capture, not a decision.

## Decision

Four claims, adopted as the standing basis for the machinery that already consumes them.

### 1. Same-model consensus is weak evidence

Agents running the same model share training data, blind spots, and self-preference, so their
judgments are **correlated**: they agree and disagree for shared reasons, not independent ones.
N same-model approvals count as much less than N independent approvals. Decorrelators, ranked
(`agent-ontology.md` §5): different evidence/context (strongest), different models (the only fix
for shared blind spots), different stance/role prompts (weakest, insufficient alone).

### 2. The family is the correlation boundary

Model **family** (the ADR 172 map) is the adopted unit of correlation: same-family models are
presumed correlated, cross-family presumed less so, **until the correlation research measures
otherwise**. This is a presumption chosen for its failure mode — treating correlated judges as
independent silently inflates evidence; treating independent judges as correlated merely costs a
routing hop.

### 3. A false diversity claim is worse than none

A chain flagged "diverse" on a lied-about, stale, or inferred model converts weak evidence into
fabricated strong evidence — the reader stops discounting exactly when they should discount most.
Hence the attestation posture this thesis imposes downstream: observed-over-declared (ADR 158),
attribution at the tool boundary (ADR 163), grading only what runs now (ADR 187), the CLI
attesting only what the harness observed (ADR 246), and "diversity **unverifiable**", never
"diverse", for any chain with an unattested link (ADR 101).

### 4. Diversity-for-research and independence-for-acceptance are different requirements

The standing-acceptor capture's objection is recorded here as part of the charter, not glossed:
research validity wants **diversity** (uncorrelated samples, so conclusions generalize);
acceptance wants an **independent judge** (someone whose incentives and blind spots differ from
the author's). Cross-family routing serves the second with an instrument built for the first —
a *proxy* for independence, not a definition of it. Evidence-based disagreement (decorrelator 1)
can make a same-family acceptor more independent than a cross-family one that read nothing. The
graded ladder (ADR 188) stays as-is under this charter; any future acceptance redesign argues
against *this* section, not against a research citation.

## What this is not

- **Not a measured result.** The supporting evidence is the field's (MAST, the monoculture
  literature) plus one small-N in-house anecdote (the P3 dogfood, where model mattered more than
  seat). In musterd's own data the thesis is a presumption awaiting the correlation experiment.
- **Not a claim that cross-family review catches more defects.** It claims same-family agreement
  is weaker *evidence*, which is a statement about how to count approvals, not about defect yield.
- **Not retro-written into ADR 056.** ADR 056 charters the research *practice*; this ADR charters
  the *thesis* that practice is meant to test. The 11 citing documents repoint here.

## Falsifiers

- **The correlation experiment (the ADR 056 research track's first duty to this charter):**
  measure agreement rates of same-family vs cross-family reviewer pairs on attested review
  episodes (the labeled sample ADR 169 already accumulates). If same-family agreement is not
  materially higher than cross-family agreement, claim 1 falls at the family boundary, and with
  it the diversity flag's premise (ADR 101) and the `cross_family > cross_model` ordering
  (ADR 188). Claim 3 survives regardless — it is about honesty of the flag, not its premise.
- **The family map itself (claim 2):** if measured correlation clusters do not track the ADR 172
  family boundaries (e.g. two families sharing a data lineage agree like siblings), the boundary
  moves to what was measured; the presumption structure stays.

## Consequences

- The 11 documents' "ADR 056 diversity conclusions" parentheticals repoint to this ADR (done in
  the same change). References to the diversity *research* — the dataset, the experiment, the
  labeled sample — stay on ADR 056, which remains the practice that will test this charter.
- The three formerly-broken links repointed to 056 as a stopgap in the ADR 056 acceptance PR
  (#1033) now have their intended target.
- No behavior changes. The diversity flag, the picker, the ladder, and the attestation stack are
  already built on these claims; this ADR gives them a citable source and a falsifier.

## Observability & Evaluation

n/a as a shippable feature. The eval **is** the falsifier above: the same-family vs cross-family
agreement-correlation measurement, run under the ADR 056 practice on the attested review corpus.
Until it runs, every consumer of this charter is consuming a dated presumption, and says so by
citing this ADR rather than a "conclusion".
