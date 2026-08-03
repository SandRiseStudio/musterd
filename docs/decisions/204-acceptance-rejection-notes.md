# 204 — Acceptance rejections retain the concrete note

- Status: accepted
- Date: 2026-08-03
- Builds on: [ADR 192](192-outcome-acceptance.md) (outcome acceptance and frozen audit action),
  [ADR 202](202-the-verdict-moves-the-lane.md) (the acceptance Act moves the named lane), and
  [ADR 200](200-credential-custody-and-the-real-use-gate.md) (credential custody is not a trust
  boundary on a single-user machine).

## Context

ADR 202 made a replied-to `accept` or `decline` Act move the lane it names through
`meta.lane_review`. The server already emitted `lane.review_sent_back` for a decline, but its audit
detail contained only the reviewer and owner. The concrete reason lived, at best, in the append-only
message body or in the lane's mutable `detail` field.

## Problem

An acceptance record that says only who sent work back cannot answer the operational question the
acceptor was asked to answer: what must change before the outcome is acceptable? Relying on mutable
lane detail also conflates the current work description with the frozen review verdict.

## Decision

When a `decline` answers a real `lane_review` ask, copy the trimmed Act body into the existing
`lane.review_sent_back` audit detail as `note`, bounded to 500 characters. Keep the audit action,
lane state transition, and wire schema unchanged. Empty notes remain representable for compatibility
with existing board-originated send-backs; CLI/MCP surfaces should provide the concrete note asked
for by ADR 192.

The acceptance owner case remains structural rather than guarded: the shared close derivation marks
an owner answering their own lane `verified: false`. ADR 202's explicit lane target and synchronous
state check prevent an ambiguous or stale acceptance from moving an unintended lane; ADR 200 keeps
the remaining credential-custody limitation explicit.

## Consequences

- Review send-backs are actionable from the audit stream without replaying message bodies.
- Existing consumers of `lane.review_sent_back` and protocol clients remain compatible.
- A note is bounded and may be absent for legacy or board-originated send-backs; absence is not
  upgraded into a claim that no reason existed.

## Observability & Evaluation

- **Traces.** No new action or span. Existing `lane.review_sent_back` rows gain an optional bounded
  `detail.note`; the originating `decline` Act remains the full source message.
- **Eval.** Baseline: send-back audit rows recorded reviewer/owner but no concrete reason. Success:
  every new chat decline with a non-empty body has the same bounded note in its corresponding audit
  row, while the frozen action count remains unchanged.
- **Experiment.** n/a — this is durable-record completion, not a tunable behavior.
