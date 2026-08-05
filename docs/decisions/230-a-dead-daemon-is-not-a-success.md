# 230 — A dead daemon is not a success

- Status: proposed
- Date: 2026-08-04
- Owner: izzo (holds `platform`, ADR 227)
- Relates to: ADR 118/130 (`service refresh`), ADR 152/201 (the auto-refresher owns the bounce),
  ADR 205 (reuse the healthy baseline — the transient-miss lesson), ADR 035 (`musterd notify`),
  ADR 071 (the audit log), ADR 227 (the `platform` role this is the first automated increment of),
  `docs/design/roles-and-stewardship.md` (the guardian seed sketch)

## Context

The auto-refresher is the only unattended actor on this machine's running infrastructure: every 120
seconds (`StartInterval`, verified on the installed plist) it probes `/health`, compares the daemon's
build against `origin/main`, and bounces under a quiet-period policy. It is the closest thing the
team has to a platform guardian.

Its first act is to fetch `/health`. If that throws, it does this:

```ts
} catch {
  ok('daemon unreachable — nothing to refresh');
  return 0;
}
```

A ✓, and exit 0. Measured on the live machine, 2026-08-04, from `~/.musterd/autorefresh/refresh.log`:

| signal                                            | count                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `✓ daemon unreachable — nothing to refresh` ticks | **1,136**                                                                    |
| contiguous outage blocks                          | **29**                                                                       |
| block lengths (ticks → elapsed at 120s)           | 3 → ~6 min, 4 → ~8 min, 6 → ~12 min, 13 → ~26 min, plus two very long blocks |

So the machine's only watcher of prod has reported success, more than a thousand times, in the
exact condition it exists to notice. Nobody was misled by a wrong _fact_ — the line is literally
true, the daemon was unreachable and there was indeed nothing to refresh. The defect is that
"nothing to refresh" is the report of a **healthy no-op**, and it is being used for an **outage**.
Same glyph, same exit code, same log shape as the 8,000 ticks where everything was fine.

