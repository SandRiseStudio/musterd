# 232 — Ledger seats: every actor on the roster

- Status: accepted — increments 1–2 built (`kind: service`, the mskd\_ service-token auth path, the
  kind-keyed exclusions, `service install --auto` token delivery, the tick's in-band bounce
  announcement, and the warn-only census in `init --check`). Increments 3–5 disposed 2026-09-04
  (#1311, lane `01M1MMK3339B06Q328HYWXARJF`): **3 is open** on lane
  `01M1Q9D90XEP9FPCYPQNBFH73Q` — a live defect, five unattributed LaunchAgents and a job-gone check
  that cannot see guardian or streamwatch; **4 deferred** until a team wants a seat for automation
  that is not musterd's own; **5 retracted** — superseded by ADR 241's `wake_lease`, and across 818
  wakes no service has ever caused one. See the dated disposition below.
- Date: 2026-08-05
- Owner: izzo (design session with nick, 2026-08-04/05 — the lane-01KZ7KRG60 session)
- Relates to: ADR 227 (roles — the system this completes and partly re-aims), ADR 230 (the re-eval
  that forced this), ADR 088 (agent = seat, the ontology being extended), ADR 057 (ambient
  presence), ADR 058 (durable-on-git rosters), ADR 060 (verify, don't assume — the census check's
  pattern), ADR 112/131 (the steward and residency), ADR 145/172 (admins are human-only), ADR 152/201
  (the auto-refresher whose governance gap started this), landscape.md §5 (Band's bot-membership
  adjacency), `docs/design/roles-and-stewardship.md` (the seed this session grew from)

## Context

### The contradiction that forced the session

On 2026-08-04, ADR 227 shipped a role system whose thesis is _only designated platform agents touch
running infrastructure_ — and, the same day, the first draft of ADR 230 granted new restart
autonomy to the auto-refresh tick: an actor with no seat, no role, and no identity, which the
ADR 227 infra-gate structurally cannot see (an unbound context is silence by design). The restart
was cut before merge, and the question it exposed became this session.

### The inventory (measured 2026-08-04, `~/Library/LaunchAgents` + workflows)

| actor                   | cadence         | real powers                                                                       | identity | governed by                                 |
| ----------------------- | --------------- | --------------------------------------------------------------------------------- | -------- | ------------------------------------------- |
| wake actuator (`host`)  | 10s poll, alive | **spawns Claude Code / Codex sessions** as seats, with agent keys, spending money | none     | daemon-side policy: leases, cooldowns, caps |
| auto-refresher          | 120s            | `git switch` + build + **restart the daemon** (drops every live session), notify  | none     | its own flags (`--mode`, settle window)     |
| /live publisher         | 60s             | worktree add/prune, fetch, build, **writes the daemon's web-root**                | none     | nothing                                     |
| steward (GitHub Action) | weekly          | opens draft PRs                                                                   | GH token | `contents: read`, draft-only                |
| ADR 166 sweep           | 300s            | read-only sampling                                                                | none     | n/a                                         |
| otel-sink               | alive           | collects telemetry                                                                | none     | n/a                                         |

Three governance regimes, none of them decided — accumulated. And the axis ADR 227 gated
("infrastructure") missed the highest-consequence actor entirely: the wake actuator doesn't touch
infra, it **creates actors**. The real axis is _unattended action with consequences_, and on that
axis the ordering is roughly: spawning agents > restarting the daemon > changing what's served >
opening PRs. The role system governed none of these and gated the one case where a human was
already present at a keyboard.

### The dogfood trap, named (nick's fork in the session)

We were designing from inside musterd-building-musterd, where two genuinely different things
overlap perfectly. For a team using musterd for their _own_ project — an iOS fitness app, say —
they split cleanly:

1. **Platform services** — musterd's own shipped machinery (daemon, auto-refresher, wake actuator,
   /live publisher). The fitness team has these too; they got them from `musterd service install`
   and will never think about them. For them, this ADR is **infra transparency as a product
   feature**: when the daemon bounces mid-standup, "what just happened" is answerable in the stream
   their team already reads, not by knowing what launchd is. Their governance must be a **shipped
   default**, not a design session every team runs.
