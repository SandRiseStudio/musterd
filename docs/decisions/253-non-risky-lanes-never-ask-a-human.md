# 253 — Non-risky lanes never ask a human to accept

- Status: accepted
- Date: 2026-08-12
- Deciders: nick (directed), wanderer (carried)
- Supersedes: [ADR 188](188-graded-review-ladder.md) §2 *for non-risky routing only* — the
  live-human-first rung. Does not touch the grade spectrum, the close-edge check, or risky
  peer-then-human (188 §3–§4 / [ADR 172](172-model-family-posture.md)).
- Amends: [ADR 191](191-review-loop-wake.md) §5 — a tripped review-loop breaker on a
  **non-risky** lane no longer raises a blocking ask to a live human.

## Context

ADR 188 put a live human at the top of the non-risky acceptance ladder: `human` >
`cross_family` > `cross_model`. The aim was to collapse `no_candidate` on a thin roster.
On a one-human dogfood team it did the opposite of what scarce human attention can
afford: every ordinary submit asked nick first, even when a live cross-family agent
existed, and even when the close did not require a human at all.

Self-close on a non-risky lane was already sanctioned and recorded unconfirmed. The
human was not a *requirement*. They were the *first ask*. That is what fired on
wanderer's census lane (`01KZVKF6CW`, PR #750): nick was live, so nick got the ask.

A second hole sat behind the first. ADR 191 §5, on a non-risky lane only, falls through
to `pickHumanReviewer` when the review-loop breaker trips. Risky lanes never enter that
block. So "non-risky never asks a human" has to close both the picker and the breaker,
or the breaker reintroduces the ask the picker just stopped sending.

## Problem

Human attention is the scarce resource ADR 188 §4 already sequenced *away* from on
risky work (peer first, human second). Non-risky work was still spending it first, on
changes that do not require a human verdict. The ladder and the breaker both did this.

## Decision

**Non-risky lanes never route an acceptance ask to a human.** Not first, not last, not
when the review-loop breaker trips. The live pick is the agents-only ladder that risky
stage one already uses: `cross_family` > `cross_model`; `same_model` and ungradeable
never route. A live human on the roster is invisible to this pick.

If nobody eligible is live: wake an enrolled agent when the review loop allows (ADR 191
§2–§4, unchanged — that pick was already agents-only). Otherwise `no_candidate` and
sanctioned self-close, including on a breaker trip. The breaker still stops spending
wakes; it does not substitute a human.

**Risky lanes are unchanged.** Peer first (agents-only). Human second, at blocking,
when the peer's accept lands — or immediately when no peer exists. `pickHumanReviewer`
stays the only function that may choose a human, and only on a lane with a declared
`risk` tag.

## Consequences

- A live human plus a live cross-family agent on a non-risky submit asks the agent.
- A live human and no eligible agent on a non-risky submit asks nobody.
- Voluntary human confirm of a non-risky close still grades `human` at the close edge
  (ADR 188 §3). This ADR changes who is *asked*, not who is *allowed* to confirm.
- ADR 234 stakes exemption is orthogonal: a sampled-in `low` non-risky lane still
  routes, just never to a human.
- The standing-acceptor design session (`docs/design/the-standing-acceptor.md`) is not
  this change. This removes humans from the non-risky pool; it does not dedicate a
  seat.

## Observability & Evaluation

- **Traces.** `lane.ready_for_review` on a non-risky lane must never carry
  `review_grade: human` from the *picker*. A breaker-trip row on a non-risky lane
  carries `breaker_tripped` and `no_candidate`, never a human `reviewer`. Risky
  `human_ask: immediate | gated` rows are unchanged.
- **Eval.** Direct assertion, through-DB and HTTP: (1) live human + live cross-family
  agent → agent; (2) live human alone → `null` / `self_close_sanctioned`; (3) risky
  no-peer still asks the human at blocking; (4) non-risky breaker trip does not ask a
  human. Baseline: the inverted test that previously required "a live human outranks
  every agent grade."
- **Experiment.** None. This is a routing exclusion, not a model-behavior claim.
