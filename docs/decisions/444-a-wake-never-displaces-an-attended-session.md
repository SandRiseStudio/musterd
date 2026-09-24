# 444 — A wake never displaces an attended session

**Date:** 2026-09-24
**Status:** Accepted
**Lane:** 01M37QHNC8KYW8TRWKWD74YR51
**Amends:** [ADR 017](017-newest-session-wins.md) (newest-wins gains one exception),
[ADR 092](092-same-workspace-successor-ends-predecessor.md) (a wake successor never ends an attended predecessor)
**Builds on:** [ADR 131](131-harness-residency-wake-ledger-host.md) §5–§6 (wake provenance, the local-session guard),
[ADR 238](238-verify-waits-for-its-own-evidence.md) (another session's occupancy is a deferral, not a failure)

## Context

An agent seat holds one live session. ADR 017 made the newest claim win. ADR 068 and ADR 092 scoped
that rule to the workspace: a claim from the same workspace does not displace the incumbent at once.
It ends the incumbent only after the grace window, once it has proved durable.

The wake host (ADR 131) starts a harness session for a seat when an act is due and the daemon sees
the seat offline. Every claim that session makes carries `provenance: 'wake'`. A session a person
opened carries `session`, or nothing at all from an older adapter.

## Problem

On 2026-09-22 nick opened an attended dolly session in `agents-dolly` at 11:58 and kept it open
until 23:06. The daemon's audit table shows what followed:

1. At 11:59:10 the attended session attached (`claude-code`, `provenance: session`). A wake started
   at 11:47 was still running in the same workspace. The attended claim was newer, so it ended the
   wake's presence after the grace window, as ADR 092 says it should.
2. At 11:59:42 the wake claimed again. It was now the newer same-workspace claim, so at 11:59:52 it
   ended the attended session's presence. The attended session never re-attached. Its hook
   one-shots attached rows that were reaped within a minute (12:07:30).
3. With no live presence on the seat, the daemon read dolly as offline and leased more wakes. At
   12:17 the host's local-session guard deferred one, because the attended transcript had just
   been written. At 12:23 the attended session was open but idle, the guard passed, and a second
   wake ran beside it for 25 minutes ($3.09), bumping presences back and forth.

Newest-wins is right when the older session is abandoned: a crash, a reload, a closed window. Here
the older session had a person in it. A wake is a background actuation that exists only because
the seat looked idle. Once it takes the seat from a session a person is driving, the daemon stops
seeing that person, and every guard downstream reads the seat as empty.

## Decision

1. **An agent-seat claim that carries `provenance: 'wake'` is refused while a live session whose
   provenance is not `wake` holds the seat.** "Live" means the session has a connected socket on
   the daemon: a row with no socket is an orphan, which every claim clears anyway. "Not `wake`"
   includes a row with no provenance, so a session from an older adapter is protected too.
2. The refusal uses the existing `claim_conflict` code ("seat occupied", SPEC A.8), on both
   transports. On WS it is a `refused` frame; on HTTP it is a 409 with the same body. The claim
   has no side effects: nothing is displaced, no presence is attached, no lease is minted, and a
   grant is not consumed. It writes `claim.refused {code: 'claim_conflict', reason:
   'attended_session'}`.
3. The rule is checked when the claim arrives, on the WS `hello` and the HTTP claim, before any
   authorization step. So it covers every HTTP branch (grant, credential self-authorize, dogfood
   re-seat), and a refused wake never becomes a pending request. An admin-approved pending claim is
   not re-checked: it does not carry provenance (the approve path attaches `null`), and approving
   it is a person's explicit decision.
4. The converse does not change. An attended claim still displaces a wake, immediately from another
   workspace, or after the ADR 092 grace from the same one. Wake-to-wake stays newest-wins.
5. The host needs no new path. A refused wake never attaches its own lease-attesting row. At the
   end of the verify window, ADR 238 reads the attended session's row as "someone else holds the
   seat", defers the wake (burning no attempt or rate budget), and stops the child.

## Considered and rejected

- **Leave the server alone and strengthen only the host's local-session guard.** The guard can only
  infer an attended session from local files, and an idle session looks the same as a closed one
  there. It also cannot help once the daemon has stopped seeing the person: every later lease is
  then issued in good faith. The host guard is still worth strengthening as a backstop, and that
  ships in the same lane after this rule.
- **Make an attended session re-attach itself after it is displaced.** Repair after the damage. The
  wake would still have run, and any work it did would stand beside a person's session.
- **Refuse any claim while a live session holds the seat.** Reverses ADR 017 for every case,
  including the crashed-session case it exists for.

## Consequences

- A wake that arrives while a person is in the seat costs one spawn and one verify window, and ends
  as a deferral. The act stays due and is delivered when the seat is next idle.
- A person's session is no longer ended by a background process. The daemon keeps seeing it, so
  no later leases are issued against a seat that is actually occupied.
- An attended session whose socket is gone (a deaf adapter, see the interrupt-line notes) is not
  protected by this rule. The daemon cannot see it, so that case belongs to the host guard.
- An older wake adapter that does not stamp `wake` is treated as attended by any later wake. The
  cost is a deferral, never a displacement.

## Observability & Evaluation

- Traces: `claim.refused` rows with `reason: 'attended_session'` count how often the rule fires:
  `SELECT target, COUNT(*) FROM audit WHERE action = 'claim.refused' AND
  json_extract(detail,'$.reason') = 'attended_session' GROUP BY 1;`. Each should pair with a
  `residency.wake_deferred` for the same seat, not a `residency.wake_failed`.
- Eval: the dataset is the ADR 444 fixtures in `transport/integration.test.ts` (`a wake never
  displaces an attended session`): a same-workspace wake, a cross-workspace wake against an
  unstamped occupant, an HTTP wake claim, and the unchanged converse. The baseline is ADR 017/092
  behavior, where the same-workspace wake reaped the attended session after the grace window.
- Experiment: leave an attended session open and idle in a seat's workspace, then direct an act to
  that seat. The wake must end as `residency.wake_deferred`, and the attended presence must still be
  attached afterwards. Falsifier: after this ships, an audit sequence where a `wake` presence's
  `claim.occupied` is followed by a `claim.superseded` that ended a live `session` presence.
