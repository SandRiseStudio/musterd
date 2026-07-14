# 137 — Roster `account_status: active` chip reads `enabled`

- Status: accepted
- Date: 2026-07-13
- Supersedes: display label only of ADR 073 §1 (`active` quiet pill text)

## Context

ADR 073 surfaces each seat's wire `account_status` on the live roster rail. The healthy norm
`active` renders as a quiet pill whose label was the wire token itself — `active`. Presence is a
separate signal (the green/grey dot). Operators reading the rail routinely mistook the quiet
`active` chip for "online," especially on offline seats that still show grey dots.

## Problem

The display label `active` collides with everyday presence language. Hiding the quiet chip would
also work, but then the rail loses a consistent account-status column (exceptions like
`provisioned` would appear alone). The protocol enum must stay `active` (ADR 070 / SPEC) — other
surfaces and seat-files depend on it.

## Decision

In `accountStatusMeta` (web live roster only), map wire `account_status: "active"` → display label
**`enabled`**. Keep tone/`quiet` unchanged. Exception statuses (`provisioned` / `disabled` /
`banned` / `archived`) and `unknown` keep their wire-token labels. The hover title continues to
expose the wire value (`Account status: active`).

No protocol, CLI, or seat-file change.

## Consequences

- Offline seats with claimed accounts read `enabled` + grey dot — account vs presence no longer
  share a word.
- ADR 073's quiet-norm rule still holds; only the human-facing string for the norm changes.
- Docs that narrate the pill text should say `enabled` (display) while referring to wire
  `account_status: "active"`.

## Observability & Evaluation

n/a — presentational label only; no new spans, acts, or agent-facing behavior.
