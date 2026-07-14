# 140 — Activity wire rename: `online` → `idle`

- Status: accepted
- Date: 2026-07-13
- Related: ADR 010 (two-clocks), ADR 138 (roster posture)

## Context

Roster activity (v0.2) uses `offline | online | working`. The middle value means “present, no
self-reported task” — i.e. **idle** — but shares the token `online` with presence status
(`online | away | offline`). ADR 138’s posture chip already displays that state as `idle`, papering
over the collision without fixing the substrate.

## Problem

`activity: online` and `presence: online` mean different things. Operators and code both trip on it.
Posture’s `idle` is the right word; activity should match.

## Decision

1. Rename the activity enum value **`online` → `idle`** in `@musterd/protocol`
   (`ACTIVITIES = ['offline', 'idle', 'working']`).
2. `resolveActivity` returns `idle` for live + no status_update.
3. Update all in-repo consumers (server tests, CLI fixtures, MCP fallbacks, web office types,
   `resolvePosture` / `memberPosture` fallbacks).
4. Hard cut on localhost dogfood — activity is server-projected only; no client sends it. No dual
   wire spellings.

Presence status stays `online | away | offline` (attachment). Posture stays
`working | idle | away | offline` (composed chip).

## Consequences

- Vocabulary aligns: activity `idle` ≡ posture `idle` ≡ “live, not working.”
- Docs that say activity `online` (idle) are updated in the same change.
- External/old readers that assumed `activity === 'online'` break — acceptable for pre-1.0;
  SPEC appendix language updated to match.

## Observability & Evaluation

n/a — rename of an existing projected field; tests pin `resolveActivity` → `idle` and roster
integration expectations.
