# 389 — The wedged-daemon recovery policy: the stack sample is the proof, the ladder is the permission, and the restart ships dark

- Status: proposed
- Date: 2026-09-04
- Builds on: [ADR 263](263-platform-guardian-pure-code-on-call.md) (the guardian is pure code on call; remediations shell the guarded `service` verbs and autonomy is a per-class tier), [ADR 232](232-ledger-seats-every-actor-on-the-roster.md) (an unattended actor has a seat and its acts are attributed), [ADR 386](386-a-huddle-convenes-the-seats-it-names.md) (a capability whose trigger has never been observed firing correctly ships dark), [ADR 185](185-sparse-team-policy.md) (sparse policy, defaults applied at read time), [ADR 092](092-same-workspace-successor-ends-predecessor.md) (a session that loses its seat is told `superseded`, and the handler is terminal), [ADR 227](227-roles-as-the-aptitude-layer.md) (an infra touch names its holder), [ADR 337](337-agent-http-session-authority.md) (a session lease is bound to a Presence)
- Lane: 01M1Q9WQP66MZNH5BDH0VD4RZ0

## Context

The daemon can wedge **alive**. On 2026-09-04 big-body caught one: the process up, `/health` timing
out, and a three-second stack sample spending **2,406 of 2,407 samples** inside synchronous
`better-sqlite3` `sqlite3_step`. launchd reported a clean exit and never restarted it, because from
launchd's side nothing died — a `StartInterval` agent that is still running is, to launchd, working.

The guardian already detects this class and may only alert. It does that well: `classify.ts` probes
`/health` three times, then once more on a longer bound, holds the first sighting one tick
(`defer`) so a transient stall cannot raise, checks launchd's exit word, and carries the whole
observation into the raise as `evidence` — every one of those built because an earlier version was
wrong in a way that cost a human's attention. The damper (`damp.ts`) then stops it saying the same
sentence twice.

What none of that does is end the outage. On the day this was measured the inbox carried **12+
`daemon_down` asks**, all `consult/standard`, all to a human — while the machine's coordination
layer was down.

