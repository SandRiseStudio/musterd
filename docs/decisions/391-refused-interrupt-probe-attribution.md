# 391 — Refused interrupt probes retain proven seat attribution

- Status: proposed
- Date: 2026-09-05
- Builds on: [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the interrupt line: a silent-or-one-line probe at every tool boundary), [ADR 337](337-agent-http-session-authority.md) (an agent's HTTP proof is a seat credential inseparable from its Presence lease), [ADR 082](082-instrument-by-default-telemetry.md) (the request log carries method/path/status/latency and never headers), [ADR 057](057-ambient-agent-presence.md) (a one-shot authenticated command is proof of liveness)
- Lane: 01M1T424MNESHCBQ0XSBS05932 (opened by izzo from the 2026-09-05 bell check; number reserved by gptbot, body and code by izzo)

## Context

The interrupt line (ADR 088) is a `GET /inbox/interrupt-check` that a harness hook runs at every
tool boundary. It authenticates as an agent seat: a self-identifying `msac_` seat credential plus an
`msls_` session lease bound to the seat's current Presence (ADR 337). When the lease is missing or
dead the probe is refused with 401, and the seat is **deaf** — every act addressed to it lands in its
inbox and none of them rings. The seat does not know: `#1317` made the refusal audible *from the
seat's own side*, but the daemon could say nothing.

Measured during the 2026-09-05 bell check ([huddles](../wiki/huddles.md), "Bell check"): in twelve
minutes the daemon served **102** interrupt probes, **76** returned 200 and **26** returned 401, and
the operator watching the log could not name a single refused seat. The answer had to be collected
by asking every session to run the probe by hand. Every autorefresh bounce — one per merge —
re-creates the condition fleet-wide.

The cause is a discarded proof. `authByAgentSeatCredential` (store/members.ts) resolves the `msac_`
credential to a real, live agent Member **first**, and only then examines the lease. On a missing or
dead lease it threw a plain `MusterdError('unauthorized', …)`, so the Member it had just verified
left the function as nothing. The request log (index.ts `http_request`) is deliberately headers-free
(ADR 082), so it carries method, path, status and latency and no seat. Nothing between the store and
the log had a name to write.

## Decision

1. **The store keeps the proof it made.** The two lease-failure branches of
   `authByAgentSeatCredential` throw `SessionLeaseRefused`, a `MusterdError` subclass carrying the
   verified seat **name** and a two-word lease state, `missing` or `dead`. Code and message are
   unchanged — the wire body a caller receives is byte-identical to before. The caller already holds
   the credential that names this seat; the fields exist for the server, not for the response.

2. **Only the interrupt route reads it.** `GET /inbox/interrupt-check` catches `SessionLeaseRefused`
   around its `authTouch`, writes one `interrupt_probe_refused` log line naming the seat and the
   lease state, appends an `interrupt.refused` audit row (target = the seat, `detail: { lease }`),
   and re-throws — the response is the same 401 it always was. Every other route's 401 is untouched:
   a refused `/inbox` read is not evidence of deafness, only the probe is.

3. **The name comes from the credential, never the header.** `x-musterd-seat` is a claim a caller
   makes about itself; it proves nothing and is never written. A spoofed header on an invalid
   credential produces a plain 401 and no row. Neither the credential nor the lease token ever
   reaches the log or the audit — the seat name and two words do.

4. **One row per seat per ten minutes.** The probe fires at every tool boundary; a deaf seat doing
   ordinary work would otherwise write a row a second. `hasRecentInterruptRefusal` collapses a
   burst to one row (`REFUSAL_WINDOW_MS`). The row answers *who* and *roughly when*; the request
   log still counts.

### Rejected

- **Put the seat on the `http_request` line.** That line is headers-free by decision (ADR 082) and
  fires for every route. Widening it for one route's diagnosis would put member names on 4xx lines
  team-wide, and the identity would still have to travel from the store to `index.ts` through a
  layer that has no business knowing it.
- **Trust `x-musterd-seat` on a refused probe.** Cheapest possible fix and exactly wrong: the row
  would record whatever an unauthenticated caller typed. A log a forged header can write into is
  worse than no log.
- **Heal the lease in the probe.** That is a different lane (01M1T41YRA): the probe is excluded from
  the lease heals by design, because it rides every tool call. Naming the deaf seat is what makes
  that lane's fix measurable; it is not that fix.

## Consequences

- One new audit verb, `interrupt.refused`. Not replicated (it is a local daemon's observation of a
  local seat's probe). One new exported error class in `errors.ts`. No wire change, no schema change.
- The daemon log gains a per-refusal warn line on one route. A deaf seat is now identifiable from the
  daemon's side in one grep, which the bell check could not do.
- `interrupt.raised` and `interrupt.refused` together describe a seat's line: the first says a bell
  reached its probe, the second says its probe was turned away. A seat with recent `refused` rows and
  no `raised` rows is deaf and nobody has told it.

## Observability & Evaluation

- **Traces:** `interrupt_probe_refused { seat, lease, team }` at warn in the daemon log;
  `interrupt.refused` in the audit, deduped per seat per window. Dataset for lane 01M1T41YRA's
  before/after: rows per seat per day, and the gap between a seat's first `refused` row and its next
  `raised` one — that gap is how long the seat was deaf.
- **Eval:** the next bell check. Its 401 count should resolve to a list of seat names with no
  session asked anything. Falsifier: a 401 on the interrupt route with a valid seat credential that
  appears in the request log and has no `interrupt.refused` row inside the window.
- **Experiment:** n/a — this is an instrument, not a comparison between variants. The four
  falsifiers below are its test, and lane 01M1T41YRA's lease-heal is the experiment this instrument
  exists to measure.

## Falsifiers

- Revoke one seat's lease, let its hook probe fire, run
  `grep interrupt_probe_refused ~/.musterd/daemon.log` — it names the seat. If it does not, the
  route is not catching the class.
- Probe with an invalid `msac_` credential and `x-musterd-seat: <victim>`. If any `interrupt.refused`
  row names the victim, the header is being trusted and decision 3 is broken.
- Probe five times inside ten minutes with a dead lease. More than one row means the dedupe is off.
- `grep -E 'msac_|msls_' ~/.musterd/daemon.log` after any of the above. A hit is a secret in the
  log and this ADR is withdrawn.

Tests: `packages/server/src/transport/integration.test.ts`, "a refused interrupt probe names the
seat it already proved (ADR 391)" — five cases. Verified against the pre-change route on
2026-09-05: the three positive cases (dead lease named, missing lease named, dedupe) fail red, and
the two negative controls (spoofed header names nobody, an ordinary read audits nothing) pass both
before and after — which is what a control is for.
