# The platform guardian, increment 1 — pure code on call

- **Status:** implementing (ADR 263)
- **Date:** 2026-08-13
- **Author:** izzo
- **Seed:** [docs/design/roles-and-stewardship.md](../../design/roles-and-stewardship.md) — the
  2026-07-20 guardian sketch, reexamined 2026-08-13 against everything that landed since
- **Relates to:** ADR 152 (autorefresh — the actor this guardian supervises), ADR 232 (ledger
  seats, `kind: service` — who answers for an unattended actor), ADR 227 (`platform` role),
  ADR 150 (team policy / enforcement classes), ADR 035 (`musterd notify`), ADR 251/131 (native
  harness residency — the reserved model tier this increment deliberately does not build),
  ADR 252 (wake cost — why it doesn't), ADR 259 (wiki as runbook home)

## What changed since the seed, and what this is

The 2026-07-20 sketch wanted an on-call self-healing-prod agent. Since then: ADR 232 answered
the responsibility question (service seats on the ledger — `autorefresh` already holds
`platform`); autorefresh itself absorbed the most common failure (build currency, lockfile
self-heal #578, hold-vs-failure #775); and ADR 251 made "a resident model seat the daemon can
wake" a real, priced target instead of a hand-rolled stopgap.

What nothing watches today: `daemon_down`, `crashloop`, `schema_drift`, `wrong_db`,
`error_rate`, `presence_churn`. The discovery mechanism for a dead daemon is nick noticing.

**Increment 1 is pure code, end to end.** The two safe remediations are deterministic
commands; classification is deterministic recency-keyed checks. No model tokens are ever
spent — not when healthy, not during an incident. The model tier (off-script diagnosis, draft
fix PRs) arrives later by swapping the alert sink for a phase-2 native resident wake; probe,
classes, policy dial, and seat identity all survive that swap unchanged. On an 8 GB machine at
chronic swap pressure, "no model, ever" is a feature, not a cut.

## Decision

### 1. Placement — a third LaunchAgent, outside everything it watches

A watcher inside the daemon cannot see `daemon_down`; one inside autorefresh cannot supervise
autorefresh. The probe is its own LaunchAgent (installed/removed via `musterd service
--guardian` alongside the existing daemon + autorefresh install paths, inheriting the
`process.execPath` embedding — install under the Node 22 PATH), running a pure-Node probe
script on a ~2-minute interval. Near-zero footprint: no build step at probe time, no
subprocesses beyond `launchctl`/`curl`-equivalents, exits after each tick.

### 2. Identity — a `guardian` ledger seat, `kind: service`, holding `platform`

Not autorefresh's seat: the guardian supervises autorefresh, and a supervisor sharing its
supervisee's identity cannot attribute a remediation to one or the other. Every act — a
refresh, a rollback, an alert, the daily heartbeat — is an attributed team act from the
`guardian` seat (ADR 232). Remediations go through the existing guarded `service
refresh`/`restart` paths, so they inherit build-before-bounce, self-location, and ADR 150
gate visibility. The seat is roster toml in the roster home, reconciled by the daemon — never
a DB edit.

### 3. Recency is a hard rule

Classification keys ONLY on: live `/health`, `launchctl` `last exit`/`runs`, and log lines
newer than the daemon's boot time. Never a raw log tail — the seed records a probe reading
eight-day-old lines out of a 9.5 MB err.log and declaring a live daemon "crashlooping now."
Grep-over-stale-logs pages someone for an incident that ended a week ago; the false alert is
this design's named failure mode (Eval item b).

### 4. Classes and tiers — the initial policy

| Class | Signal (recency-keyed) | Tier | Action |
| --- | --- | --- | --- |
| `publisher_failed` | `~/.musterd/live/build.log` fresh failure, daemon healthy | **auto** | `service refresh --live`; re-probe; recurs <1h → escalate to alert |
| `crashloop` post-refresh | `launchctl` runs climbing + err.log lines newer than boot, within 30m of a refresh | **auto** | restart on the preserved last-known-good build **+ alert** (acts and tells) |
| `daemon_down` (unexplained) | `/health` unreachable + `launchctl` last exit ≠ 0 | alert | notify + ask |
| `schema_drift` / `wrong_db` | `/health.schema` / `/health.db` | alert | notify + ask |
| `error_rate` | `musterd.errors` / 5xx `http_request` lines since boot, above floor | alert | notify + ask |
| `presence_churn` | reaper storm since boot | alert | notify + ask |
| healthy | all clear | — | nothing; heartbeat only |

"Alert" = `musterd notify` (OS push, ADR 035) + an in-band `ask` from the guardian seat to
the `platform` role holder — the seed's "ask the platform agent," landing on a role, exercised
for real for the first time.

**The tier map is team policy, not code** (`musterd team policy`, ADR 150 classes): an admin
flips any class between `observe`/`alert`/`auto` without a release. The table above is the
shipped default; the ADR 152 `--mode idle|notice` knob is the precedent being generalized
(seed Q7, answered narrowly).

### 5. Loop damping

One remediation attempt per class per hour, then forced escalation to alert — a guardian that
bounces a crashlooping daemon every two minutes IS the crashloop. Attempt state lives in a
local stamp file, not the DB (the DB may be the thing that's down). Every action and every
escalation writes an audit row when the daemon is reachable, and always a line to the
guardian's own log when it is not.

### 6. The guardian's own silence must be detectable

Per the wiki's instrument-silence rule: a probe that reports nothing is making a claim. Two
mechanisms: (a) a **heartbeat stamp file** every tick plus one daily in-band heartbeat act, so
"guardian quiet" and "guardian dead" are distinguishable; (b) `musterd service status` (which
since #780 names which server it measured) grows a guardian line: last tick age, last
incident, tier map in force. Install-time control probe: `service --guardian install` ends by
killing nothing but *simulating* a `publisher_failed` classification against a fixture log and
confirming the alert path fires — the instrument observes a control event before its silence
is believed.

## What this is not

- **Not a model actor.** No headless session launcher, no wake machinery. That is the phase-2
  native resident swap (ADR 251 pillar territory), reserved, not built here.
- **Not autorefresh v2.** Build currency stays autorefresh's job; the guardian supervises
  outcomes, it does not duplicate the refresher.
- **Not enforcement.** ADR 227's infra-touch gate stays warn-only; the guardian adds a
  designated toucher, it does not restrict anyone else's.
- **Not a telemetry store.** `error_rate` reads fresh JSON-log tails since boot; the queryable
  store is the batond collector (ADR 082), separate as the seed already said.

## Observability & Evaluation

**Emitted:** guardian audit rows (`guardian.probe`, `guardian.remediated`,
`guardian.alerted`, `guardian.escalated`), the daily heartbeat act, the stamp file,
`service status` guardian line.

**Eval, pre-registered — dataset: guardian audit rows + nick's own discovery reports, first
two weeks armed:**

a. **Incidents detected by the guardian vs discovered by a human first.** The guardian exists
   to make the second number zero; any human-first discovery is a missing class or a broken
   signal, and names its own fix.
b. **False alerts** — an alert on a healthy daemon (the eight-day-old-log ghost). More than
   ~1/week means the recency filters are wrong; fix the filter, never mute the class.
c. **Auto-remediations that stuck vs recurred within the hour.** Recurrence feeds the
   escalation path; a stuck-rate near 1.0 is the evidence an `alert` class could earn `auto`.
d. **Guardian liveness** — heartbeat gaps. Silence without a stamp is an incident of its own.

Two weeks of rows is the review point for promoting/demoting classes via the policy dial —
an admin decision on evidence, not a code change (same posture as ADR 227's hardening ramp).

**Experiment:** none pre-registered. Observational; the classes are too rare on one laptop
for an A/B to mean anything.

## Increments after this one (recorded, not designed)

1. **Native resident swap** — alert sink becomes a phase-2 wake; the model tier (diagnosis,
   draft PRs the steward way) arrives priced under ADR 252.
2. **Class promotion** — evidence-gated via the policy dial (Eval c).
3. **batond collector** (ADR 082) replaces log-tail reads for `error_rate`.

## Blast radius

| Surface | Change |
| --- | --- |
| `packages/cli/src/commands/service.ts` | `--guardian` install/uninstall/status line |
| `packages/cli/src/guardian/` (new) | probe script: classify, remediate, alert, damp, stamp |
| roster home `roles/` + seat toml | `guardian` service seat, `platform` role |
| team policy schema | `guardian_tiers` class map (ADR 150) |
| `docs/wiki/` | guardian runbook page (ADR 259: git as truth) |
| one ADR | this design, decision-frozen |

Unchanged: daemon code (except possibly `/health` exposing boot time if it doesn't already),
autorefresh, the ADR 227 gate, all acceptance/routing machinery.

## Open questions

None blocking. Recorded: whether the daily heartbeat act is noise on a 12-seat roster —
if the team mutes it, the stamp file + `service status` line are the fallback instruments.
