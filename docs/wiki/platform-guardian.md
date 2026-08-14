# Platform guardian

The pure-code on-call probe (ADR 263): what each incident class means, where its state lives, and how to operate it.

## What it is

A LaunchAgent (`studio.sandrise.musterd-guardian`) running `musterd service guardian-tick` every ~120 s. Pure code — it never spends model tokens. It auto-remediates two classes and alerts (OS notify + in-band `ask` from the `guardian` service seat) on the rest. Spec: `docs/superpowers/specs/2026-08-13-platform-guardian-design.md`.

## Classes and default tiers

| Class | Meaning | Default tier | Remediation |
| --- | --- | --- | --- |
| `publisher_failed` | fresh /live build failure, daemon healthy | auto | `service refresh --live` |
| `crashloop` | daemon down + climbing runs within 30 m of a refresh | auto | `service refresh --pin <last healthy build> --force`, plus an alert |
| `daemon_down` | `/health` unreachable, no refresh to blame | alert | — |
| `schema_drift` / `wrong_db` | `/health` schema/db differ from expectations | alert | — |
| `error_rate` | ≥25 5xx/`musterd.errors` lines since boot | alert | — |
| `presence_churn` | reaper storm since boot | alert | — |

Flip a tier without a release: `musterd team policy --guardian-tier daemon_down=auto` (or `off` to clear all overrides). Sparse overrides sit over the shipped defaults.

## State and logs

- Stamp (damping, last tick, last incident, rollback target): `~/.musterd/guardian/stamp.json`
- Log (every action as `guardian.<action> {json}`): `~/.musterd/guardian/guardian.log`
- Seat token: `~/.musterd/guardian/seat-token` (0600; minted at install, ADR 232)

Damping is one remediation attempt per class per hour, then forced escalation to alert — state in the stamp, never the DB, because the DB may be the thing that is down.

## Operating it

- Install/arm: `musterd service --guardian install` (Node 22 PATH — the plist embeds `process.execPath`), then `musterd role assign guardian platform` in the roster home. Install ends with `control probe: alert path fired ✓` (2026-08-13; falsify: run the install and read its last line) — without that line, treat the alert path as untrusted and the probe's future silence as no evidence (see [Instrument silence is not evidence](instrument-silence.md)).
- The probe's firing is recoverable after the fact: it appends to `guardian.log` like any tick, so the evidence outlives the install terminal (falsify: `grep 'control probe' ~/.musterd/guardian/guardian.log`). ~~Until #828 the probe printed only to the install command's stdout, so its one firing was unrecoverable — the log began 15:55 against a 15:53 install (2026-08-13)~~ FIXED 2026-08-13 by #828. Re-running the probe is also safe at any time (`musterd service guardian-tick --control-probe`): it is a dry run and leaves the stamp untouched, so it neither burns a damping slot nor fakes an incident.
- Read it: `musterd service status` (guardian line: last tick age, goes loud `STALE` past 10 minutes) or `musterd service status --guardian`.
- The guardian's own death is detectable: no stamp progress + no daily heartbeat act. A quiet guardian with a fresh stamp is healthy; a quiet guardian with a stale stamp is an incident.

## Traps

- Recency is the hard rule: classification only trusts boot-gated reads (`/health.booted_at`). A probe that greps a raw log tail pages someone for an incident that ended a week ago (observed 2026-07-20 during the ADR 152 work; falsify: feed the tick an old err.log with a fresh mtime and watch `errLinesSinceBoot` — the mtime gate admits it, the boot gate in the daemon's own `booted_at` bounds it).
- The crashloop rollback target is the last HEALTHY tick's `/health.build`. A guardian that never saw the daemon healthy has no target and alerts instead — that is by design, not a bug.