2. **Project services** — the team's own automation: their CI, the cron deploying their backend,
   the TestFlight push script. This is the general primitive, with exact prior art in **Slack's bot
   users**: a named member, restricted from human things, posting into the room. `deploybot:
"deployed v1.2 to TestFlight ✓"` is not governance machinery from the user's view — it is a
   feature they would ask for. The steward is _our_ instance of this category, not category 1.

Multi-team daemons (the cookoff cells) are a dogfood artifact; a real install is one daemon, one
team. The design must not bake the overlap in.

### Amendment (2026-08-05): §3 was false as built — silence needs an audible baseline

§3 claimed a sending service exercises ambient presence "for free": interval ticks would read
present-with-freshness. Measured on the live machine the day increment 1 shipped: **a healthy
auto-refresher read offline within six minutes of working correctly.** The two decisions collide —
§2 correctly forbids idle-tick chatter, so the bounce announcement turned out to be the seat's
_only_ authenticated call, and ~99% of ticks are no-ops. A quiet roster row therefore carried no
signal at all: it was the steady state of health, not the mark of a wedged cron.

The repair keeps both decisions intact rather than weakening either: every tick that finds the
daemon reachable now makes **one authenticated presence touch** as the service seat — a presence
row, never an envelope, so the message stream stays exactly as quiet as §2 demands. Silence is
signal only once health is audible; the heartbeat is the audible half. An unreachable daemon gets
no touch (there is nothing to touch), so an outage still reads as staleness on the roster. The
touch is best-effort like the announcement: its failure is a log line, never a failed tick.

## Decision

**No action without an actor; no actor without a seat.** The roster becomes the complete census of
actors on a machine — humans, agents, and now services. This subsumes ADR 227's "who touches
infrastructure" rather than replacing it: the infra question was one projection of the census
question, aimed at the attended case.

### 1. Two tiers of seat, doctrinal

- **Peer seats** (kinds `human`, `agent`) — what every seat has been until now: can decline, hold,
  and raise; hold lanes; accept; be woken.
- **Ledger seats** (new kind `service`) — identity, roles, capabilities, attribution, audit;
  **structurally excluded** from lane ownership, acceptance eligibility (ADR 158), wake
  eligibility (ADR 131/191), and handoff. A ledger seat is an accountable actor, never a
  negotiator.

This _sharpens_ the musterd ontology rather than diluting it. The founding argument — "a named
seat can decline; an anonymous worker cannot" — survives because whether an actor can refuse is
now a stated, kind-level fact instead of an unstated assumption. The anonymous-subagent critique
never applied to crons, because crons don't masquerade as teammates; what they lacked was
accountability, and a ledger seat is exactly that and no more.

Kind-keyed behaviors decided at birth (each was a live bug under `kind: 'agent'` reuse): the
roster's _model unattested_ warn facet never fires for services (they attest none, correctly);
services are never acceptors, never wake candidates, and the ADR 172 human-only admin clamp
applies to them as it does to agents.

### 2. Ledger seats speak: `status_update` and `ask`

A comment has been sitting in `service.ts` since ADR 152: _"the team-facing announcement belongs to
the future platform-guardian seat, not this schedule."_ This is that seat.

- **Announcements** land in-band: `status_update` from the auto-refresher — "bounced the daemon on
  `322cd28`, 5 live sessions notified" — in the stream, attributed, replayable.
