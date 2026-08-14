# ADR 263: The platform guardian, increment 1 — pure code on call

- Status: accepted (2026-08-13) — increment 1; the model tier is deliberately deferred
- Deciders: nick, izzo (design session 2026-08-13; spec
  `docs/superpowers/specs/2026-08-13-platform-guardian-design.md`, PR #799)
- Relates to: ADR 152 (autorefresh — the actor this guardian supervises), ADR 232 (ledger seats,
  `kind: service`), ADR 227 (`platform` role; warn-only infra gate), ADR 150 (team policy),
  ADR 035 (`musterd notify`), ADR 251/131 (native residency — the reserved model tier),
  ADR 252 (wake cost — why increment 1 spends none), ADR 259 (wiki runbook)

## Context

Nothing watches the daemon. Autorefresh (ADR 152) owns build currency and self-heals its known
holes, but `daemon_down`, `crashloop`, `schema_drift`, `wrong_db`, `error_rate`, and
`presence_churn` are discovered by a human noticing. The roles reexamination (2026-08-13) found
the guardian was the one ADR 227 wishlist item whose premises had changed: ADR 232 answered
responsibility, ADR 251 made a priced model tier a real future target, and the seed's
local-presence constraint is satisfied by a LaunchAgent probe.

## Decision

1. **A third LaunchAgent, outside everything it watches** (`studio.sandrise.musterd-guardian`,
   ~120 s interval, `musterd service --guardian install|uninstall|status`). A watcher inside the
   daemon cannot see `daemon_down`; one inside autorefresh cannot supervise autorefresh. The
   lifecycle reuses the autorefresh module; the tick is `service guardian-tick`.
2. **Pure code, end to end.** Zero model calls — healthy or during an incident. The model tier
   (off-script diagnosis, draft fix PRs) arrives later by swapping the alert sink for an ADR 251
   resident wake, priced under ADR 252. Probe, classes, policy dial, and seat identity survive
   that swap unchanged.
3. **A `guardian` ledger seat** (`kind: service`, `platform` role, token file riding the plist
   env — ADR 232 §5). The guardian supervises autorefresh, so it cannot share autorefresh's
   identity. Unprovisioned = OS notify still fires; in-band half degrades silently.
4. **Recency is a hard rule.** Classification keys only on live `/health` (which now exposes
   `booted_at`), `launchctl` `last exit`/`runs`, and log reads gated on the boot instant — never
   a raw tail. The 8-day-old-log ghost (seed, 2026-07-20) is the named failure mode.
5. **Auto-remediate the safe classes, alert the rest.** `publisher_failed` → `service refresh
   --live`; post-refresh `crashloop` → `service refresh --pin <last healthy /health.build>
   --force` **and** alert (acts and tells). Every other class: OS notify + an in-band `ask` from
   the guardian seat. The tier map is team policy (`musterd team policy --guardian-tier
   <class>=<observe|alert|auto>`), sparse over shipped defaults — an admin flips a class without
   a release (the ADR 152 `--mode` knob, generalized).
6. **Damping**: one remediation attempt per class per hour, then forced escalation to alert;
   state in a local stamp file, never the DB (the DB may be what is down).
7. **The guardian's own silence is detectable**: per-tick stamp + daily in-band heartbeat;
   `service status` renders last-tick age and goes loud past 10 minutes; install ends with a
   control probe — a fixture incident through the real alert path, dry-run — so the instrument
   observes a caused event before its silence is believed.

## Alternatives rejected

- **A model-driven on-call session now** — builds a throwaway headless launcher, spends paid
  wakes on an 8 GB machine, and duplicates what ADR 251 phase 2 will do properly.
- **Probe inside the daemon or autorefresh** — cannot see its host die.
- **Alert-only (no auto tier)** — forfeits deterministic fixes for the two classes whose
  remediation needs no judgment.
- **A queryable telemetry store for `error_rate`** — that is the batond collector (ADR 082),
  separate; the probe reads boot-gated log tails until it exists.

## Observability & Evaluation

**Traces:** structured guardian log lines (`guardian.remediated` / `guardian.alerted` /
`guardian.escalated` / `guardian.observed`, one JSON-detail line each — there is no
client-writable audit endpoint, so the guardian's ledger is its log plus its attributed in-band
acts), the daily heartbeat act, the stamp file, the `service status` guardian line.

**Eval** — pre-registered; dataset: the guardian log + the message stream + nick's own discovery
reports, first two weeks armed:

1. Incidents detected by the guardian vs discovered by a human first — the second number is the
   one the guardian exists to zero; any human-first discovery names a missing class or signal.
2. False alerts (an alert on a healthy daemon). More than ~1/week ⇒ the recency filters are
   wrong; fix the filter, never mute the class.
3. Auto-remediations that stuck vs recurred within the hour; a stuck-rate near 1.0 is the
   evidence an `alert` class could earn `auto` via the policy dial.
4. Guardian liveness: heartbeat/stamp gaps — silence without a stamp is an incident of its own.

**Experiment:** none — the classes are too rare on one laptop for an A/B to mean anything. The
two-week read is the review point for tier changes; each is an admin policy flip on evidence
(the ADR 227 hardening-ramp posture).

## Consequences

- `/health` gains `booted_at` (additive; no FEATURE_EPOCH bump — probe-facing, not a client
  capability). `service refresh` gains `--pin <ref>`. Team policy gains `guardian_tiers`.
- Runbook: `docs/wiki/platform-guardian.md`. Arming is a deliberate step (`service --guardian
  install` + `musterd role assign guardian platform` in the roster home), not a side effect of
  merging this.
- The guardian's alert path is the first real exerciser of "ask the platform agent" — the
  role-addressed demand ADR 227's discovery eval has been waiting to observe.

- **2026-08-13 — the tier dial reaches the probe** (izzo, lane `01KZYNQHQ7`; Decision untouched).
  First armed tick revealed the full-policy read is admin-only (it carries the secret webhook), so
  the guardian's service seat fell back to shipped defaults every tick and `--guardian-tier` was a
  dial connected to nothing. Fixed with the `/enforcement` precedent: `GET
  /teams/:slug/guardian-tiers`, a scoped member read of the one non-secret sub-field; the tick now
  reads it and the per-tick "tiers unreadable" line fires only on genuine failure.

- **2026-08-13 — the control probe's firing became durable** (izzo, lane `01KZYW6YJW6HCH`; Decision
  untouched). §7 ends install with a control probe so the instrument observes a caused event
  *before* its silence is believed — but the probe wrote only to the install command's stdout, and
  only scheduled ticks get the plist's redirect into `guardian.log`. So the one firing that
  licenses reading the next two weeks of silence as health left no trace (miley, accepting lane
  `01KZY2014`: the log begins 15:55, the install ran 15:53). That is uncitable from the Eval's own
  declared dataset above — "the guardian log + the message stream + nick's own discovery reports"
  names three places, and terminal scrollback is none of them. The probe path now appends to
  `guardian.log` in the same `guardian.<action> {json}` shape. It stays a dry run: it writes no
  incident or damping state, which is what keeps re-running it safe — a property now pinned by
  test rather than left to convention. Re-running was the cheaper alternative considered and
  rejected: a probe re-run on 2026-08-27 attests the instrument *then*, not the window being read.
