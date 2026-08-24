# 312 — Shared Seeds start open

- Status: accepted
- Date: 2026-08-24
- Deciders: nick, gptbot
- Narrows: ADR 291 decision 3's unspecified immediate-vagueness behavior

## Context

ADR 291 gives a shared Seed an explicit lifecycle and says a clearly underspecified capture moves
immediately to `needs_clarification`. The implementation plan and ingest tests instead create every
captured Seed as `open`.

The relay is deliberately capture-only. Its payload contains the immutable human text and Slack
attribution, but no classification or clarification question. The daemon likewise has no specified
deterministic rule for deciding that a body is vague.

## Problem

Creating a Seed directly in `needs_clarification` would leave the submitting Member nothing precise
to answer: that state promises one explorer-authored question in the public thread, but no explorer
has claimed the Seed yet. A body-length or keyword heuristic would silently turn arbitrary syntax
into product judgement. Extending the relay to classify ideas would violate its capture-only role.

## Decision

Every accepted relay capture creates an `open` Seed. The daemon performs no semantic classification
of the raw body during ingest.

An agent claims an `open` or `clarified` Seed before spending exploration capacity. If the active
explorer finds one decision-blocking ambiguity, it posts one precise clarification question; that
atomic transition appends the question, clears the explorer, and moves the Seed to
`needs_clarification`. Only this answerable transition creates that state. The submitting Member's
answer moves the Seed to `clarified`, ready for a fresh claim.

## Consequences

- Initial Seed state is deterministic and retry-safe without interpreting human prose.
- `needs_clarification` always has a public question that the submitting Member can answer.
- An agent briefly claims even a visibly vague Seed before asking its first question; no research
  beyond identifying the blocking ambiguity is required.
- A future automatic classifier would require its own decision, typed input/output boundary, and
  evaluation rather than being hidden in ingest.

## Observability & Evaluation

**Traces.** Existing body-free `seed.ingested`, claim, and clarification audit rows distinguish the
capture, ownership, and question transitions. No classifier output or raw text is logged because no
classifier runs.

**Eval.** Measure the fraction of newly opened Seeds that reach clarification, a final brief,
completion, or manual promotion, and the time from claim to a clarification question. Compare with
ADR 248's baseline, where every capture immediately opened a Lane and no clarification state existed.

**Experiment.** Dogfood the first cohort and inspect whether agents repeatedly claim obviously vague
Seeds only to ask a question. If that cost is material, evaluate an explicit classifier in a new ADR.
