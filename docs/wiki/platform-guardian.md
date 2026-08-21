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

- Stamp (damping, last tick, last incident, rollback target, policy source): `~/.musterd/guardian/stamp.json`
- Log (every action as `guardian.<action> {json}`): `~/.musterd/guardian/guardian.log`
- Seat token: `~/.musterd/guardian/seat-token` (0600; minted at install, ADR 232)
- Refresh handover: `~/.musterd/autorefresh/handover.json` exists only from a successful refresh build through verified daemon recovery. The guardian defers a confirmed unavailable daemon for at most 30 seconds; a stale, malformed, or future record never suppresses an alert (ADR 274).

Reaching a `daemon_down` classification costs **four** probes, not three, and the fourth is the one that decides. The first three are ADR 274's confirmation, all bounded at 2 s; the fourth is bounded at `CONFIRM_TIMEOUT_MS` (10 s). Three probes on one bound fired inside a single stall are one observation repeated — they restate the measurement under question and say nothing about the rival hypothesis, which is that the daemon is alive and merely slow. Only a different bound separates the two. If the long probe answers, the tick is healthy and no incident is recorded at all; if it fails, the raise names both bounds and both errors.

Two dampers, on the two ways the guardian can become the noise it exists to detect. Both live in the stamp, never the DB, because the DB may be the thing that is down — a count kept inside the thing being watched cannot survive the outage it is counting.

- **Acting**: one remediation attempt per class per hour, then forced escalation to alert.
- **Speaking**: one raise per *unchanged reason* per hour. The key is the raise text, not the class — a different probe error or run count is news a human has not had, and is never withheld. Withheld repeats are counted in the stamp and ride the next raise that fires (`(N identical raises suppressed since …)`), so a persisting outage stays audible and the series is readable.

~~The process was never restarted, so it may still be running and merely too slow to answer. Check /health directly and compare booted_at before treating this as an outage.~~ — the raise's own closing sentence until 2026-08-21, prescribing to a human a check the guardian could run itself, and then raising at standard tier anyway. All six false `daemon_down` alarms of 2026-08-21 carried it. FIXED 2026-08-21: the guardian now runs that check as the fourth probe and the raise reports what it found. (Falsify: `grep -r 'Check /health directly' packages/cli/src/guardian/` — a hit means the homework sentence came back.)

~~Damping is one remediation attempt per class per hour, then forced escalation to alert~~ — true of the acting damper, and wrong as a description of the page's subject until 2026-08-21. `shouldAttempt` was consulted only inside the `tier === 'auto' && remedy !== null` branch, so the **alert tier had no damper at all** and a class that ships as `alert` raised on every tick that classified it: 30 guardian asks all-time carrying 4 distinct bodies, five of them byte-identical inside 33 minutes (2026-08-21 12:18:10 → 12:51:14; falsify: `select count(*), count(distinct body) from messages ... where act='ask'` for the guardian member — a fixed corpus should show the distinct count rising with the total). FIXED 2026-08-21 by the raise damper above.

## Operating it

- Install/arm: `musterd service --guardian install` (Node 22 PATH — the plist embeds `process.execPath`), then `musterd role assign guardian platform` in the roster home. Install ends with `control probe: alert path fired ✓` (2026-08-13; falsify: run the install and read its last line) — without that line, treat the alert path as untrusted and the probe's future silence as no evidence (see [Instrument silence is not evidence](instrument-silence.md)).
- The probe's firing is recoverable after the fact: it appends to `guardian.log` like any tick, so the evidence outlives the install terminal (falsify: `grep 'control probe' ~/.musterd/guardian/guardian.log`). ~~Until #828 the probe printed only to the install command's stdout, so its one firing was unrecoverable — the log began 15:55 against a 15:53 install (2026-08-13)~~ FIXED 2026-08-13 by #828. Re-running the probe is also safe at any time (`musterd service guardian-tick --control-probe`): it is a dry run and leaves the stamp untouched, so it neither burns a damping slot nor fakes an incident.
- Read it: `musterd service status` (guardian line: last tick age, policy source, goes loud `STALE` past 10 minutes) or `musterd service status --guardian`. `policy team` is a successful scoped read; `policy defaults (guardian unprovisioned)` is intentional; `policy defaults — degraded since …` means the policy endpoint is unreadable but shipped defaults remain in force.
- The guardian's own death is detectable: no stamp progress + no daily heartbeat act. A quiet guardian with a fresh stamp is healthy; a quiet guardian with a stale stamp is an incident.

## Traps

- Recency is the hard rule: classification only trusts boot-gated reads (`/health.booted_at`). A probe that greps a raw log tail pages someone for an incident that ended a week ago (observed 2026-07-20 during the ADR 152 work; falsify: feed the tick an old err.log with a fresh mtime and watch `errLinesSinceBoot` — the mtime gate admits it, the boot gate in the daemon's own `booted_at` bounds it).
- The crashloop rollback target is the last HEALTHY tick's `/health.build`. A guardian that never saw the daemon healthy has no target and alerts instead — that is by design, not a bug.
- A damper that only ever silences is indistinguishable from a broken probe. The raise damper is deliberately built so the withheld count is carried forward rather than dropped: if you see one raise per hour with no `suppressed since` line, nothing is being withheld; if you see the line, the count is the series. Silence with no count would be the failure mode this fix was supposed to remove, one level quieter (falsify: run three ticks on one unchanged reason and read `lastRaise.<class>.suppressed` in `~/.musterd/guardian/stamp.json` — it must be 2, not absent).
- /health latency is bursty and load-correlated, which is why the 2 s bound was never a safe sole measurement: 25 samples taken under load on 2026-08-21 gave p50 2.8 ms, p90 16 ms and **max 3.22 s**, while 90 samples taken minutes later on a quiet daemon gave max 0.02 s. `hydrate.ts` records the mechanism — "time any handler holds is time /health waits". Exceeding 2000 ms is normal operation on a busy laptop, not pathology (falsify: loop `curl -w %{time_total} localhost:4849/health` during a live multi-session burst and read the tail, not the median — the median is always fine and is what makes this easy to miss).
- The 10 s confirming bound is a measured guess, not a law: ~3x the worst answer yet observed. Its falsifier is cheap and specific — a `daemon_down` raise whose confirming probe failed, on a daemon a later /health read shows was healthy throughout. That has not been seen; if it is, raise the bound rather than removing the probe.
- Suppression is per reason, not per incident: the raise stops repeating, the incident does not stop existing. An open unanswered `daemon_down` ask still means the daemon may be down. Adjudicate the ask; do not read the quiet as recovery.
