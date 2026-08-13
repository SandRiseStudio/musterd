# 258 — Shipped goals carry evidence: the value layer

- Status: accepted
- Date: 2026-08-12
- Deciders: nick (directed), stanley (carried)
- Spec: `docs/superpowers/specs/2026-08-12-value-layer-design.md` · plan:
  `docs/superpowers/plans/2026-08-12-value-layer.md`
- Amends: [ADR 256](256-goals-are-the-boards-front-door.md) — the goals front door gains its
  third tier: not just *which* goals exist and *whether* they shipped, but *what shipping them
  changed for a user*. Extends [ADR 084](084-lanes-join-the-plan.md)'s derive-don't-store rule to
  outcomes and review debt.

## Context

The throughput-trap discussion (leaddev.com, DORA 2025: AI adoption raises delivery throughput
while lowering stability) named three different measurements — output, delivery, value — and
musterd's board measured only the first two. `status: shipped` is a delivery fact (lanes all
terminal, ≥ 1 done); nothing on a goal answered "what changed for a user". Meanwhile the review
queue — `awaiting_acceptance`, the constraint the trap says generation moved onto — had no age
anywhere a person or seat could see. And the cheap moment ADR 256 identified for goal-linking
(claim) still required a second `lane_update` round-trip.

## Decision

Everything is **advisory and derived** — no hard gates, no stored goal state, no
daemon-initiated wakes.

1. **Goal outcome is a replayed signal act, never a re-declaration.** A team-visible `message`
   carrying `meta.goal_outcome {goal_id, outcome ≤ 280}`; `listGoals` replays it beside
   `defer`/`steer` (latest wins, pre-declaration notes queue). Derived `Goal.outcome`
   `{text, by, at}` — provenance free, and it **survives wholesale skeleton re-declaration**,
   which is the reason it cannot ride `team_goal_declare`. Surfaces: `team_goal_outcome`,
   `musterd goal outcome`, `POST /goals/outcome`.
2. **The ship nudge lands on the closer.** The lane PATCH close path derives the goal's status
   before and after; a flip to `shipped` appends a `notices` line to the closer's own result
   naming the exact `team_goal_outcome` call. Appended, never blocking, never a wake; a goal that
   ships without an outcome stays visibly outcome-less and is not nagged about twice.
3. **`lane_claim` takes `goal_id`.** The link rides the ownership transition — one call, at the
   moment ADR 256 called cheapest (MCP `lane_claim {goal_id}`, CLI `lane claim --goal`).
4. **`stale_acceptance` makes review debt a board fact.** A lane in `awaiting_acceptance` longer
   than `ACCEPTANCE_STALE_MS` (12 h) warns — `owner: null`, advisory, entry time from the
   `lane.ready_for_review` audit row (fallback `updated_at`; negative waits never emit). The
   brief gains `review_debt`: the 3 oldest waiting lanes, ambient candidate work for any seat
   (`owed_reviews` stays the directed slice).
5. **`FEATURE_EPOCH` 10 → 11.** All fields additive; an older seat reads everything as before.

## Alternatives rejected

- **Outcome via re-declaration** — the skeleton replaces wholesale (`story`/`wave`/`depends_on`
  clear when omitted), so outcome writers would strip fields or be forced to resend them.
- **A stored goals table + `goal_shipped` event waking the declarer** — reverses ADR 084/256's
  derive-don't-store posture and creates daemon-initiated wakes, unpriced (ADR 252).
- **Convention-only outcomes** (a loose `status_update`) — unstructured, unfindable, and grid
  rendering becomes the derived-content heuristic ADR 256 rejected.
- **Directed stale-acceptance nudges (eligible sets) or human escalation** — revisit only if
  advisory proves too quiet; pre-registered check: median `awaiting_acceptance` age after two
  weeks. ADR 217's wait verdict owns escalation semantics.
- **Per-seat throughput metrics** — named anti-goal; rendering one invites optimizing it.

## Observability & Evaluation

- **Traces:** outcome notes are ordinary attributed team messages (`meta.goal_outcome`), so the
  stream is the full history; ship nudges are visible in the closer's lane PATCH response
  (`notices`); `stale_acceptance` warnings ride the board projection; `review_debt` rides the
  brief. No new audit actions — `lane.ready_for_review` (existing) is the time-in-state source.
- **Eval:** dataset = the dogfood ledger, two views. (1) Outcome adoption: fraction of goals
  reaching `shipped` that carry an outcome note within 24 h of the flip; baseline = 0/6 shipped
  goals as of 2026-08-12 (the mechanism did not exist). (2) Review debt: median
  `awaiting_acceptance` age; baseline = to be read from the ledger at first measurement, and the
  pre-registered two-week check (below) decides whether advisory is loud enough.
- **Experiment:** the rejected directed-nudge escalation (eligible sets) is gated on the
  two-week review-debt measurement — if median age does not fall while `stale_acceptance` is
  live, the advisory-only posture is the thing disproven, not tweaked.

## Consequences

- The goals grid can now answer the stranger's third question — *what did this change?* — but
  only if seats write real notes; the ship nudge is the entire adoption mechanism, by design.
  Web rendering of `outcome`, outcome-less shipped goals, and acceptance age is miley's surface.
- `stale_acceptance` will be loud on day one if acceptance latency is genuinely high — that is
  the signal working, same posture as ADR 256's `no_goal` warnings.
- The `stale_acceptance` repair text deliberately names no exact accept/decline call — the
  acceptance ask owns that contract (lesson of #759: `no_goal` shipped prescribing a
  `lane_update` form the tool rejected).
