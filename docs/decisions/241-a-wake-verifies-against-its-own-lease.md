# 241 — A wake verifies against its own lease, not against a description

- Status: accepted
- Date: 2026-08-05
- Snapshot-debt: none — the one frequency word in §Decision ("a woken session's first
  authenticated call is usually a hook") describes the harness wiring order (SessionStart hook
  before any tool call), not a measured rate; nothing in this ADR asserts a number over a window.
- Deciders: ryder, gptbot (rejected the ADR 238 outcome that made this necessary), stanley (named
  the hypothesis increment 1 failed to close)
- Relates to: ADR 238 (increment 1 — this ADR corrects its remaining hole), ADR 236 (absence is not
  an assertion), ADR 221 (a host that cannot actuate defers), ADR 131 (harness residency — §2 the
  host loop, §6 the wake environment), ADR 225 (the shared-predicate trap), ADR 128 (what never
  leaves the daemon), ADR 101/148 (the attestation fields this token sits beside, and differs from)

## Context

ADR 238 stopped wake verification from crediting **another session's** presence row to a wake. It
did so by requiring the row to attest `provenance: 'wake'` rather than accepting the first fresh row
of any provenance. gptbot rejected the outcome on review, and the rejection is right:

> `verifyOccupied` treats any fresh `provenance:'wake'` Presence as evidence of THIS wake. Presence
> has no wake/session identity, and a prior still-live wake session keeps `last_seen_at` fresh, so a
> later wake is again credited immediately (the same false-success shape ADR 238 says it removes).

The whole failure is in one sentence: **`wake` is a description, and descriptions do not
discriminate between two things that share them.** A prior wake session, still alive inside its
30-minute `work_order` timeout, keeps its own row fresh simply by working. The next wake polls,
finds a fresh `wake` row on the first read, and reports the act delivered to a session that never
received it.

That is strictly worse than the bug ADR 238 removed. A false _failure_ burns budget and is loud; a
false _success_ is silent and terminal — the act is marked delivered and nothing ever retries it.

The route here is worth recording, because the pattern repeated three times in one lane. Every fix
so far replaced one heuristic with a slightly better heuristic over fields that describe a session:
first "a fresh presence exists", then "a fresh presence exists **and** says `wake`". Each was an
improvement and each was wrong in the same way. The presence wire (`PresenceSchema`) carries
`surface`, `status`, `last_seen_at`, `provenance`, `workspace`, `driver`, `model`, `build`, `epoch`
— nine fields, all descriptions, **no identity and no correlation to the act that caused the
session**. No predicate over those fields can answer "did _my_ wake produce this occupancy", so the
answer was to stop trying and put the identity on the wire.

One more thing belongs in the record. stanley's original brief named this exact hypothesis — "the
`work_order` policy timeout is 1800000ms (30m), so the 09:27 session could still have been alive at
09:57; overlapping sessions on one seat is worth ruling in or out" — and increment 1 shipped without
ruling it in or out. The mechanism was handed over and not used. **A named hypothesis is closed
explicitly or the reason for leaving it open is written down.**

## Decision

**A wake accepts only evidence that names the lease it is actuating.**

1. **The correlation token is the lease id the daemon already mints.** No new identifier: every wake
   order carries `lease_id`, it is already on the wire, and it already joins the ledger — so the
   presence row, the wake report, the audit rows and the trace span all key on one value.

2. **It travels to the child in the environment**, beside `MUSTERD_PROVENANCE`, as
   `MUSTERD_WAKE_LEASE` — through both actuator backends' spawn environments (codex's allow-list;
   claude-code's `wakeEnv`). Hooks and one-shot CLI commands inherit it exactly as they inherit
   provenance, which matters because a woken session's _first_ authenticated call is usually a hook,
   not the adapter's claim.

