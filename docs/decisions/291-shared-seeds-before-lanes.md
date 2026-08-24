# 291 — Shared Seeds before Lanes

- Status: accepted
- Date: 2026-08-19
- Deciders: nick, gptbot
- Supersedes: ADR 248 decision 3, which made every ingested Seed an immediate Lane

## Context

Seeds are short ideas captured while a human is away from a computer, often as only a few words in
Slack. ADR 248 correctly made capture durable, immutable, and observable, but coupled ingest to
opening an unowned Lane. That treats every thought as team work before anyone has established what
the thought means or whether it merits attention.

The capture rail has proved reliable: the Worker records raw Slack input in KV and the daemon can
account for each pull. The missing capability is shared discovery between capture and commitment.

## Problem

A raw Seed needs more context before it becomes a useful Lane. It may be vague, require a question
to its submitting Member, or lead to a well-supported conclusion that no Lane should exist. Making
the Lane the first durable artifact clutters the board, loses the distinction between discovery and
work, and makes an exploratory agent look as though it has committed the Team to implementation.

## Decision

1. **A Seed is a first-class Team record, distinct from a Lane.** The original body, capture time,
   relay id, source, and submitting Member are immutable. Every Member can see a Seed and its
   public clarification thread. The Worker remains capture-only; ingest creates a Seed projection,
   not a Lane.

2. **Slack attribution is minimal and explicit.** A human Member may hold one optional
   `slack_user_id`. A signed Slack delivery whose user id has no matching Member is acknowledged
   without retry but creates no Seed; it records the non-content reason `unknown_submitter` for
   diagnostics. There is no OAuth or general account-linking subsystem.

3. **A Seed has a small, explicit lifecycle.** It is `open`, `exploring`,
   `needs_clarification`, `clarified`, `completed`, or `promoted`. Only one agent may explore a
   Seed at a time. An agent explicitly claims an eligible Seed; no background allocator starts
   exploration. Clearly underspecified Seeds move immediately to `needs_clarification` and spend
   no exploration capacity.

4. **Clarification protects the submitter's intent.** The explorer may ask one minimal,
   decision-blocking question at a time in the public Seed thread. Only the submitting Member may
   answer that clarification. An answer moves the Seed to `clarified`, where any agent may make
   the next exploration claim. A later blocking ambiguity repeats this cycle. Other Members may
   read but may not supply an authoritative clarification.

5. **Exploration produces one exhaustive final brief, not progress chatter.** The brief records
   the sharpened problem framing; Team and code context; external evidence; viable approaches and
   trade-offs; constraints, risks, and unknowns; a recommendation; and the proposed Lane title and
   framing. The Seed body stays unchanged.

6. **The brief has two terminal results.** A viable, decision-ready brief automatically promotes
   the Seed into an ordinary, unowned Lane created from its proposed title and framing. The Lane
   records Seed provenance and recommends a human brainstorm in normal Team activity; it has no
   new gate, special state, or required meeting. A non-actionable brief completes the Seed with its
   conclusion attached and opens no Lane. Any Member may manually promote any Seed, including a
   completed or unexplored one; unexplored promotion notes that research was skipped.

7. **The tray is for active discovery.** Promoted Seeds leave the default tray immediately.
   Completed Seeds leave it after three days. Both remain available in Team history, together with
   their immutable source, thread, brief or conclusion, and any linked Lane.

8. **Promotion is atomic and retry-safe.** Creating the Lane and marking the Seed promoted happen
   in one transaction. Ingest deduplicates by immutable relay id. A failed pull or rejected source
   never advances the ingest cursor. Existing seed-created Lanes remain ordinary historical Lanes;
   there is no speculative backfill from their raw relay records.

## Consequences

- The board receives a Lane only after exhaustive exploration says it is useful, or a Member
  deliberately promotes the raw idea.
- A Team retains a shared, durable record of ideas that were clarified, declined, or later revived.
- The protocol, daemon store and transport, CLI, MCP adapter, and web surface gain a Seed domain;
  this is intentionally larger than a Lane-state addition because the two artifacts have different
  lifecycles and permissions.
- ADR 248's Worker/KV capture, pull cursor, raw-data boundary, and delivery diagnostics stay in
  force. Its immediate-Lane ingest decision is superseded by this ADR.

## Observability & Evaluation

**Traces.** Record non-content audit rows for capture acceptance/rejection, claim/release,
clarification asked/answered, final brief, automatic/manual promotion, completion, and tray expiry.
Link a promotion audit row to both Seed and Lane ids. Never write raw Seed bodies, clarification
bodies, or research bodies to logs, audit details, or telemetry.

**Eval.** The success metric is the percentage of captured Seeds that reach a decision-ready brief
or a completed conclusion before manual Lane creation, plus the fraction of promoted Seed Lanes
that receive a human Act or reach a terminal Lane state. Compare against ADR 248's baseline: every
captured Seed immediately created an unowned Lane and had no Seed-level exploration record.

**Experiment.** Dogfood the first cohort with the immediate-vagueness guard and three-day completed
tray window. Review the audit-derived distribution of clarification, completion, promotion, and
manual-promotion outcomes before changing either threshold.
