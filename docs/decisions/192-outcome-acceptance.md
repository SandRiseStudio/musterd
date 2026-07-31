# 192 — Outcome acceptance: the two-stage close is not a code review

- Status: accepted
- Date: 2026-07-31
- Supersedes: [ADR 169](169-two-stage-close.md) *vocabulary and counterpart-job framing* (mechanics
  of the two-stage close, soft gate, and cross-family/graded routing remain; this ADR renames what
  agents are taught and defines what the counterpart actually judges)
- Clarifies: [ADR 145](145-human-role-refounded.md) §6, [ADR 188](188-graded-review-ladder.md)
  (routing ladder stays; “review” means outcome acceptance)
- Spec: [2026-07-31-outcome-acceptance-design](../superpowers/specs/2026-07-31-outcome-acceptance-design.md)

## Context

ADR 169 split `lane_resolve` into a worker claim (“technically complete”) and a counterpart claim
(“this is what we wanted”). It named the stage `ready_for_review` and the ask “review requested.”
That vocabulary maps, in every engineer’s head, to **read the diff before merge**.

What shipped was different: CI lands the PR; the counterpart co-signs the *lane close* afterward.
Seventeen early episodes closed without a real counterpart act (ADR 188’s table). The ask body
only said “confirm or send back” — no checklist for intent, usability, principles, or feel.

The naming taught the wrong job. Agents skipped `lane_ready`, auto-merged, and self-resolved —
exactly the unverified-close pattern the two-stage close was meant to make visible.

## Problem

1. **“Review” means code review** → agents expect pre-merge gates; the product does post-merge
   co-sign → they skip the stage.
2. **Substance is missing** → even when an ask is routed, the acceptor has no brief for what to
   judge beyond a binary confirm.
3. **Immutable audit strings** are load-bearing for insights — renaming them would zero metrics
   and break close-edge lookups (ADR 173 / 188 posture: do not rewrite history).

## Decision

### 1. The counterpart job is outcome acceptance

Judge the **landed outcome** against the lane brief and shipped artifact:

- **Intent** — matches title/detail?
- **Principles** — project/musterd hard rules?
- **Usable** — exercise the path enough to say it works?
- **Feel** — when UI/copy/brand is in surface; else N/A
- **Reject** — concrete note, not style nits

Not a diff review. Not a CI substitute. Musterd still runs no verifiers.

### 2. Timing stays post-merge

CI + auto-merge remain the technical land path. Acceptance is a board/audit claim on the close.
Risky lanes keep ADR 188 peer-then-human acceptance (still post-merge). This ADR does **not**
add required GitHub reviews or block squash on acceptance.

### 3. Agent-facing vocabulary

| Today | Canonical |
| --- | --- |
| `ready_for_review` | `awaiting_acceptance` |
| `lane_ready` / `musterd lane ready` | `lane_submit` / `musterd lane submit` |
| reviewer / confirm / send back | acceptor / accept / reject |
| verified / unverified (UI copy) | accepted / unconfirmed |

**Wire compat:** `LaneStateSchema` dual-accepts `ready_for_review` and `awaiting_acceptance`
during fleet skew; new writes use `awaiting_acceptance`; a one-shot migration rewrites live rows.
`lane_ready` / `lane ready` remain deprecated aliases. Wire field `verified: boolean` stays;
UI copy changes.

### 4. Audit action strings stay frozen

`lane.ready_for_review`, `lane.review_sent_back`, `lane.review_peer_confirmed` remain the
permanent query keys. New emits keep those action names. Meta key `lane_review` stays for
in-flight asks; ask **body** copy becomes acceptance + checklist.

### 5. Ask body carries the checklist

On enter `awaiting_acceptance`, the daemon composes the ordinary `ask` (species `approve`, tier
per ADR 188) with a body that names acceptance and the checklist dimensions. Stage-two risky
human asks get the same framing plus peer findings.

## Consequences

- Agents are taught: merge → `lane_submit` → wait for acceptor → self-resolve only on silence
  (unconfirmed). Auto-merge is correct; skipping submit is the anti-pattern.
- Board column / chips / verbs follow the new words (“Awaiting acceptance”, accept/reject,
  accepted/unconfirmed).
- Historical ADR 169/188 text is not rewritten; this ADR is the vocabulary source of truth going
  forward. Living docs (architecture, AGENTS, skill) update in the same change set.
- Protocol state addition is ADR-gated (this ADR).

## Observability & Evaluation

- **Traces.** Same audit actions as ADR 169/188; ask body change is visible in message text.
  Board/UI copy is not a new span.
- **Eval.** Unconfirmed-close rate and acceptance-catch rate (send-backs / routed asks) keep the
  ADR 169 baselines; the hypothesis is that clearer vocabulary + checklist raises routed asks
  *and* send-back rate above rubber-stamp zero once a counterpart exists.
- **Experiment.** First week after deploy: fraction of closes that used `lane_submit` /
  `awaiting_acceptance` vs direct `lane_resolve`; spot-check ask bodies contain the checklist.