3. **It is attested, never asserted.** The MCP adapter sends it on the claim frame; the CLI sends
   `x-musterd-wake-lease` on ambient touches, under the same agent-key-only gate as model and
   provenance (ADR 121 — a lease token in a human's shell must not let that shell pose as a
   machine's wake). The daemon stores it on the presence row (`presence.wake_lease`, migration v34)
   and exposes it on `PresenceSchema`.

4. **The resolver has no default, and must never grow one.** `resolveAttestedWakeLease` returns
   `undefined` when the variable is unset — unlike `resolveProvenance`, which defaults to `session`
   because that is an honest description of an unlabelled session. A defaulted token would convert
   "I don't know what spawned me" into "this lease spawned me", which is the false assertion ADR 236
   exists to forbid and the precise bug this token was added to fix. An absent token never matches.

5. **`verifyOccupied` accepts a fresh row only when `wake_lease` equals this lease**, and returns
   `lease_matched` so the backend can tell apart the two outcomes it must never confuse: _the seat
   is held by a session I did not create_ (defer, budget-neutral, ADR 221/236) from _nobody occupied
   it_ (a real failure that burns). The lease is bound by the loop from the order it is actuating —
   there is no parameter for it, so a backend cannot verify against a lease it was not handed.

6. **The token replaces the provenance test in the codex backend's deferral rule, rather than
   joining it.** Under ADR 238's rule a seat held by _another wake_ read `provenance === 'wake'` ⇒
   not held-by-other ⇒ a charged failure. That is exactly backwards: the other session is alive and
   working, and this act should wait for it rather than pay for it.

**The token is not a secret and grants nothing.** The daemon does not verify that the lease exists or
belongs to the attesting member, because the token is evidence _for the host that minted it_, not an
authorization. A forged value can at most make a session claim a wake nobody is verifying. It is a
daemon-minted opaque id — never a session id, transcript path, or token — so it carries nothing
ADR 128 keeps off the wire, and it was already on the wire in the wake order.

**The claude-code backend gets the token plumbed but not the strict check.** Its success bar is
looser than codex's — it accepts any occupancy and merely _logs a note_ when provenance is not
`wake` — so tightening it to require a lease match is a larger behavioural change than this
rejection demands, and it would fail every wake into a workspace whose adapter dist predates this
ADR. That is a rollout question with its own verification, so it is increment 3 (see Limitations),
and the token is plumbed now so that increment needs no second rollout.

## Consequences

- The false success is closed on the codex path: a prior wake's row can no longer satisfy a later
  wake, in any timing, because it names a different lease.
- A seat held by another wake now defers instead of burning — a strictly better classification of a
  case ADR 238 got wrong in the other direction.
- **A rollout coupling**: a woken session whose adapter dist predates this ADR attests no token, so
  its wakes deferred-loop until that workspace is rebuilt. This is deliberate and it is the honest
  failure direction — budget-neutral and retried, rather than silently reported as delivered. The
  daemon, host and adapter ship from one repo here, so in practice the coupling is a rebuild.
- The presence row gains its first field that identifies rather than describes. That is a real
  widening of what presence is for, and it should stay narrow: the token exists to correlate an
  occupancy with the act that caused it, and it is not a session id by another name.
- `wake_lease` travels with `provenance` on ambient touches rather than sticking like
  `model`/`build`/`epoch`. The two answer one question together; a sticky token under a fresh
  provenance would keep asserting a lease the session no longer belongs to.
- **2026-09-02 (increment 3, lane 01M1HQC9JJ):** the claude-code backend now holds the same bar.
  `occupied && !lease_matched` defers, kills the child, and a deferred resume does not fall through
  to a fresh spawn. It was the last of five backends gating on occupancy alone, and the only one
  whose seats are routinely contended by a human in the worktree. The rollout coupling above now
  applies to claude-code workspaces too: a dist that attests no token deferred-loops until rebuilt.
  Wiki: `docs/wiki/wake-leases.md` §"The mirror defect".

### Limitations, and what is left open

- **ADR 238's own limitation is now recorded in its Context.** It narrowed the false-success window;
  it did not close it. What remains true in 238 is that all three 2026-08-05 failures showed a
  `session` row at verify time, so waiting past it was right for those.
- **Increment 3 — closed 2026-09-02 (lane 01M1HQC9JJ).** _As written 2026-08-07:_ the claude-code
  backend's success bar accepts any fresh occupancy as its own, so it has this defect wider open
  than codex ever did, with no symptom yet only because its wakes have not been contended. It needs
  the strict check plus a rollout check that every enrolled workspace's dist attests the token.
  _2026-09-02:_ the strict check landed (see Consequences). The rollout check is unchanged from
  codex's: a workspace whose adapter dist predates the token defers, which is the honest direction.
- **Not verified live.** This increment is proven by unit tests and by mutation, not by a live wake.
  The live probe that produced the ~8s figure cost real OpenAI budget and was not repeated.

## Observability & Evaluation

**Traces.** No new span. `residency.wake_deferred` gains a fourth reason shape — the seat held by a
session naming a different lease — carried in the existing `detail.reason` string alongside
`local-session-live`, binary-not-found and `host_unreachable`. The lease id is already an attribute
on the `musterd.residency.wake` span (`musterd.lease_id`), so a woken occupancy can now be joined to
the span that caused it through `presence.wake_lease` — a join that did not previously exist.

**Eval.** The claim is that a wake is never again credited to a session it did not spawn. The
discriminating evidence is a live one: **a wake ordered for a seat while a prior wake session is
still inside its 30-minute `work_order` timeout must report `residency.wake_deferred`, never
`residency.woke`.** Before this change that case reported `woke` on the first poll with no session
having received the act. Two supporting reads from the ledger: no `residency.woke` row should carry
a lease absent from the presence row it was verified against, and the `wake_deferred` rate should
rise slightly (the contended-by-another-wake case moving out of `wake_failed`) without
`residency.woke` falling. Failure to watch: a **sustained** rise in deferrals for one seat, which
would mean that workspace's dist does not attest the token — the rollout coupling above, and the one
new way this change can go wrong.

**Experiment.** None, and deliberately. An arm without the fix is an arm that reports undelivered
acts as delivered, which corrupts every downstream measurement that counts delivery — including
ADR 234's acceptance measurement, whose asks are what stalled behind this in the first place.
