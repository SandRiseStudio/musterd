# Guardian confirmed-outage reliability

- **Status:** proposed — awaiting design review (ADR 274)
- **Date:** 2026-08-14
- **Author:** gptbot
- **Relates to:** ADR 152, ADR 230, ADR 263, ADR 274

## Goal

Alert on a real unavailable daemon, not on the brief socket gap a planned refresh creates; make
the guardian’s policy input equally inspectable. A planned handover may defer an alert briefly,
but it may never conceal a restart that failed to return the daemon to health.

## Boundaries

This changes the CLI guardian and autorefresh lifecycle only. It does not alter protocol schemas,
server authorization, guardian classes or tiers, remediation authority, schedule cadence, role
routing, Codex hook wiring, or OpenTelemetry setup.

## Design

### Health confirmation

`collectSignals` receives a health reader that performs one initial probe. If it succeeds, its
result is used as today. If it fails, it makes two additional probes, separated by one second,
within the same tick. Each probe retains the existing two-second request timeout. The reader returns
one of:

- reachable health — at least one probe succeeded; later collection and classification see a
  normal health payload;
- confirmed unavailable — all three probes failed; collection may evaluate launchd and fresh logs;
- deferred handover — all three probes failed while a valid handover record remains within grace.

The first success ends probing. This keeps the normal path inexpensive and bounds the exceptional
path to about six seconds of request timeout plus two seconds of delays.

### Refresh handover record

Add a dedicated JSON record below `~/.musterd/autorefresh/`, separate from `.attempted-sha`:

```json
{ "started_at": 1723679520000, "target_build": "abcdef0" }
```

`refreshDaemon` writes it immediately before `restart(ctx)`, then clears it only after
`verifyDaemonUp` succeeds. Failure leaves it in place so the guardian can reason about the last
attempt. The reader treats a record as valid for 30 seconds from `started_at`; malformed, future,
or expired records are not a grace signal. The marker contains no credentials and is written with
the same local ownership as existing autorefresh state.

Guardian receives the record as a separate injected signal. It never infers it from an attempted
SHA mtime. A confirmed unavailable result during its 30-second grace produces a structured
`guardian.handover_deferred` record and skips incident classification for that tick. After grace,
the existing classifier sees the confirmed unavailable result and can identify a crashloop or emit
`daemon_down`. This ordering preserves the existing alert when a refresh does not recover.

### Policy-read state

Extend the guardian stamp with policy-view state:

- `lastPolicyReadAt`: timestamp of the most recent successful scoped policy read;
- `policySource`: `team_policy`, `shipped_default_unprovisioned`, or `shipped_default_degraded`;
- `lastPolicyErrorAt`: timestamp only for a failed read.

The guardian returns the tier map plus its source from the dependency boundary. An authenticated
read failure uses shipped defaults for this tick, writes `guardian.policy_unreadable` with a
sanitized error kind (never response content), and saves the degraded source. A later successful
read clears the degraded state. An unprovisioned guardian remains an explicit, normal default;
it is not reported as a failed policy read.

`guardianStatusLine` appends the source. A degraded source includes when the error was first seen;
an unprovisioned source says that shipped defaults are intentional. The current concise liveness
and incident text remains unchanged.

## Execution sequence

1. Add failing unit tests for probe confirmation and handover classification.
2. Introduce typed handover read/write helpers and wire writes around `refreshDaemon` restart/
   verification.
3. Make guardian signal collection use the confirmation reader and injected handover state.
4. Add failing unit tests for each policy source and status rendering, then persist the new stamp
   state and structured degradation log.
5. Update CLI/architecture/runbook docs that describe guardian signals and `service status`.
6. Run focused tests, then the required fast gates before pushing; CI remains the complete gate.

## Test matrix

| Case | Setup | Expected result |
| --- | --- | --- |
| Transient probe gap | first health request fails, second succeeds | no incident; no alert; healthy build may update |
| Persistent outage | all three requests fail, no valid handover | one ordinary `daemon_down` classification |
| Planned handover | all requests fail, valid marker younger than 30 s | no incident; `guardian.handover_deferred` logged |
| Failed handover | all requests fail, marker older than 30 s | ordinary crashloop/`daemon_down` logic, never suppression |
| Good policy read | scoped endpoint succeeds | `team_policy` status source, degradation cleared |
| Unprovisioned seat | no service credentials | explicit intentional shipped-default source |
| Policy endpoint failure | endpoint throws | shipped defaults for this tick, sanitized structured record, degraded status |
| Policy recovery | a later endpoint read succeeds | degraded status clears and timestamp advances |

## Risks and safeguards

- A confirmation loop must be injectable in tests; no real delays in unit tests.
- Handover state is advisory only and has a strict expiry, so a terminated refresher cannot create
  permanent alert suppression.
- Status must not print endpoint bodies, team credentials, or token-derived errors.
- Existing `.attempted-sha` semantics remain untouched; it continues to debounce failed builds.
