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

And when all four fail with launchd reporting a clean exit and no restart — the shape every false positive to date has worn — the first sighting still does not raise (2026-08-24, ADR 274 amendment). A 77 s event-loop stall outlasted every within-tick bound that day, so the deciding observation is now separated in *time*, not by a longer timeout: the tick records `pendingDownSince` in the stamp and logs `guardian.down_deferred`; the next tick (~120 s later, longer than any stall yet measured) raises if `/health` is still unreachable, with the persistence in the evidence; a healthy tick logs `guardian.stall_recovered` with the measured span and clears the pending state (falsify: block the daemon's event loop >12 s across one tick and watch the log — a deferred line then a recovered line, no ask in the stream). A nonzero launchd exit or crashloop still raises in the same tick.

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

## Adjudicating a `daemon_down` raise

Three of thirty raises have been adjudicated (2026-08-19, and two on 2026-08-21); all three were false. The other 27 are unresolved, **not** presumed false — the whole hazard of a noisy instrument is that it trains its readers to clear on sight, and clearing on sight is what makes the one true raise dangerous.

The test, in order:

1. **Read `/health` now.** If it answers, note `booted_at`.
2. **Did `booted_at` move after the raise?** If no, the daemon never restarted and the raise is false. Done.
3. **If yes — do NOT stop here.** Check autorefresh's stream for a `bounced the daemon on <sha>` in that window. A deliberate bounce moves `booted_at` exactly as a death does (2026-08-21; falsify: compare `booted_at` either side of any announced bounce — `f588c85` at 14:38:01 against booted_at 14:38:00.362). If a bounce explains the move, the raise is still false.
4. **Only an unexplained move is evidence of a real outage.**

~~If booted_at moved after the raise, the daemon really died~~ — the recorded test until 2026-08-21, and it would have called that day's seventh false alarm a real outage: raise 14:33:54, booted_at 14:38:00, moved — but autorefresh bounced at 14:38:01 and the daemon had been up since 14:13:37. AMENDED 2026-08-21, ledger entry [2026-08-21-booted-at-cannot-see-a-bounce](../claims/entries/2026-08-21-booted-at-cannot-see-a-bounce.md).

Whatever the verdict, **write the evidence, not the conclusion** — a raise cleared without a recorded reason is indistinguishable from one cleared on sight, which is the habit this instrument's history is made of.

## `daemon_wedged` — the class only a stack sample can make (ADR 389, 2026-09-05)

The classifier's clean-exit-unreachable branch takes a bounded `sample <pid> 3` of the pid launchd itself reports, and promotes to `daemon_wedged` only when ≥90% of the **main thread** sits in ONE frame that is not the event loop's own poll (falsify: `classify()` with `stack: { taken: true, wedged: true }` and a persisted `firstUnreachableAt` yields `daemon_wedged`; the same signals with `stack: { taken: false }` yield `daemon_down`). ~~A wait primitive as the dominant frame (`kevent`, `uv__io_poll`, `mach_msg_trap`…) reads as parked, not held~~ — corrected 2026-09-05 by the falsifier's live run: only the LOOP'S poll (`uv__io_poll`/`kevent`/`epoll_wait`/`poll`/`select`) is parked. A real SQLite wedge bottoms out in `nanosleep → __semwait_signal` inside the busy handler, a wait primitive by any name, and it is a wedge — the loop is not polling. #1328's wider idle list called it wedged only because `__semwait_signal` was unlisted while `nanosleep` was listed (falsify: `parseSample(LIVE_WEDGED)` in `sample.fixtures.ts` — a captured report — must read `wedged: true` with `entry.image` `better_sqlite3.node`). An idle event loop still concentrates just as hard as a wedged one, and that is still the one direction this class must never be wrong in. Ships at `alert`; the tier alone does not arm a restart and no restart is built.

ADR 389's four-arm falsifier lives in `packages/cli/src/guardian/falsifier.test.ts` and passed on 2026-09-05. Arm (a) is LIVE where `/usr/bin/sample` exists — it spawns a lock holder and a blocked writer and runs the real tool through `runSampleTool`, the tick's own runner — and is skipped, not faked, elsewhere. `sample(1)` is not permission-gated on this laptop (the synthetic fixture's note that it was has been retired); it takes 2.1–2.35 s for a 2 s window standalone and exceeded 7 s once inside a parallel vitest run, which is why the post-sample grace is 15 s (falsify: time `sample <pid> 2 -file /dev/null` against a blocked node process). Without `-file`, `sample` writes a second copy of every report to `/tmp/<name>_<date>.sample.txt`.

`guardian.sampled` is written to the **guardian log, not the audit** — on every tick that reached the sample, promoted or not. ADR 389 said "audit"; the audit is a POST to the daemon, which is unreachable at exactly the moment a sample is taken, so a row written there would exist only for the samples that did NOT matter. The eval that decides arming reads the log (falsify: `grep guardian.sampled ~/.musterd/guardian/*.log` after any clean-exit-unreachable tick).

## Traps

- Recency is the hard rule: classification only trusts boot-gated reads (`/health.booted_at`). A probe that greps a raw log tail pages someone for an incident that ended a week ago (observed 2026-07-20 during the ADR 152 work; falsify: feed the tick an old err.log with a fresh mtime and watch `errLinesSinceBoot` — the mtime gate admits it, the boot gate in the daemon's own `booted_at` bounds it).
- The crashloop rollback target is the last HEALTHY tick's `/health.build`. A guardian that never saw the daemon healthy has no target and alerts instead — that is by design, not a bug.
- A damper that only ever silences is indistinguishable from a broken probe. The raise damper is deliberately built so the withheld count is carried forward rather than dropped: if you see one raise per hour with no `suppressed since` line, nothing is being withheld; if you see the line, the count is the series. Silence with no count would be the failure mode this fix was supposed to remove, one level quieter (falsify: run three ticks on one unchanged reason and read `lastRaise.<class>.suppressed` in `~/.musterd/guardian/stamp.json` — it must be 2, not absent).
- /health latency is bursty and load-correlated, which is why the 2 s bound was never a safe sole measurement: 25 samples taken under load on 2026-08-21 gave p50 2.8 ms, p90 16 ms and **max 3.22 s**, while 90 samples taken minutes later on a quiet daemon gave max 0.02 s. `hydrate.ts` records the mechanism — "time any handler holds is time /health waits". Exceeding 2000 ms is normal operation on a busy laptop, not pathology (falsify: loop `curl -w %{time_total} localhost:4849/health` during a live multi-session burst and read the tail, not the median — the median is always fine and is what makes this easy to miss).
- The 10 s confirming bound is a measured guess, not a law: ~3x the worst answer yet observed. Its falsifier is cheap and specific — a `daemon_down` raise whose confirming probe failed, on a daemon a later /health read shows was healthy throughout. ~~That has not been seen; if it is, raise the bound rather than removing the probe.~~ SEEN 2026-08-24: a ~77 s stall (`quietest_busy_ms` 77 150, the event-loop starvation arc) failed the 10 s confirm against a daemon answering 1.8 ms minutes later — and the prescribed remedy was wrong too, because no within-tick bound outwaits an arbitrary stall. The repair is cross-tick deferral for the clean-exit shape (ADR 274 amendment 2026-08-24), not a larger bound.
- `quietest_busy_ms` in `/health` is NOT a latency proxy, and reading it as one will make you distrust a healthy daemon. Measured 2026-08-21 with six live sessions and `quietest_busy_ms: 78350`: 30 samples of /health gave p50 1.9 ms and max 2.19 s. It tracks long-lived connection age (websockets held open), not how long a handler holds (falsify: sample /health latency while that field reads tens of seconds — if the samples track it, this is wrong and the confirming probe's bound is too low).
- Suppression is per reason, not per incident: the raise stops repeating, the incident does not stop existing. An open unanswered `daemon_down` ask still means the daemon may be down. Adjudicate the ask; do not read the quiet as recovery.