The prevention half shipped separately (#1308, `16b6e3d8`): the wake poll no longer costs seats ×
the whole log, measured 299.5 ms → 131.0 ms on a 20k-message log. That removes the known trigger.
It does not make the class impossible, and it does nothing whatever for a daemon that is already
wedged.

## Problem

May the guardian restart a daemon it can prove is alive-but-unreachable?

Today it may not, and the reason is real: a restart drops live sessions mid-turn, and ADR 232/263
deliberately put the guardian's autonomy under policy rather than judgement. But the current
posture means the coordination layer for the whole machine can be down for ten minutes or more
while a human is asked politely, repeatedly, by a process that could have fixed it.

The question is not "should the guardian be allowed to restart things." It is: **what evidence
makes a restart the right call, who pays when that evidence is wrong, and what stops the wrong call
from being one line of policy away?**

## Decision

### 1. A wedged daemon is its own class, and the stack sample is what creates it

Add `daemon_wedged` to `GUARDIAN_CLASSES`. It is not reachable from `/health` timeouts at all.

The four circumstantial conditions the guardian already establishes — `/health` unanswered across
three attempts, unanswered again on the longer confirming bound, persistence across ticks
(`firstUnreachableAt`), and launchd reporting a clean exit with no restart — are **jointly
insufficient**, because every one of them is equally consistent with *the process went away without
launchd noticing*. That is a different incident with a different remedy, and it is launchd's to fix,
not ours.

Only one observation separates *wedged with the socket still held* from *gone*: a stack sample of
the live pid. So the sample is promoted from evidence-in-the-raise to the **classification
boundary**. A tick reaches `daemon_wedged` only when all four circumstantial conditions hold **and**
a bounded stack sample names a single synchronous frame holding the process.

- **Mechanics.** `sample <pid> 3` against the pid launchd reports: read-only, bounded at three
  seconds, no signal sent, nothing written. The predicate is **≥ 90% of samples in one synchronous
  frame beneath the daemon's own stack** — big-body's incident read 2,406/2,407, so the threshold is
  not tuned to the margin.
- **No sample, no restart.** If the sample cannot be taken — not macOS, the tool absent, permission
  refused, the pid gone between probe and sample — the incident stays `daemon_down` and the guardian
  alerts exactly as it does today. Degradation is toward the current posture and never past it.
- **The sample rides the raise either way.** Whether it promotes the class or not, what it saw is
  written into `evidence` and the audit, because the top frame is the single most useful sentence a
  human can be handed about a wedge.

Why a class and not a policy footnote: a tier attaches to a class. Making the proof standard a
classification boundary means the destructive tier **cannot** attach to an incident the evidence
does not support — the standard is enforced by the type, not by a reviewer remembering it.

### 2. Who pays, and what they are owed

A restart drops every live session on the machine: each loses its in-flight turn, and a session
lease is bound to a Presence (ADR 337), so every lease on that daemon dies with it. That is the
cost, stated plainly so it can be weighed rather than discovered.

**They cannot be warned.** The notice would have to travel through the daemon that is about to be
restarted, which is the one that is not answering. So the guarantee is moved to the other side:

- The guardian writes its intent to the **local stamp before acting**. The stamp is a JSON file, not
  a DB row — already the design, and for exactly this reason: a record kept inside the thing being
  restarted cannot survive the restart it is recording.
- Once the daemon answers again, the guardian posts **one act** naming the restart, the four
  conditions, the sample's top frame, and how many sessions were live when it acted. Every dropped
  session learns why on its next call.
- The eviction the sessions actually experience reuses ADR 092's `superseded` vocabulary rather than
  inventing one. A session losing its seat already has a terminal, non-reconnecting handler; a
  restart is that same event with a different cause, and giving it a second spelling would only
  create a second thing to handle.

### 3. It ships dark, and the tier alone is not enough to arm it

`daemon_wedged` defaults to `alert`, the same as `daemon_down`. Arming it requires
`guardian_tiers.daemon_wedged = 'auto'` in team policy (ADR 185 sparse override, ADR 263 precedent)
— **and that is deliberately not sufficient on its own.** The ladder in §4 is a second, independent
condition.

Two conditions rather than one because a tier is a single line of policy, and an automatic
destructive action should not be one line away from a machine that has never seen it fire. This is
ADR 386's ship-dark reasoning applied to a heavier trigger: there, a capability nobody had watched
work shipped off by default; here the action also destroys work when it is wrong.

### 4. The ladder, and why it is not decoration

Even at `auto`, a restart requires **all** of:

1. the incident has persisted across **three consecutive ticks** — ≥ ~6 minutes at the 120 s
   cadence. The longest event-loop stall yet measured is 77 s (2026-08-24, 16:10:13, against a
   daemon answering `/health` in 1.8 ms minutes later), so three ticks clears the worst observed
   stall by a factor of four. One tick of deferral is already built; this widens it for the
   destructive tier only.
2. a raise **actually reached a human** at least once for this incident. `actOn`'s `raise()` already
   returns whether it did, and a raise the damper suppressed returns `false` and does not count.
3. the escalation is a **changed reason**, not a repeat. The damper withholds an unchanged sentence
   for an hour, so "alert louder" implemented as the same words would be silence; the second-sighting
   raise therefore says something new — that the ladder is now running and what happens next.
4. one restart per hour (`shouldAttempt`, already built). A second wedge inside the window escalates
   instead of acting, because a guardian that bounces a daemon every two minutes **is** the outage.

Condition 2 is the load-bearing one. It makes *"the human had a chance"* auditable from the stamp
rather than asserted in a document — and without it, a machine whose notification path happened to
be broken would restart itself silently, which is precisely the failure the guardian exists to
prevent. A guardian that cannot speak does not get to act.

### 5. The remediation shells the existing verb

The restart is `service restart` through `runService`, never a reimplemented bounce (ADR 263's
rule, and what keeps the guarded verb's own checks in the path). `--force`, because a wedged daemon
cannot answer the live-session guard and the guard failing closed here would preserve sessions that
are already unreachable at the cost of leaving the machine down.

## Observability & Evaluation

**Traces.** Every `daemon_wedged` classification writes `guardian.sampled` to the audit — the sample
verdict, the dominant frame and its share, and whether the class was promoted — and it writes on
every tick that reaches the sample, **armed or not**. The restart path adds `guardian.restarted`
carrying the four conditions, the ladder state (ticks persisted, which raise reached a human), and
the live-session count at the moment it acted. The pre-action intent goes to the local stamp, not the
DB, so it survives the restart it records. Nothing here is new plumbing: `guardian.remediated`,
`guardian.alerted` and `guardian.suppressed` already exist and these join them.

**Eval.** Dataset: the `guardian.sampled` rows accumulated while the tier is still `alert` — the
class is instrumented before it is armed precisely so the arming decision reads data rather than
this document. Baseline: today's posture, measured on 2026-09-04 — 12+ `daemon_down` asks in one
day, zero automatic recoveries, and one outage that outlasted every one of them. The question, first
30 days armed: of the `daemon_wedged` incidents that reached a restart, what fraction were followed
by health returning **and holding for three consecutive ticks**? Prediction, recorded before the
fact: **> 90%**, because the sample establishes the process is alive and blocked, and a restart is a
complete remedy for that state. Counter-metric on the same dataset: sessions dropped per restart. If
the recovery rate holds and the drop count is low, the ladder is right; if drops climb without
recoveries, the proof standard is wrong rather than the ladder.

**Experiment.** The falsifier that must pass before arming — induce the wedge by holding a long
synchronous SQLite transaction against the daemon's own DB, then assert: (a) the classifier reaches
`daemon_wedged` and **not** `daemon_down`; (b) with the sample tool removed from PATH, the same
conditions produce `daemon_down` at `alert` and **never** a restart; (c) with the tier at `auto` but
only two ticks elapsed, no restart; (d) with three ticks elapsed but every raise suppressed by the
damper, no restart. The number that reverses this decision: **one** restart fired against a daemon
that was not wedged — the sample said wedged and health returned on its own inside the ladder window.
One is enough to disarm and re-open the question, because the whole justification is that the sample
is decisive.

## Alternatives considered

- **Circumstantial proof only — the four conditions without a sample.** Rejected: all four are
  equally satisfied by a process that died without launchd noticing, which is a different incident
  with a different owner. Restarting on them would be acting on an inference the evidence does not
  support, and the one distinguishing observation is cheap.
- **A binary instead of a ladder.** Rejected: nothing would make "the human had a chance" auditable.
  The ladder's value is not delay for its own sake — it is that condition 2 leaves a record.
- **A launchd `KeepAlive` watchdog on `/health`.** Rejected: launchd cannot see application liveness,
  which is the entire finding. And a watchdog restart carries none of the proof — it would fire on
  the 3.22 s `/health` tail already measured under load.
- **Fix SQLite contention instead.** Already done, separately (#1308), and it is prevention. It
  removes the known trigger and helps a wedged daemon not at all.
- **Ask a human faster / louder only.** This is the status quo, and the day it was measured it
  produced 12+ asks and an outage that outlasted them.

## Consequences

- One member added to `GUARDIAN_CLASSES` and one sparse tier key. No wire change, no new act, no new
  table, no new endpoint — the class rides the paths `daemon_down` already uses.
- The guardian gains its first **destructive** remediation. `publisher_failed` and `crashloop` are
  both recoveries of something already broken; this one ends live work that was fine. That is why it
  needs two independent arming conditions and a falsifier with a disarm trigger, and why it ships
  dark.
- The guardian tick gains a bounded three-second cost, and only on a tick that has already failed
  four `/health` probes — never on a healthy machine.
- Platform-only: `sample(1)` is macOS. On any other host the class is unreachable and the posture is
  exactly today's. Named as a limit rather than hidden: a Linux host gets no recovery from this ADR.
  Follows-up: deferred — a Linux equivalent (`/proc/<pid>/stack`, `eu-stack`) when a Linux daemon
  host exists (2026-09-04)
- Building the restart is gated on the falsifier above passing and on the eval's first read; the
  classification, the sample, and the instrumentation land first and alert-only.
  Follows-up: deferred — arm `daemon_wedged` only after 30 days of `guardian.sampled` data (2026-09-04)

**2026-09-05 — increment 1 landed, alert-only (lane 01M1Q9WQP66MZNH5BDH0VD4RZ0).** `daemon_wedged`
joins `GUARDIAN_CLASSES` at `alert`; `packages/cli/src/guardian/sample.ts` parses `sample <pid> 3` into
a verdict; the collector takes the sample only on the clean-exit-unreachable shape, against the pid
launchd itself reports. Nothing is armed and no restart exists. Two things the build found that §1
did not spell out, both kept: **wait primitives read as parked, not held** — an idle Node event loop
concentrates ~100% in `kevent`/`uv__io_poll` exactly as a wedged one does in `sqlite3_step`, so a
bare share threshold would hand a quiet daemon whose HTTP server died the destructive tier; the
dominant frame is checked by name, and an unknown frame fails toward a human rather than toward
silence. And **`guardian.sampled` is written to the guardian log, not the audit** — the Observability
section above says audit, but the audit is a POST to the daemon, and the daemon is unreachable at
exactly the moment a sample is taken; a row written there would exist only for the samples that did
not matter. The eval reads the log. Rows accumulate from the first clean-exit-unreachable tick on
this host, where `/usr/bin/sample` is present.
