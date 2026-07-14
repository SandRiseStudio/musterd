# 141 — Offline reason on the roster (`reconnecting` · `disconnected` · `signed_off` · `off_hours`)

- Status: accepted
- Date: 2026-07-13
- Related: ADR 010 (reclaim grace), ADR 044 (availability), ADR 138 (posture)

## Context

Posture v1 (ADR 138) collapses all non-live seats to `offline`. Operators want *why*: signed off,
outside hours, or dropped connection. Fragments already exist (`reclaimable`, availability) but are
not one composed roster field.

## Problem

Without a durable “how did this seat go dark?” fact, the UI can only invent reasons. Inferring
off-hours without schedule enforcement would lie. Inferring signed-off vs disconnect without a leave
vs drop distinction would also lie.

## Decision

1. **Add optional `offline_reason` on `MemberSummary`:**
   `reconnecting | disconnected | signed_off | off_hours | unknown`.
2. **`resolveOfflineReason` in `@musterd/protocol`** (pure), order:
   - live → `null` (omit on wire / callers skip)
   - `reclaimable` → `reconnecting`
   - availability `off_hours` → `off_hours`
   - sticky `members.last_offline_reason` when set → that value (`disconnected` | `signed_off`)
   - else → `unknown`
3. **Persist sticky reason (schema v20):** `members.last_offline_reason TEXT` nullable.
   - Socket/session end via `release()` (grace hold) → write `disconnected` (reclaimable still wins
     display during grace).
   - Explicit seat release (`unbind` / soft-remove / clear that means “I’m done”) → write
     `signed_off`.
   - Cleared on next live attach / ambient flip to present.
4. **Add `off_hours` to `AvailabilityStatusSchema`** (SPEC A.6 already names it; still
   self-set only — no schedule enforcement in this ADR).
5. **Web chip:** when posture is `offline`, render `offline_reason` when not `unknown`; otherwise
   `offline`. Keep the separate “reconnecting” line only if we want redundancy — prefer one chip
   from `offline_reason` and drop the duplicate recon text when reason is `reconnecting`.

Out of scope: schedule *enforcement* that auto-sets `off_hours`; finer drop vs heartbeat-timeout
subtypes (both → `disconnected`).

## Consequences

- Offline chips gain honest words without client synonyms.
- `unknown` is expected for provisioned seats that never connected.
- CLI/MCP can adopt the field later; this increment projects it and uses it on `/live`.

## Observability & Evaluation

**Traces** — n/a (projection).  
**Eval** — unit tests for `resolveOfflineReason` order; server tests that `release` stamps
`disconnected` and reclaimable seats project `reconnecting`.  
**Experiment** — dogfood whether `disconnected` vs `signed_off` is set often enough to matter
(most WS closes today go through `release` → `disconnected`).
