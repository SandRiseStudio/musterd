# 105 — The clobber guard honors the reclaim-grace window (amends ADR 066)

- Status: accepted
- Date: 2026-07-07

## Context

The [ADR 066](066-claim-clobber-guard.md) clobber guard (`liveBindingClobber`,
`packages/cli/src/onboard/guard.ts`) refuses to repoint a folder's binding to a *different* seat when the
bound seat is **live** — pointing the operator at `musterd agent` (isolated workspace) or `--force`. It
is client-side and roster-driven: it trusts the roster's `presence`/`activity` verdict, and its whole
notion of "live" is *"not `offline`"* (ADR 066: fire on **liveness**, not on the mere binding).

[ADR 010](010-single-active-grace.md) gives a cleanly-disconnected seat a **45s reclaim grace**: its
presence row is *held* (`held_until = now + grace`, `conn_id` cleared) so the *same* member can reconnect
without losing the seat. ADR 010 deliberately **hides held rows from the roster** (`listPresence` /
`hasLivePresence` filter `held_until IS NULL`) so a member reads `offline` the instant its connection
drops — a rendering choice made for *same-identity* reclaim.

The seam (issue #153): the clobber guard is a **different-identity** check reading that same
same-identity-tuned display. A seat held within its grace projects as fully `offline`
(`presences: []`, `activity: offline`) — byte-identical to a reaped seat — so the guard treats it as a
stale seat safe to clobber. **A momentarily-disconnected agent (Cursor reload, network blip) can have
its folder repointed to a different seat within 45s** — the exact "two sessions, one working tree"
collision ADR 066 exists to prevent, and the reload-orphan class of failure ADR 017 was born from.
Verified by probe: a seat reads `online` at t+0 and `offline` (held) by t+50ms after its session's WS
closes. ADR 066 and ADR 010 were designed independently; this is their unexamined intersection.

ADR 010 itself frames a held row as *"the member's **reservation** … reclaimable, not occupied"* and
even carries a deferred note to "include held rows in activity resolution." This ADR does a **scoped**
version of that — for the guard, not for display.

## Decision

**A seat held within its reclaim-grace window counts as occupied for the folder clobber guard.** A
different-identity `claim`/`init` into that folder is refused (exit 2) with the same `--force` /
`musterd agent` escapes as a live seat — a reservation that may be reconnecting is not a vacancy.

Implemented as a small **additive roster projection field**, keeping the guard client-side, pure, and
unit-testable (ADR 066's stated design) — it just gets a truthful input:

1. **Protocol** — `MemberSummary` gains an optional `reclaimable: boolean` (`packages/protocol/src/member.ts`).
   Additive and back-compatible; the server always sets it; **no `PROTOCOL_VERSION` bump** (already
   `musterd/0.3`) — the same shape as `activity` / `account_status` / `capabilities`.
2. **Server** — `listReclaimableMemberIds(db, teamId, now)`
   (`packages/server/src/store/presence.ts`) returns the team's members with a hold still in the future
   (`held_until IS NOT NULL AND held_until > now`) — the one *positive* read of held rows in the store.
   `summarize` (`packages/server/src/transport/http.ts`) sets `reclaimable` per member from that set.
3. **Guard** — `liveBindingClobber` treats `m.reclaimable === true` as occupied even while
   `presence`/`activity` read `offline`, and reports it so `claim` words the refusal for the grace case.

**Orthogonal to display.** The seat still reads `offline` on the roster/UI — ADR 010's separate
(still-deferred) reconnect-flicker fix is untouched. `reclaimable` is a distinct signal for the guard.

## Consequences

- The reload/blip clobber race is closed: a folder bound to a seat that dropped <45s ago is protected
  from a different-identity claim, consistent with ADR 010 treating the held row as a reservation.
- **Trade-off:** a *different* actor's `claim <name>` within 45s of a **clean** disconnect now
  blocks-with-`--force` where it previously silently succeeded. This narrows ADR 066's frictionless
  stale-reclaim path for a 45s window; `--force` and the recommended `musterd agent` (fresh worktree)
  remain the escapes. After grace expires (the reaper frees the hold) the folder is freely reclaimable
  again.
- Fixes every roster consumer of the guard uniformly (`musterd claim`, the `init` reactivate path).
  `musterd agent` already sidesteps clobbers by writing into a fresh worktree, so it is unaffected.
- One additive optional field; older clients ignore it and behave exactly as before.

## Observability & Evaluation

**Traces** — n/a for first-party OTel spans: the guard is a **local provisioning command** that emits no
coordination acts (ADR 066 Observability), and `reclaimable` is a pure roster **projection** derived from
existing `presence` rows — no new act, event, or span. The refusal surfaces as the CLI's exit-2 error,
and the audit trail for the *seat* side (hold/reclaim) already lives in presence events.

**Eval** — the metric this moves: **clobber-during-grace incidents** — a folder binding repointed to a
different seat while the incumbent was within its 45s reclaim grace (the drift #153 describes). *Dataset:*
reproducible from the binding + presence history; before this change the count is unbounded (silent), and
the target after is **zero** without `--force`. Guard against over-blocking: the rate of `--force`
overrides on a `reclaimable` refusal — if operators routinely force past it, the 45s window is too eager.

**Experiment** — the built-in reproduction (also the integration test): occupy a seat holding an open
session, drop the session so it enters grace, then run a *different* seat's `claim` in that folder within
45s. Before: silent clobber (binding repointed). After: refused (exit 2) unless `--force`, and freely
clobberable again once grace expires.
