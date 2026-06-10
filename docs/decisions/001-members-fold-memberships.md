# 001 — members table folds memberships

- Status: accepted
- Date: 2026-06-09

## Context

The original plan sketch listed a separate `memberships` join table alongside `teams` and `members`, implying a Member could belong to multiple Teams (a many-to-many relationship).

## Problem

In v1, a Member belongs to exactly one Team, and `SPEC.md` §1 defines a Member as "a durable identity within exactly one Team". A separate `memberships` table would add a join with no v1 use, and would let the schema express states (a Member in zero or many Teams) the protocol forbids.

## Decision

Fold membership into the `members` row: `members.team_id` (FK) expresses the single membership, and `members.left_at` expresses departure. No `memberships` table in v1. Member uniqueness is `(team_id, name)`, so the same name can exist as distinct Members in different Teams.

## Consequences

- Simpler queries; one fewer table; the schema can't represent illegal multi-Team membership.
- Cross-Team identity (one human/agent recognized across Teams) is a roadmap concern. If/when needed, split `memberships` out behind its own ADR — this will be an additive migration, not a rewrite, because today's `members.team_id` maps cleanly to a first membership row.
- `01-data-model.md` documents this folding; this ADR is the rationale of record.
