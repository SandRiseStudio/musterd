# 138 — Roster posture chip from source (`working` · `idle` · `away` · `offline`)

- Status: accepted
- Date: 2026-07-13
- Supersedes: ADR 137 (client display rename of account_status `active` → `enabled`)
- Related: ADR 044 (availability outranks activity), ADR 073 (governance roster rail), ADR 010 (activity two-clocks)

## Context

The live roster rail (ADR 073) showed each seat's wire `account_status` as a chip. Healthy seats
read `active` (later client-renamed `enabled` in ADR 137), which operators mistook for presence.
Account status answers a different question (seat lifecycle / governance). What operators actually
want on the primary chip is the composed posture: if live — working, idle, or intentionally away;
if not — offline. Presence (the green/grey dot) stays the raw attachment signal.

## Problem

1. Primary chip used the wrong axis (`account_status` vs presence/activity/availability).
2. ADR 137's client synonym (`active`→`enabled`) papered over that without fixing the source.
3. `presence` and `activity` both use `online`/`offline` tokens; the chip needs one composed read
   that also folds explicit availability (ADR 044), without every surface inventing its own mapping.

## Decision

1. **Add optional `posture` on `MemberSummary`** with wire enum
   `working | idle | away | offline`. The daemon always sets it when projecting the roster.
2. **`resolvePosture` lives in `@musterd/protocol`** — pure function from `{ activity, availability }`:
   - `activity === offline` → `offline`
   - availability `away`/`dnd` → `away` (outranks live activity)
   - `activity === working` → `working`
   - else live → `idle` (activity's `online` idle state)
3. **Web roster primary chip renders `posture` verbatim** (fallback: call `resolvePosture` from the
   already-projected activity/availability if talking to a pre-138 daemon). No client synonyms.
4. **Account-status chip = exceptions only** — show `disabled` / `banned` / `archived`; omit
   `provisioned` / `active` (and drop ADR 137's `enabled` label).
5. **Dot stays presence**; reconnecting overlay stays `reclaimable`. Offline *reasons* (signed off vs
   off-hours vs disconnect) remain out of scope for v1.

`presence`, `activity`, and `account_status` are unchanged on the wire.

## Consequences

- Roster chips answer “what kind of present/absent?” from one server field.
- ADR 137's display rename is obsolete — healthy account status no longer paints the primary chip.
- CLI status grouping already matches this order; it can later read `posture` directly (not required
  for this increment).
- Protocol additive MINOR field — old clients ignore `posture`.

## Observability & Evaluation

**Traces** — n/a for projection-only field (no new acts). Roster HTTP/WS payloads gain `posture` on
each member summary for log/debug correlation.

**Eval** — protocol unit tests pin `resolvePosture` order; server roster integration asserts
projected `posture` for offline / online-idle / working / away fixtures. Baseline: ADR 044 CLI
grouping semantics.

**Experiment** — none yet; dogfood on `/live` whether `idle` vs `working` reads clearer than the old
account-status chip.
