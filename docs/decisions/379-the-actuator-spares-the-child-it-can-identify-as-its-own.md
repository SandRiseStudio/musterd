# 379 — The actuator spares the child it can identify as its own

- Status: accepted
- Date: 2026-09-04
- Relates to: [ADR 238](238-verify-waits-for-its-own-evidence.md) (defer-and-kill on a foreign
  occupant), [ADR 241](241-a-wake-verifies-against-its-own-lease.md) (the lease token is the evidence bar),
  [ADR 236](236-sleeping-host-defers.md), [ADR 354](354-wake-lease-file-channel.md)
  §Consequences (the residual this ADR closes), [ADR 068](068-workspace-scoped-displacement.md)
  (the foreign-occupant case that must keep deferring), [ADR 014](014-provenance-where-on-attach.md)
  (the `workspace` label), [ADR 368](368-a-workspace-is-identified-by-its-work-tree-not-its-label.md) (label equality is the fallback identity)
- Decided by: nick, 2026-09-04 ("go ahead" on lane 01M1MMHJP3, opened by ryder's sweep); recorded by
  dolly

## Context

ADR 238 and ADR 241 taught the wake actuator to defer, budget-neutral, when the seat it woke turns
out to be **held by another session**: the verify window expires with no row attesting this wake's
lease token, so the actuator kills the child it spawned and reports `wake_deferred`. That verdict is
right when it is true.

ADR 354 measured the case where it is false. For six days every codex wake came up, claimed the seat,
started the work, and was killed at the verify window as "held by another session" — because codex
launches its MCP servers with a sanitised environment, so the adapter never saw `MUSTERD_WAKE_LEASE`
and attested no lease. ADR 354 fixed the *channel* (a lease file the adapter reads) and named the
*judgement* as a residual, verbatim: "the actuator's not-mine path kills a session the actuator
itself spawned ninety seconds earlier, in its own workspace, whose thread id it just wrote into
`binding.json`. That evidence exists and is not consulted before the kill. Left for a sibling lane."
Follows-up: 01M1MMHJP3PQY1QWNJCHV3XEMA
No sibling lane was opened until ryder's 2026-09-03 sweep (lane 01M1MMHJP3).

Verified still true 2026-09-04 on `147202f6`: every backend's not-mine branch reads
`occupied && !lease_matched` and kills. The only evidence it consults is the token. It knows the
workspace it spawned into and the time it spawned; the roster row it is about to kill for carries
`workspace`, and the server stores `presence.created_at` — but does not send it.

The failure this produces is the expensive one: a wake that **did land** is reported deferred, the
act keeps waiting, another lease is minted, and the session that would have answered is dead.

## Decision

**The actuator consults the evidence it already holds before it kills. A fresh, lease-less presence
row created in the wake's own workspace after the wake spawned is the wake's own child, not a foreign
occupant. A genuine foreign occupant still defers and is still killed.**

1. **`attached_at` on the Presence wire.** The server sends `presence.created_at` as `attached_at`
   (protocol `PresenceSchema`, optional/additive). `last_seen_at` moves on every heartbeat and cannot
   say when a session began; `attached_at` can. Absent from older daemons.
2. **The verifier's third verdict, `own_unattested`.** At the verify *deadline* — never earlier; a
   lease-attesting row still wins if one arrives inside the window — if no row attests the lease but a
   fresh row has **no `wake_lease`**, **`workspace` equal to the label the child attaches with from the
   spawn path** (the ADR 014 resolver run by the actuator on the workspace path, host env excluded),
   and **`attached_at` at or after the spawn** (the same freshness bar `sinceTs − 2s` the verifier
   already uses), the verdict is `{ occupied: true, lease_matched: false, own_unattested: true }`.
   Every term is a positive fact on the row (ADR 236): a missing `attached_at` or `workspace` never
   qualifies, and a row created *before* the spawn in the same workspace — a human already in the
   workspace, ADR 068 — stays foreign.
3. **`lease_matched` keeps its meaning.** It is true only when the token matched. Backends read
   `lease_matched || own_unattested` as "mine"; the not-mine branch is `occupied && !mine`. The
   claude-code backend logs one note naming the evidence and pointing at the likely cause (an adapter
   dist that predates the lease token); codex/opencode/grok log the same one line; native honours the
   field for uniformity though its in-process bridge always attests.
4. **Label, not key.** The match is on the `workspace` label because that is what the Presence carries
   (ADR 368 keeps `workspace_key` on the claim frame, not the roster). This is exactly ADR 368's
   fallback rule — compare labels when a key is not available on both sides — and the label is
   computed by the same function the child runs, from the same path, so it agrees unless the branch
   changes inside the verify window.

### Not in this ADR

- **Pid or thread-id evidence.** ADR 354 also named the spawned pid and the thread id written to
  `binding.json`. Neither reaches the roster; the presence row is what the verifier reads. The
  workspace + time pair is sufficient for the measured class and needs no new channel. If a case
  appears where two sessions start in one workspace inside one verify window, that is the trigger for
  a pid-bearing attestation — recorded, not built.
- **Daemon-side `wake_lease_source`** — ADR 354's other named follow-up, gated on the residual being
  observed, which it has not been.

## Consequences

- A codex, opencode or grok wake whose adapter cannot attest the lease (sanitised env and no lease
  file, or an old adapter dist) is now credited to its lease and left alive, with a note. Before,
  it was killed and reported deferred, and the act waited for a session that had just been killed.
- The displacement risk is unchanged in kind: the verifier already credits a lease-matched child
  beside a foreign occupant (wake-leases.md, "with both rows present the child's lease wins"). This
  ADR does not widen that — an `own_unattested` verdict requires the row to be created *after* the
  spawn, so a pre-existing occupant cannot produce it.
- One protocol field, additive; one verifier branch; five backends read one new boolean. No new verb,
  no new word (`attached_at` follows `presence.attached`, the audit action the server already emits).

## Observability & Evaluation

- **Traces:** the existing `residency.woke` / `residency.wake_deferred` rows. A wake credited under
  this ADR produces `residency.woke` and a host-log note containing `ADR 379`; the
  `wake_deferred … held by another session` row that used to follow such a wake does not appear.
- **Eval:** on the live host log, count `credited as this wake's own` lines against
  `held by another session` deferrals for the same seat over 7 days. Success: every credited wake
  has a `residency.woke` and a subsequent act from that session (it really was alive and ours);
  failure — the falsifier — a credited wake whose session never acts, or a `superseded same_workspace`
  event within its window (we credited someone else's session). Baseline: the 13 held-by-another
  deferrals in the three days to 2026-09-02 (ADR 354), all of which were the actuator's own children.
- **Experiment:** `loop.test.ts` "own child that could not attest" (five cases, including the
  before-spawn control and the missing-`attached_at` control) and `claudeCode.test.ts` "is NOT
  killed". Live: spawn a wake into a workspace whose adapter dist predates the lease token and watch
  the child survive the verify deadline with a `residency.woke` row.
