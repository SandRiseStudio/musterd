# 252 — A wake that dies unreported is paid and invisible

- Status: accepted
- Date: 2026-08-12
- Deciders: ryder, izzo (measured the gap on the live ledger), wanderer (second read on the capture
  path; their first correlation proposal is the one rejected below)
- Relates to: ADR 241 (the lease token this extends from presence onto session attestation), ADR 238
  (the "any fresh presence is my evidence" inference neither ADR may re-admit), ADR 236 (absence is
  not an assertion), ADR 131 (§4 the wake ledger, §5 the resumable attestation, increment 5
  `wake_cost`), ADR 173 (absent is not unknown), ADR 128 (what never leaves the daemon)

## Context

`residency.wake_cost` is written in exactly one place: the wake-report route, when a host posts a
`cost_usd` for a lease. That makes the ledger's cost column a record of **wakes that finished well
enough to report**, while presenting itself as a record of wake spend.

The two are not the same, and the gap is not small. izzo's read of the live ledger: 35 cost rows
against 65 `residency.woke` and 150 leases. My own ADR 246 incident is the sharp case — two acts
exhausted their attempts, real sessions were spawned and really cost money, and the ledger carries
zero cost for them. A lease that spawns a session and then expires reads, in every derived metric,
as a wake that was free.

The bias runs in the worst possible direction. Cost is missing _precisely where wakes fail_, so the
cheaper the ledger says the failure path is, the more of it there actually was. Any tuning decision
made against `cost_usd_total` — budgets, attempt ceilings, whether the always-on claim pays for
itself — is made against a number that systematically under-prices its own failure mode.

The obstacle was never the arithmetic; it was correlation. Nothing joined a lease to the session it
spawned. The session attestation (ADR 131 §5) carries harness class, event and a one-way digest —
by construction nothing that identifies which wake, if any, caused it.

**The rejected design.** The first proposal was to backfill: on lease expiry, attribute the most
recent session capture for that seat to the expiring lease. It is rejected. That is timing
correlation, and it is the identical inference — _any fresh session-shaped evidence near my wake is
my evidence_ — that ADR 238 shipped, ADR 241 rejected, and two increments were spent removing from
the verification path. Re-admitting it on the accounting path would produce a cost ledger whose
errors are invisible by construction, which is worse than the honest gap it replaces.

ADR 241 already minted the right token and already puts it in the woken child's environment. It was
simply never carried onto the one row that proves a session existed.

## Decision

**A wake's spend is attributed by identity or not at all.**

1. **The session attestation carries the wake lease.** `SessionAttestationBodySchema` gains an
   optional `wake_lease`, sourced by `captureSession` from `resolveAttestedWakeLease(process.env)` —
   the same resolver, the same `MUSTERD_WAKE_LEASE`, the same no-default rule as ADR 241 §4. The
   daemon records it on `residency.session_captured` / `residency.session_ended`.

2. **Presence is evidence; absence is silence.** Only a woken child has the variable, so an ordinary
   session omits the field and asserts nothing (ADR 236). A pre-ADR-252 CLI also omits it, so "no
   session claimed this lease" never means "no session ran".

3. **Lease expiry stamps the fact, never a figure.** When a lease expires and a session attested
   _that lease id_, the `residency.wake_failed` row carries `session_captured: true`. It carries no
   `cost_usd`: no cost source exists on this path, and a plausible number here would be a fabricated
   measurement in a ledger whose whole job is to be trustworthy about spend.

4. **The ledger counts it as unpriced, outside the totals.** `WakeMetrics` gains
   `unpriced_sessions`: leases known to have paid for a session and known to carry no price. It is
   never folded into `cost_usd_total` or `cost_usd_per_wake`, which stay exactly what they claim to
   be — attested spend. The honest headline is "$X across N wakes, plus M wakes that cost something
   we cannot name".

5. **Every count derived from the token is a floor, and is documented as one.** A workspace whose
   dist predates this ADR attests nothing, and its wakes are simply not visible in
   `unpriced_sessions`. The number may only ever be read as "at least this many".

## Consequences

- The failure path becomes sayable. A wake that spawned a session and died unreported now leaves a
  trace on the ledger, and the trace names the lease rather than describing a coincidence.
- The cost totals do not move, and that is the point: this change adds a second, honestly-labelled
  quantity rather than improving the first one with estimates.
- A second identity join lands on the ledger: `residency.session_captured` can now be joined to the
  wake span through `wake_lease`, the same key ADR 241 put on the presence row. The narrowness ADR
  241 asked for still holds — this is a correlation token, not a session id by another name, and the
  attestation body still has no field for an id or a transcript path (ADR 128).