Two of the 29 blocks are very long and the older log lines carry no timestamps (stamping arrived
with #631), so elapsed time is inferred from the verified tick interval rather than measured
directly for those; they may include periods when the daemon was deliberately stopped. The short
blocks are the honest signal, and they are enough: **six to twenty-six minutes of prod being down
during ordinary working hours, with an automated watcher awake, running, and saying ✓.**

This is precisely the hole the platform-guardian seed describes (`roles-and-stewardship.md`), and
the seed's own answer — a new probe agent that wakes a headless session on an incident — is more
machinery than the evidence calls for. The watcher already exists. It already runs every two
minutes. It already knows. It just calls it success.

## Decision

**The auto-refresh tick distinguishes "down" from "nothing to do", and escalates the first one.**
No new agent, no new LaunchAgent, no tokens spent while healthy.

### 1. Confirmation — two independent sources, never one probe

A single failed probe **never** escalates. ADR 205 exists because a transient miss during a normal
boot produced a false failure report; repeating that mistake here would fire a notification during
every ordinary bounce and train the operator to ignore the one channel that matters.

Escalation requires both:

- **two consecutive** failed `/health` probes — at the 120s tick, ~4 minutes of continuous absence;
  the run counter persists across ticks, because each tick is a separate `launchd` invocation with no
  memory of the last. It lives in **its own file** (`autorefresh/.outage`), deliberately _not_ in the
  existing attempted-tip stamp: writing TDD tests for this surfaced that sharing one slot would let
  an outage clobber the broken-`main` build debounce, so a daemon that died mid-build-attempt would
  come back and rebuild a known-broken tip every tick. Two lifetimes, two files. **and**
- **`launchctl` agreeing** the daemon job is not running healthily — an independent source, not a
  second opinion from the same one.

Either alone is a shrug: a daemon mid-restart fails a probe while launchctl is content, and that is
normal, not an incident.

### 2. Escalation — tell the human once, then stand down. No self-restart.

On confirmed-down: `musterd notify` (ADR 035) + its ledger line, naming the fix
(`musterd service restart`), and then **stand down** until the outage ends. One notice per outage
block — a watcher that re-notifies every two minutes is an alarm the operator learns to silence.

**Re-evaluated 2026-08-04 (nick + izzo), and the restart came out.** The first draft of this ADR
had the tick attempt one `kickstart` before notifying, argued as "strictly less than the bounce it
already performs routinely." The argument was true and still lost, because it answered the wrong
question. ADR 227 shipped, the same day, a system whose thesis is _only designated platform agents
touch running infrastructure_ — and this tick has no seat, no role, and no identity. The infra-gate
cannot even see it: an unbound context is silence by design. Granting new restart autonomy to the
one infra-touching actor the role system structurally cannot cover would have made the role
machinery a rule for everyone except the actor that acts most often. Detection and notification are
observability and grant nothing; the restart is an **autonomy grant**, and autonomy grants flow
through the automated-actors-under-roles design (the seed doc's autonomy-tiers-as-team-policy
question, now due for its own session) — or not at all. The tick's _existing_ refresh-path bounce
is untouched: it predates this ADR and is grandfathered exactly until that design says otherwise.

**There is deliberately no audit row here, and the reason is structural:** the ADR 071 audit log
lives _inside the daemon_, so an outage is exactly the event it cannot record. Reaching for it would
either fail silently or make the escalation depend on the thing being escalated about. The durable
record of a daemon outage is therefore the operator-owned file — `refresh.log`, which is itself
bounded and retained by ADR 224 — and that is the honest place for it. If daemon-down events ever
need to reach the team's governance record, they must be _back-filled after recovery_, not written
during the outage; that is a separate decision and is not made here.

### 3. What it must not do

**Never spend a wake.** Waking a seat costs real money, and a woken seat coordinates _through the
daemon_ — the thing that is down. Escalation to a live platform-holding seat stays a later
increment, gated on evidence that notification alone leaves outages open.

**Never widen its remit here.** The seed's fuller incident surface — `crashloop`, `build_skew`,
`publisher_failed`, `schema_drift`, `error_rate`, `presence_churn` — stays captured in the seed doc
and lands later as promotions of _this_ seam, not as a second watcher racing this one.

## Consequences

- The guardian arrives as a repair to an actor that already exists rather than a new resident
  agent — detection and notification only, with every later power (self-restart first among them)
  deferred to the automated-actors-under-roles design so the role machinery is never a rule for
  everyone except the most frequent actor.
- One behavioural change an operator will notice: a genuinely-down daemon now produces exactly one
  OS notification per outage — naming the fix — where previously it produced silence.
- The tick keeps its no-token-when-healthy property. Nothing here runs a model, and nothing here
  gained the power to restart anything.
- `refresh.log` gains a legible outage record, which is what makes the evaluation below possible at
  all — the current log cannot distinguish its own worst hour from its best.

## Observability & Evaluation

**Traces.** Two signals, both on rails that already exist and — per the Decision — both _outside_
the daemon, because the daemon is the thing that is down: a stamped `refresh.log` line naming each
stage of the ladder (`one failed probe, waiting for a second` / `launchctl reports the job running —
holding off` / `daemon down (confirmed …) — notified the operator, standing down` / `still
unreachable — already notified this outage`), and the `musterd notify` push, which
leaves its own ledger line (#631's fix) so a reported notice can be checked against the log that
caused it. Each rung is a distinct string on purpose: the whole defect being fixed is one message
covering several different states.

**Eval** — dataset: `~/.musterd/autorefresh/refresh.log` itself, baselined by the measurement in the
Context table (1,136 unreachable ticks / 29 blocks / longest short block 13 ticks). Re-measure after
two weeks:

- **Pass:** every contiguous unreachable block resolves to exactly one notification line — and
  **zero** blocks end with a bare `✓ nothing to refresh`, which is the whole defect. Block _duration_
  should shorten too, because the operator now learns at minute ~4 instead of whenever they next
  look; if it doesn't, that is the evidence the deferred restart autonomy waits for, and it goes to
  the automated-actors-under-roles design with numbers attached.
- **Fail (fix the confirmation, not the threshold):** a notification fires during an ordinary bounce
  window — meaning two consecutive probes plus launchctl was still too weak a test, and the answer is
  a stronger confirmation, never a longer silence. Second failure mode: more than one notification
  inside a single block, meaning the stop rule leaked.

**Experiment.** None pre-registered — the change is a repair with a measured baseline, not a
hypothesis. The one live check worth running by hand after merge: stop the daemon deliberately,
watch two ticks, confirm exactly one notification arrives and the following tick stands down. That
rehearsal is also the honest test of the stop rule, which no unit test can prove about `launchd`.
