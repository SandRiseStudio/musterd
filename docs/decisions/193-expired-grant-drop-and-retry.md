# 193 — An expired grant strands a restarted adapter; drop it and retry bare

- Status: accepted
- Date: 2026-07-31
- Builds on: [ADR 087](087-seat-resume-vs-claim-one-verb.md) (resume token),
  [ADR 108](108-probe-safe-autojoin.md) (amendment: memoize success),
  [ADR 146](146-dogfood-reseat-grant.md) (bare re-seat of a known agent seat),
  [ADR 144](144-mcp-tool-surface-measure-then-craft.md) inc 3 (repair classes)
- Lane: `01KYQCF678TC29ARGWRFD2H4A5` (seat-drop B — the branch #490 left open)

## Context

Seat-drop A (`01KYQBSD93`, #490 / #519 / #524) covered three faults that share the message
"you haven't joined the team yet." Seat-drop B is a fourth, deliberately unbundled: a
**restarted** adapter whose binding still carries a grant that the server now refuses.

`client.claimed` is `Boolean(config.member)`, and `member` is only written by the server's
`occupied` frame — by design (claim-on-first-use). A fresh process therefore reads as a pending
presence until a claim succeeds. That is correct while claims succeed. It is a trap when they
do not: on `refused`, the adapter sets `wantPresence = false` and stops reconnecting, so one bad
claim strands the session as unclaimed for the life of the process. The only exit is a manual
`team_join`.

Live audit on revive: many `claim.refused` rows with `code: "expired_grant"`. izzo hit the
branch once (2026-07-28) — `team_send` refused, unclaimed, code GXJ0; a manual join cleared it.

## Problem

Three questions the lane left open, answered here with evidence:

1. **Does an expired grant produce `refused` or `pending`?** `refused`, code `expired_grant`
   (`validateGrant` → `reason: 'expired'` in both WS and HTTP claim handlers). Terminal today —
   no retry, `wantPresence` cleared.
2. **Should the client drop a rejected grant and retry bare?** Yes for stale-grant refusals.
   A grant is an optimisation (skip the approval lane), not the authenticator — the team agent
   key is. With ADR 146's `standing_reseat_known_agents` on, bare reclaim of a held agent seat
   occupies immediately; without it, bare claim opens `pending` (honest) instead of a permanent
   "unclaimed" lie. Persisting the drop to `binding.json` is required — otherwise the next
   process restart re-poisons itself from disk.
3. **What should the refusal text say?** The dormant guard's pending-presence arm ignored
   `lastJoinError`, so an agent saw "claim a seat first: team_join {as:'Ada'}" — the wrong
   repair — while the real cause was an expired grant. Surface the failure (and ADR 144's
   repair class) even when `claimed` is still false.

Out of scope: reminting grants (a human / enroll path); changing server refuse codes; seat-drop A.

## Decision

1. **Stale-grant refuse → drop + one bare retry.** On `refused` whose code/message names a
   stale grant (`expired_grant`, or `grant expired|revoked|consumed|not_found`), clear
   `config.grant`, rewrite `binding.json` without the grant, and send one more `claim` on the
   same socket with no grant. Do **not** clear `wantPresence` on the first refuse. Other refuse
   codes stay terminal (invalid key, wrong-seat grant, superseded, …). At most one drop-retry
   per join attempt.
2. **Pending-presence guard names the failure.** When `!claimed` but `lastJoinError` is set,
   `notReadyMessage` includes the failure + repair hint — same shape as the dormant arm —
   instead of only "claim a seat first."
3. **Repair class stays.** The existing `expired_grant` repair hint (remint via
   `musterd agent <seat> --path …`) remains for the case where bare retry still cannot occupy
   (policy off, never-bound seat, etc.). Self-heal makes remint optional on dogfood teams, not
   obsolete for teams that still gate re-seat.

## Consequences

- A restarted adapter whose resume token lapsed re-occupies on the next tool call / join when
  the team allows known-agent reseat — no manual join, no remint required for the routine case.
- `binding.json` stops carrying a grant the server has already rejected, so restarts converge.
- Revoked / not-found grants take the same drop-retry path: a revoked *resume token* is not a
  revoked *seat*, and ADR 146 already authorises bare re-seat of a held agent seat.
- Docs: this ADR; architecture `05-mcp.md` notes the drop-retry beside the claim handshake.

## Observability & Evaluation

- **Traces:** n/a — no new spans; the drop-retry rides inside the existing join / first-tool
  autojoin path (ADR 089 / 108).
- **Eval:** dataset = `audit` rows with `action = 'claim.refused'` and `detail.code =
  'expired_grant'`, plus the follow-on `claim.occupied` / `claim.reseated` for the same seat in
  the next few seconds. Baseline (pre-fix, revive): clusters of `expired_grant` with no
  subsequent occupy from that adapter process. Score: after the fix, an `expired_grant` refuse
  should be followed by a bare occupy/reseated for held agent seats on dogfood (policy on), and
  `binding.json` should lose the grant.
- **Experiment:** the integration test in `packages/mcp/src/mcp.test.ts` — occupy → expire grant
  in DB → fresh client with the stale grant → expect join success and grant cleared from disk.