- **A rollout coupling, and it is the benign direction.** Until each enrolled workspace rebuilds,
  its captures attest no token, so its unreported wakes stay invisible. The number under-reports and
  never over-reports.
- The `unpriced_sessions` counter can only shrink toward truth as coverage grows, so a _rise_ in it
  after rollout is expected and is not a regression signal on its own.

### Limitations, and what is left open

- **The cost of an unreported wake stays unknown.** This ADR makes the gap countable, not priced.
  Actually pricing it needs a cost source on the failure path — a host-side reap that reads the
  harness's own accounting after a run dies — which is a separate increment with its own design.
- **`session_captured` is stamped only at lease expiry.** A session that attests its lease _after_
  the expiry row is written is not retro-stamped; the read-time counter would need to join the two
  rows itself. Left open deliberately: capture fires at session start, which precedes expiry in
  every ordering this path produces.
- **First live observation of the ADR 241 token — done, and it arrives.** A week after ADR 241
  shipped, `wake_lease` had never been observed landing anywhere: zero presence rows, zero audit
  rows, because no woken session had existed to check. Inheritance was argued
  strong-but-not-conclusive (the hook scrubs no environment; sibling `CLAUDE_*` variables inherit)
  and never observed. It is observed now — see the Eval below.
- **The probe ran against an isolated daemon, not the shared one.** The chain it exercised is the
  real one (harness → SessionStart hook → CLI → daemon), and the lease was daemon-minted, but the
  host loop's own poll/report cycle was driven by hand. A wake actuated end-to-end by `musterd host`
  is still unobserved for this path.

## Observability & Evaluation

**Traces.** No new span. `residency.wake_failed` gains one boolean in its existing `detail`
(`session_captured`), and `residency.session_captured` gains `wake_lease` — which is what makes the
existing `musterd.residency.wake` span joinable to the session it spawned, through the same
`musterd.lease_id` attribute ADR 241 already emits.

**Eval.** The claim is that a paid wake is never again invisible merely because it failed. The
discriminating evidence is live and has two halves, because the second is worthless without the
first:

1. **The token arrives.** A real wake produces a `residency.session_captured` row whose
   `wake_lease` equals the lease id on the `residency.wake_leased` row that caused it. Before this
   change no row anywhere carried the token — the whole ledger held zero instances.
2. **The failure path is priced as unpriced.** A wake whose lease expires after such a capture
   produces a `residency.wake_failed` row with `session_captured: true`, and `unpriced_sessions`
   counts exactly that lease while `cost_usd_total` is unchanged.

**Both halves observed live, 2026-08-12** (isolated daemon on this build; a temp seat workspace, a
real `claude-code` session spawned with the actuator's own `wakeEnv` shape):

1. A daemon-minted lease `01KZVGC2MM…` was polled for a real urgent act; the session spawned under
   `MUSTERD_WAKE_LEASE=01KZVGC2MM…` produced
   `residency.session_captured {"harness":"claude-code","enrolled":true,"session_digest":"4dd397959dac","wake_lease":"01KZVGC2MM…"}`.
   That is the first `wake_lease` ever observed landing on any row, anywhere.
2. Expiring that lease produced
   `residency.wake_failed {…,"reason":"lease_expired","session_captured":true}` — no `cost_usd` — and
   the report read `unpriced_sessions: 1` with `cost_reported: 0` and `cost_usd_total: null`. The
   paid wake is now visible, and the totals stayed honest about knowing no price.

One thing the probe surfaced that is worth recording: the second capture was initially **gated** by
the interloper gate (#744) because the first probe session's slot was still un-ended and
live-looking. That is the gate working, not a defect — but it means a wake into a workspace holding
a live-looking slot attests no token, which is a real (and correctly-behaving) source of the floor
in §5.

Supporting read: `unpriced_sessions + cost_reported ≤ leases`, always — a lease that is both priced
and counted unpriced is a bug in the dedupe, not a finding.

Failure to watch: `unpriced_sessions` staying at 0 while `residency.wake_failed` rows accumulate. On
this design that means the token is not arriving — the rollout coupling above, or a regression in
env inheritance — and it must be read as an instrument failure rather than as good news.

**Experiment.** None. There is no arm to compare: the alternative is a cost ledger that under-prices
its own failure mode by an unknown amount, which is the state being corrected, and running it
deliberately would only re-measure the bias izzo already measured.
