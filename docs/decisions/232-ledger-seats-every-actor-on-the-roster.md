# 232 — Ledger seats: every actor on the roster

- Status: accepted — increment 1 built (`kind: service`, the mskd_ service-token auth path, the
  kind-keyed exclusions, `service install --auto` token delivery, and the tick's in-band bounce
  announcement); increments 2–5 open
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
4. **Project services** — the registration UX (`musterd service register <name>`-shaped; designed
   from the fitness-team posture, Slack-bot prior art).
5. **Wake provenance** — `woken-by-<service>` on presence rows.

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
  name and never the operator's; the roster shows the seat with ambient freshness that goes quiet
  within two ticks of `launchctl unload` (verified by hand once — the silence-is-signal check).
- **Increment 2 pass:** with all six actors enumerated, `musterd doctor` reports zero unattributed
  musterd-labeled jobs; deliberately adding a fake plist produces exactly one named warn line.
- **Fail worth watching:** service chatter drowning the stream (more than ~1 announcement per
  bounce, or announcements for no-op ticks) — the fix is quieter services, never filtering the
  stream by kind, which would rebuild invisibility one display layer up.

**Experiment.** None pre-registered. The nearest future one is already named in ADR 230: if its
notify-only eval shows outage durations not shortening, the restart question returns — to a
governed actor this time — and that decision should be made against those numbers.