- **Escalations** become real asks routed to the `platform` holder — chased, audited, answerable —
  for every incident where the daemon is alive to carry them (`publisher_failed`, `build_skew`,
  `schema_drift`, the guardian seed's whole surface). A service reads replies on its next tick:
  even a cron has a slow inbox loop. Service asks ride the **advisory tier** — a cron never holds.
- **OS notification shrinks** to the one incident the daemon cannot carry: its own death (ADR 230,
  unchanged by this ADR).

### 3. Presence is ambient, and silence is signal

No new presence machinery. ADR 057 already derives liveness from real authenticated actions, and a
sending service exercises it for free: KeepAlive services read continuously present; interval ticks
read present-with-freshness. The dividend: **a wedged cron goes visibly quiet on the roster** — the
ADR 230 class of failure (a watcher saying ✓ while dead) partially dissolves, because silence
itself becomes legible, without anyone building a monitor.

### 4. The census has an enforcer — warn-only

`musterd doctor` / `init --check` diffs the machine's musterd-labeled LaunchAgents against the
roster's service seats and **names any unattributed actor** (and any seat whose job is gone). The
ADR 060 verify-don't-assume pattern extended to the census; warn-never-block. Hand-authored plists
walk past `install`, which is exactly why the check exists.

### 5. Identity without a folder

Agent identity flows through a folder binding; the auto-refresher runs in `/Users/nick/agents`,
which is bound to **nick** — today its actions would attribute to the operator, which is the whole
problem in one sentence. Service seats authenticate with **per-seat tokens minted at reconcile**
(the machinery agent seats already use), delivered by `musterd service install` as a 0600 file
whose path rides the plist environment. No binding, no folder, no shared key.

### 6. One model, two consumers, platform first

- **Platform services** get their seats **auto-provisioned by `service install`** — the product
  registers its own machinery, with shipped charters written for users who will never read them.
  The operator never hand-writes `autorefresh.toml`.
- **Project services** — "register your own automation as a teammate" — are a named increment of
  this same model, not a separate system: a seat file, a token, and the team's own charter. The
  fitness team's `deploybot` and our steward are the same shape. Designing category 2 in this ADR
  is what proves the model isn't dogfood-shaped; shipping it waits its turn.

Home roster: the operator's team, declared (revive here). The multi-team daemon case is recorded as
known-open dogfood topology, not designed around.

### 7. What stays decided elsewhere

- **The restart stays out**, pending ADR 230's measured eval. If outage durations don't shorten
  under notify-only, that measurement reopens the question — and by then there is a governed,
  attributed actor to grant it to. Deciding it here on design elegance would repeat the reflex the
  ADR 230 re-evaluation corrected.
- **Attribution before enforcement.** Day one, a service seat buys visibility: roster row, named
  audit rows, infra-gate coverage (the gate's audience widens from "agent seats" to "non-human
  seats"), discovery answering "what runs unattended here". No new gate blocks anything. Autonomy
  tiers as team policy (the seed doc's Q7) remain deferred until a governed actor has produced
  evidence worth constraining.
- **The grandfathered refresh bounce** continues, now attributed. Bringing it under a policy
  surface is the autonomy-tiers decision, not this one.

### Gifts recorded (not commitments)

- Lifecycle `until` on a service seat = **research probes that visibly expire**. The ADR 166 sweep
  should carry one instead of lingering as permanent machinery nobody re-decided.
- The **steward Action can hold the steward seat now** — identity first, runtime migration later —
  giving ADR 112's "wants to become a resident seat" its first step for free.
- Woken sessions can later carry `provenance: woken-by-<service>`, closing the wake ledger's
  who-caused-this gap (recorded for the wake-actuator increment, not built first).

## Increments

1. **`kind: service` + the auto-refresher's seat** — schema + reconcile + token delivery + the
   kind-keyed exclusions; the tick authenticates, announces its bounces in-band, and appears on the
   roster. One actor, chosen because ADR 230 made it the live question.
2. **Census check** in doctor / `init --check`.
3. **Remaining platform services** + `service install` auto-provisioning (wake actuator, /live
   publisher, sweep, otel-sink — the sweep with an `until`).
   Follows-up: 01M1Q9D90XEP9FPCYPQNBFH73Q
4. **Project services** — the registration UX (`musterd service register <name>`-shaped; designed
   from the fitness-team posture, Slack-bot prior art).
   Follows-up: deferred — the first project service anyone actually wants a seat for; concretely, a
   second `kind: service` seat on any team whose job is not musterd's own machinery (2026-09-04)
5. **Wake provenance** — `woken-by-<service>` on presence rows.
   Follows-up: none — superseded by ADR 241's `wake_lease`, and its premise never occurred (2026-09-04)

## Consequences

- The roster stops being a partial cast list. "What runs unattended here?" becomes a query, and
  the answer carries names, roles, and last-acted times.
- ADR 227's infra-gate starts covering the actors that touch infra most — by seeing them, not yet
  by gating them.
- The stream gains machine voices with product value beyond governance: the bounce announcement is
  the first, `deploybot` is the destination.
- A third member kind touches many kind-keyed branches; increment 1 deliberately carries that cost
  for one actor before the pattern is declared safe.
- Two prior ADRs get their aim corrected without being reopened: ADR 227 (the gate was aimed at
  the attended case) and ADR 230 (whose "no identity" objection this answers, without re-answering
  its restart question).

**2026-08-12 — increment 2 landed.** `musterd init --check` diffs musterd-labeled LaunchAgents
(`studio.sandrise.musterd-*`) against roster `kind: service` seats and prints warn-only notes
(never exit-1). The daemon plist (`studio.sandrise.musterd`, no suffix) is the runtime, not a
ledger seat. "Job gone" only applies to the four platform labels increment 3 will auto-provision
(`autorefresh`, `host`, `live`, `sweep`); a project-service seat is not a missing LaunchAgent.
Hand-authored plists are identified by their `Label`, not their filename. Unreachable roster or
a non-darwin host stays silent. The increment-2 eval's fake-plist line is the unit test; zero
unattributed jobs on the live machine waits on increment 3's remaining seats.

**2026-09-04 — increments 3–5 disposed (lane 01M1MMK3339B06Q328HYWXARJF).** Twenty-three days after
increment 2, none of 3–5 had a lane, and `census.ts` carried a comment promising an increment 3 with
no owner. Re-measured rather than assumed, they turned out to be three different things.

*Increment 3 is a live defect and now has its own lane.*
Follows-up: 01M1Q9D90XEP9FPCYPQNBFH73Q
On this
machine at build 064db424, `musterd init --check` names **five** unattributed actors —
`adr260-rerun`, `host`, `live`, `otel-sink`, `sweep` — so increment 2's own exit line ("zero
unattributed jobs on the live machine waits on increment 3's remaining seats") is still unmet. The
sharper finding is the other direction: the job-gone list above was frozen at four labels, and
`guardian` and `streamwatch` shipped afterwards as `kind: service, role: platform` seats with live
LaunchAgents. They are outside `PLATFORM_SERVICE_LABELS`, so if either lost its job the census would
say nothing — and guardian is the daemon watchdog. The list could not grow with the roster, which
reintroduced the "a wedged cron goes visibly quiet" hole this ADR was written to close.

*Increment 4 is deferred with a trigger.* `deploybot` exists as a sentence here, a comment, a test
fixture and a roadmap string; there is no `service register` command and no team has asked for one.
The deferral reopens on the first project service someone actually wants a seat for — a `kind:
service` seat whose job is not musterd's own machinery. Recorded rather than left implicit so nobody
re-discovers it as a gap.

*Increment 5 is retracted, not deferred — superseded by ADR 241.* `woken-by-<service>` was meant to
close the wake ledger's who-caused-this gap. `wake_lease` (ADR 241) closed it better and later:
`claim-handshake.ts` says why in the source — provenance describes a KIND of session, so "two wake
sessions on one seat look identical under it", while a lease correlates a session to the exact wake.
Measured over 818 leases on this machine: 586 name the causing act (and the act names its sender),
210 more carry `edge = dispatch_continuation` naming a lane, 22 residual. And the premise itself
never occurred — the resolvable causers are **581 agent, 5 human, 0 service**. No service has ever
woken a session here, so there is nothing for `woken-by-<service>` to attribute. If that changes —
a service becomes a wake causer — the lease's `act_id` already names it, and this stays retracted.


**2026-09-04 — increment 3 landed (lane 01M1Q9D90XEP9FPCYPQNBFH73Q).** The census now DERIVES its
job-gone set from the roster — every `kind: service` seat holding the `platform` role — and the
frozen four-label literal is gone. The falsifier the lane asked for is the unit test: a platform seat
`census.ts` has never heard of, with no job, is named without anyone editing `census.ts`. `guardian`
and `streamwatch` are covered by construction; so is the next one. `service install --wake | --live |
--sweep` now provision their seats (`host`, `live`, `sweep`) through ONE `provisionServiceSeat`,
which also replaced the three copy-pasted provisioners — the three services that shipped without a
copy were exactly the three the census named. A dated one-shot (`StartCalendarInterval` with a Month
and Day, no `StartInterval` — `adr260-rerun`) has no standing presence to attribute and is named as a
task rather than an unattributed actor, and named again once it has fired and is still installed, so
the census does not warn forever about a job that was never a service. `otel-sink` is a hand-authored
plist with no install verb — hand-authored plists walk past `install`, which is why the check exists
— so its seat is hand-provisioned, once, the same way. Increment 2's exit line ("zero unattributed
jobs on the live machine") is met on this machine once the three installs are re-run and the one
seat is added; the census is still warn-only and stays so.

## Observability & Evaluation

**Traces.** All on existing rails, which is the point of the design: a service seat's actions are
ordinary authenticated traffic — audit rows carry its name, `status_update`/`ask` envelopes land in
the message log, ambient presence derives from the same actions, and the ADR 144 telemetry
attributes per-seat (`musterd.member.id`) with no new instrument. New signals are limited to the
census check's warn lines in doctor/`init --check` output.

**Eval** — dataset: the message log + roster, before/after increment 1. Baseline: today the
auto-refresher's actions appear nowhere in-band (its only traces are `refresh.log` lines and OS
toasts); the roster lists zero of the six unattended actors; and any tick-caused daemon call that
did carry identity would attribute to the operator's folder binding, not the actor.

- **Increment 1 pass:** every daemon bounce the auto-refresher performs appears as an attributed
  in-band `status_update` within one tick of the bounce; its audit rows carry the service seat's
  name and never the operator's.
- **Silence-is-signal pass (rewritten by the 2026-08-05 amendment):** the original criterion —
  "freshness goes quiet within two ticks of `launchctl unload`" — was vacuous, because a _healthy_
  service also read quiet within two ticks (its only authenticated call was the rare bounce
  announcement). The criterion must discriminate, so it is now two-sided: **while the job runs and
  the daemon is reachable, the seat's presence freshness stays within 2× the tick interval; after
  `launchctl unload`, freshness exceeds 2× the tick interval and stays there.** Quiet now implies
  stopped — verified by hand once in each direction.
- **Increment 2 pass:** with all six actors enumerated, `musterd doctor` reports zero unattributed
  musterd-labeled jobs; deliberately adding a fake plist produces exactly one named warn line.
- **Fail worth watching:** service chatter drowning the stream (more than ~1 announcement per
  bounce, or announcements for no-op ticks) — the fix is quieter services, never filtering the
  stream by kind, which would rebuild invisibility one display layer up.

**Experiment.** None pre-registered. The nearest future one is already named in ADR 230: if its
notify-only eval shows outage durations not shortening, the restart question returns — to a
governed actor this time — and that decision should be made against those numbers.
