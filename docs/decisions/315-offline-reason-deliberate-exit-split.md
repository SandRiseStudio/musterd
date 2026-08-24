# 315 — `signed_off` splits into the exits it conflated (`left_team` · `seat_released` · `session_ended`)

- Status: accepted
- Date: 2026-08-24
- Related: ADR 141 (offline reason — amended here), ADR 019 (soft-remove), ADR 058 (self-unbind),
  ADR 131 §5 (resumable attestation), ADR 148 (feature-epoch `behind` hint), ADR 232 (per-row
  roster tolerance)
- Spec: docs/superpowers/specs/2026-08-19-presence-honesty-design.md §2.3 (rollout lane 1)

## Context

ADR 141 gave the roster a durable "how did this seat go dark?" fact with two sticky stamps:
`disconnected` (presence ended without a goodbye) and `signed_off` (everything deliberate). Its own
Experiment note anticipated the problem: most WS closes go through `release()` → `disconnected`, so
in practice a normally-finished agent session wears crash clothing, and the deliberate exits that
do get stamped are indistinguishable from each other — leaving the team is not releasing a seat is
not finishing a session.

## Decision

1. **Split the sticky vocabulary.** `offline_reason` gains `left_team`, `seat_released`,
   `session_ended`. Stamping:
   - `left_team` — `leaveMember` (admin soft-remove, seat-file reconcile tombstone).
   - `seat_released` — explicit self-unbind (`markSeatReleased`, the old `markSignedOff`).
   - `session_ended` — clean session exit: `POST /residency/session` with `event: 'end'` (the
     SessionEnd hook already sends it) now stamps the sticky reason. This is a deliberate carve-out
     from that route's presence-neutrality: only the member stamp moves, no presence row.
   - `disconnected` — unchanged, and now the only alarming flavor: presence ended with no goodbye.
2. **`signed_off` is legacy.** Accepted on read, never newly stamped; `resolveOfflineReason`
   normalizes it to `seat_released`, and an old row reaching an old web bundle still renders.
3. **A said goodbye survives the socket close.** `release()` stamps `disconnected` only into an
   empty slot (`last_offline_reason IS NULL`, i.e. cleared by attach). Without this, the WS close
   that follows every clean exit would overwrite `session_ended` moments after it was stamped.
4. **Feature epoch 12.** New wire tokens on an existing enum — exactly the ADR 232 shape; the web
   roster's per-row tolerant parse drops what an old bundle cannot read, and the `behind` chip is
   the cue.

No schema migration: `members.last_offline_reason` is free TEXT (v20).

## Known gap (follow-up, not in this change)

A deliberate MCP `team_leave` closes the WS without a goodbye and still stamps `disconnected` —
the client has no HTTP path and the wire has no `bye` frame. Fixing that is a protocol-frame
decision and gets its own change; until then a leave-then-exit reads `disconnected` unless the
harness's SessionEnd hook fires after it.

## Observability & Evaluation

- Traces: the sticky stamp is visible per member (`members.last_offline_reason`) and on the wire
  (`offline_reason`); `residency.session_ended` audit rows mark the goodbye that produced a
  `session_ended` stamp, so a stamp with no matching row is a bug's fingerprint.
- Eval: the ADR 141 dogfood question re-asked with the split in place — dataset: the roster's
  offline members over a normal week; baseline: today, where nearly every offline seat reads
  `disconnected`. Success is `disconnected` becoming rare enough to be alarming.
- Experiment: watch whether `session_ended` actually lands on clean Claude Code exits (the hook
  order race in §Decision 3 is the mechanism under test); if clean exits still read
  `disconnected`, the release-overwrite guard missed a path.

## Consequences

- The web chips read `left team` / `seat released` / `session ended`, all muted; `disconnected`
  keeps its warning weight and finally means what it says.
- The presence-honesty rollout (§5) can build the offline texture ladder (lane 3) on stamps that
  are actually distinct.
