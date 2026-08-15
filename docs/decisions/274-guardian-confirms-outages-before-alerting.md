# ADR 274: Guardian confirms outages before alerting

- Status: proposed (2026-08-14)
- Deciders: nick, gptbot
- Relates to: ADR 152 (autorefresh), ADR 230 (confirmed autorefresh outages), ADR 263 (platform
  guardian), ADR 225 (do not overload a shared signal), ADR 232 (service-seat observability)

## Context

At 15:52 on 2026-08-14 the guardian alerted `daemon_down`, although repeated `/health` requests
and the daemon log showed a continuously healthy daemon. The alert coincided with a planned
autorefresh handover. The current guardian turns one failed `GET /health`, with a two-second
timeout, into `health: null`; its classifier then immediately emits `daemon_down`, even when
launchd reports an otherwise normal job. A single probe measures a transient transport gap, not
an outage.

The current shared `.attempted-sha` file is deliberately a build-attempt debounce. Its mtime
cannot safely mean “a restart is in progress”: it can remain after a build failure and ADR 225
already records the cost of letting one signal stand for distinct facts. The guardian must instead
observe a purpose-built refresh handover state.

The guardian also obtains its tier map through the scoped, non-secret `guardian-tiers` endpoint.
It falls back to shipped defaults on a read error and writes a log line, but `service status` does
not expose whether the policy view is current. An on-call instrument must make a degraded control
input visible without treating an intentional unprovisioned service seat as an incident.

## Decision

1. **Confirm an unreachable health result inside one guardian tick.** A `daemon_down` candidate
   receives two further bounded `/health` probes after short delays. Only three consecutive failed
   probes may enter ordinary outage classification. A successful confirmation probe makes the tick
   healthy and records no incident. This is confirmation, not a new two-minute damping interval.
2. **Publish refresh handover state explicitly.** Immediately before a refresh restarts the daemon,
   autorefresh writes a small local handover record with its start time and target build. It clears
   the record after a verified healthy restart. Guardian reads that record rather than
   `.attempted-sha`. While a non-expired handover is present, a failed confirmation is recorded as
   a deferred probe, not alerted; once the bounded grace expires, the same confirmed failure enters
   the normal crashloop/`daemon_down` ladder. A failed refresh therefore remains loud rather than
   being masked by its own marker.
3. **Make tier-read source and degradation observable.** A successful scoped policy read, an
   intentionally unprovisioned default, and a failed policy read are distinct states in the
   guardian stamp and `service status`. On a genuine read failure the current tick still uses
   shipped defaults, but logs a structured `guardian.policy_unreadable` record and status remains
   visibly degraded until a later successful read. No policy credentials or response body are
   persisted or logged.
4. **Keep remediation authority unchanged.** This ADR changes evidence quality and observability;
   `daemon_down` stays alert-only and ADR 263’s class tiers, service-seat identity, and one-hour
   remediation damping remain intact.

## Alternatives rejected

- **Wait for the next scheduled tick before confirming** — adds up to two minutes of unnecessary
  alert latency for a real outage and leaves a one-sample assertion in place.
- **Suppress all alerts soon after `.attempted-sha` changes** — confuses build debounce with
  liveness and can hide a failed build or stuck restart.
- **Treat launchd running as proof that the daemon is healthy** — launchd can host a process that
  has not bound the service or is otherwise unable to answer `/health`.
- **Silently retain policy defaults after a read error** — preserves availability but makes it
  impossible to distinguish a deliberate default from a broken control plane.

## Observability & Evaluation

**Traces:** structured guardian records for `guardian.health_confirmed`,
`guardian.handover_deferred`, and `guardian.policy_unreadable`; the handover record lifecycle;
the guardian stamp; and the `service status` guardian line.

**Eval** — amend ADR 263’s two-week read with these measures:

1. Count initial health misses, their confirmation outcomes, and alerts. A health miss followed by
   a successful confirmation is a false-positive candidate; it must not page.
2. Count handover deferrals and whether each resolves before grace expiry. A deferred probe that
   reaches expiry while health remains unavailable must produce the ordinary incident record.
3. Count policy-read failures, their duration, and the tier source shown by status. A failure that
   is not visible in both the ledger and status is a defect.

**Experiment:** deterministic fault-injection tests rather than an A/B: transient first-probe
failure, persistent outage, planned handover that recovers, handover that never recovers, and a
failed tier read followed by recovery.

## Consequences

- The guardian tick becomes a few seconds slower only after an initial health miss; healthy ticks
  stay one probe.
- Autorefresh owns the handover record’s lifecycle; guardian is a read-only consumer. Manual
  refreshes use the same record because they perform the same daemon restart, while a bare manual
  `service restart` remains outside this autorefresh handover contract.
- `service status` gains a compact policy-source/degraded indicator alongside the existing guardian
  liveness line.
- Implementation detail and test cases are in
  `docs/superpowers/specs/2026-08-14-guardian-confirmed-outage-design.md`.
