# 179 — Board-triggered work-order wakes: composable scoped loops

- Status: proposed — 2026-07-28. Authored by stanley from a brainstorm with nick the same day.
  Rewritten in place 2026-07-29 from a second brainstorm with nick — legal while proposed
  (`change-adr:check` gates only accepted Decisions, [ADR 180](180-review-after-bugbot.md)), and the
  last cheap moment to do it. Number **179** — verified free at branch time; highest on
  `origin/main` at rewrite time is 182.
- Date: 2026-07-28; rewritten 2026-07-29
- Builds on: [ADR 131](131-harness-residency-wake-ledger-host.md) (the wake ledger + `musterd host`
  actuator this ADR extends), [ADR 169](169-two-stage-close.md) (`ready_for_review`, verified-ness,
  `pickReviewCounterpart` — the review leg this ADR makes real), [ADR 147](147-human-ask-stream.md)
  / [ADR 153](153-ask-reachability-gated-hold.md) (asks — the escalation leg, already complete, and
  the degradation path for unreachable actors), [ADR 048](048-plan-goal-work-item-model.md) /
  [ADR 049](049-orientation-and-handoff.md) (the orientation spine that lets a fresh session
  self-orient), [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) /
  [ADR 128](128-recipient-scoped-message-reads.md) (the injection bar every composed line honors),
  [ADR 106](106-unified-git-workflow.md) (the merge this ADR finally actuates),
  [ADR 112](112-steward-seat.md) (the `propose` / `auto-merge` autonomy knob, generalized here),
  [ADR 158](158-model-attestation-truth.md) / [ADR 172](172-model-family-posture.md) (`wake_pool` —
  the reviewer source — and the risky-lane human-review rule), [ADR 166](166-session-liveness-by-enumeration.md)
  (the ended-cleanly signal the continuation edge needs), [ADR 026](026-harness-tool-environment.md)
  / [ADR 027](027-non-invasive-harness-coexistence.md) / [ADR 030](030-provision-manifest.md) /
  [ADR 031](031-codex-adapter-scope.md) (the provisioning-adapter ancestry the harness contract
  section is careful **not** to conflate with actuation), [ADR 180](180-review-after-bugbot.md)
  (`gates` as the only required check; the advisory CI reviewer this ADR must distinguish from a
  verified close), [ADR 181](181-reviewer-sees-whole-files.md) (live evidence for keeping lane-state
  semantic sets consolidated in `@musterd/protocol`).

## Context

The founder's highest-throughput day to date (2026-07-28: 40 merged PRs, 27 lanes, 190 acts from
four seats) was steered entirely out-of-band: **23 manually started fresh sessions**, ~40 disposable
`web-*` board sign-ins, in-session "check messages" relays, and a merge authorization on every PR —
while he sent **zero** musterd acts. The coordination layer carried the agents' traffic perfectly
and the human's traffic not at all; his load is real, measurable only in its side effects, and
invisible in the tables built to record it.

The target loop — agent starts a task → works, escalating via asks → `ready_for_review` → a
counterpart reviews, plus a human where required → close, merge, clean up → queue the next item →
start it in a fresh session — is **~70% shipped already**. Asks, two-stage close, reviewer routing,
the orientation spine, seat memory, and a production-grade wake actuator all exist. What is missing
is three wires and a repair:

1. **Wake eligibility reads the inbox, never the board.** A wake fires only on a waiting directed
   act; nothing connects "a lane needs a seat" to the actuator.
2. **The wake line is a doorbell, not a work order.** `composeWakeLine` can only say "you have
   mail," and the woken run is reply-only.
3. **The reviewer is never woken.** `pickReviewCounterpart` requires a live counterpart; on the same
   query it computes `wake_pool` — the offline seats that would restore diversity — and returns
   `null` beside it. Result: the review-catch rate is structurally zero (3 of 3 live `lane_ready`
   uses self-closed in seconds with no ask routed).
4. **The rail itself is dead.** The last observed wake run failed 3/3 on an expired `grant_id` and
   exhausted; `wake_leases` had zero rows on the 190-act day.

### What one day of trying taught us (2026-07-29)

The original text scoped "repair the rails" as a small parallel chore — "no design, ships first."
One day of investigation proved the rails were not merely dead but **quietly wrong in five-plus
independent ways**, each invisible until someone looked: the expired-grant silent exhaustion
(lane `01KYQ913P5N8SNERVSZ56NV0W3`); woken sessions running a frozen 2026-07-23 musterd 0.3.1 —
autorefresh covers the daemon, not the binary a wake's hooks resolve (lane
`01KYQMM141SSC5DEYC8NSX8WQW`); a real mid-session seat drop hiding behind the same error string as a
benign misreport, in two distinct faults (lanes `01KYQBSD93YAD198FCT2T7BW5C`,
`01KYQCF678TC29ARGWRFD2H4A5`) beside an auto-refresher quiet-period guard that has never once fired
(lane `01KYQP9VMTDH3GZ9PZP2Z9NAY9`); model attestation reading the *neighbour's* transcript — fixed
the same day (#506, lane `01KYQN5EXP0DMRVKSDC6YCDQ39`); `delivery_hint` emitting zero hints on the
190-act day (lane `01KYQ9175S7YNVH4FSK8TWJXVT`); ~45 junk `web-*` members and stale departed-seat
claims (lane `01KYQ91AWP66ZSQDYBB2M3WTKP`); and attribution gaps (lane
`01KYQ91DKAKWWCK5HFRP4AH1PH`). The repair was the arc's real content, and this rewrite restates it
as a **gate**, not a footnote.

The second brainstorm also replaced the architecture. The original increments implied one
monolithic automatic loop assembled in stages. The rewrite decomposes it into **composable scoped
loops** — each defined as *trigger state → routing rule → outcome states*, chained by board
transitions. There is no big-loop object anywhere: the end-to-end loop is **emergent**, never
stored — [ADR 048](048-plan-goal-work-item-model.md)'s standing bet, applied to the loop itself.
A rejected review, for example, is not a feature of the review loop; it is a board transition the
dispatch loop already handles.

Two outside facts shaped the rewrite. First, the field named this territory: "loop engineering"
was coined ~June 2026 as the practice of designing agentic loops rather than prompting steps; the
positioning section below states where musterd's loops sit in that vocabulary and what we borrow.
Second, nick flagged that everything built so far is Claude-Code-shaped; the harness actuation
contract section makes the coupling explicit and bounded.

## Decision

Extend the ADR 131 wake machinery — unchanged in its lease, rate-limit, verify, watchdog, and
reporting layers — with **scoped loops** built on **work-order wakes**: wakes derived from lane
state, carrying a lane id, running under the seat's own tool policy, behind toggles that default
off. Loops ship in this order: **the gate → the dispatch loop → the review loop → the merge loop**,
with per-loop observability throughout.

### The three-verb loop interface

Every loop — these three and any future one — is confined to exactly three verbs:

1. **Observe** board and act state.
2. **Wake** a named seat with a work-order carrying a **lane id only**.
3. **Move** a work item between states in response to a seat's act.

A loop never injects instructions into a session, never chooses *how* work gets done, and never
acts on a seat's behalf. This is the ADR 131 §7 needle restated per-loop — loops route work
*between* named, attested actors who can decline, hold, or raise an ask; they do not script what
happens *inside* a session, which is the intra-task-orchestration trap musterd positions against.
It also keeps the [ADR 128](128-recipient-scoped-message-reads.md) injection bar structural: the
work-order's composed line carries the seat, team, and lane id — never a lane title, never free
text — so no agent-authored text ever enters a spawn prompt. Every future loop proposal is tested
against these three verbs.

All musterd loops are **hook loops** in the field's taxonomy — triggered by board-state
transitions, never by timers. There is no heartbeat loop and no cron loop here, by doctrine: the
daemon runs no clocks on anyone's behalf (ADR 131 §7, [ADR 147](147-human-ask-stream.md)).

### Loops are code, for now

Each loop ships as a musterd feature behind the three-verb interface — not as a declarative
definition a team authors. The plug-and-play loops-as-data layer (a loop registry, a trigger
vocabulary, user-installable definitions) was considered and deliberately deferred: abstracting a
vocabulary before 2–3 real loops exist would invent it rather than observe it. The reevaluation
trigger is written down here: **after the dispatch, review, and merge loops have run under
per-loop observability, the recorded trigger vocabulary decides whether loops-as-data earns
building.** Two seeds are planted now at near-zero cost: the per-team per-loop enable switch (see
Toggles), and an implementation rule — trigger edges are factored into **named trigger functions**,
not additional branches in the single ~290-line lane PATCH block
(`packages/server/src/transport/http.ts`); those function names are the first draft of the
eventual vocabulary.

### The gate — repair the rails

**No loop ships while the gate is open.** Every loop below actuates through the wake rail, and the
rail is known-broken; building `flow: auto` on it would automate a mechanism we know is wrong. The
ledger, with the board lanes as the join key:

| Gate item | Lane | Status (2026-07-29) |
| --- | --- | --- |
| Woken sessions run a frozen Jul-23 musterd 0.3.1 (autorefresh misses the wake path) | `01KYQMM141SSC5DEYC8NSX8WQW` | claimed (stanley) — first |
| Wake-grant expiry is silent: surface on roster/doctor, re-mint, verify one live wake | `01KYQ913P5N8SNERVSZ56NV0W3` | open |
| Seat drop A — join succeeds, next call says never joined | `01KYQBSD93YAD198FCT2T7BW5C` | open |
| Seat drop B — restarted adapter reads unclaimed forever | `01KYQCF678TC29ARGWRFD2H4A5` | open |
| Auto-refresher quiet-period guard has never fired (113/113 force-bounces) | `01KYQP9VMTDH3GZ9PZP2Z9NAY9` | open |
| `delivery_hint` emitted zero hints on a 190-act day | `01KYQ9175S7YNVH4FSK8TWJXVT` | open |
| Roster hygiene — stale departed-seat claims, ~45 junk `web-*` members | `01KYQ91AWP66ZSQDYBB2M3WTKP` | open |
| Attribution gaps — worktree without seat git identity, trailer drift | `01KYQ91DKAKWWCK5HFRP4AH1PH` | open |
| Attestation read the neighbour's transcript | `01KYQN5EXP0DMRVKSDC6YCDQ39` | **done** (#506) |
| Retire dolly — no successful session since 07-14, every wake watchdogs out | roster action, no lane | decided (nick) |

The grant-expiry fix has a named shape: `residency status` today checks grant *presence*, never
validity, and `doctor` has no residency check at all — `validateGrant`'s `expired` / `revoked`
reasons must reach both surfaces, so a dead rail is loud within one poll cycle. Dolly's retirement
is a roster action, not a debug lane — `musterd team remove` per [ADR 019](019-team-remove.md)
(tombstone; history survives; revivable) — and drops the seat from `wake_pool` consideration. The
neighbour-attestation fix landing the same day the ledger was drawn is the existence proof that the
gate converges.

### The dispatch loop

*Trigger:* a lane in `claimed` whose owner is an enrolled, offline, `flow: auto` seat.
*Route:* work-order wake to the owner. *Outcome:* the owner's session works the lane.

One routing rule, two trigger edges, shipped in order:

- **Handoff edge (first).** A lane newly owned via `lane_handoff` is already a directed act, so the
  existing inbox-derivation path in `claimWakeLeases` yields the candidate — only the derivation
  label (`work_order`) and the composed line change (`composeWakeLine` grows an exported lane-id
  arm). No doctrine change and no schema change: the human (or a teammate) queues; execution
  automates.
- **Continuation edge (second — the chaining primitive).** An enrolled `flow: auto` seat that owns
  a `claimed` lane (not `blocked`, not `ready_for_review`), has **no live session**, and is under
  caps, derives a fresh-session work-order wake. This edge has no triggering act, and that is where
  the schema bites: `wake_leases.act_id` and `WakeOrderSchema`'s act fields go
  nullable/polymorphic **here, not before** — that PR touches `packages/protocol/src` and cites
  this ADR per [ADR 180](180-review-after-bugbot.md)'s `change-adr:check`. "No live session" needs
  the clean ended-cleanly signal: the SessionEnd capture (`ended_at`) plus
  [ADR 166](166-session-liveness-by-enumeration.md) enumeration **outrank** the 10-minute
  transcript-mtime guard — and the fix lands in the *deciding* branch (the enumerated path in
  `liveness.ts` currently ignores `ended_at` entirely while the demoted slot path honors it),
  otherwise every wake is vetoed for 10 minutes after every clean exit. Whether the ended-cleanly
  signal also moves daemon-side (today `recordSessionAttestation` lands only `start`; the liveness
  predicate lives host-side, one layer below the derivation) is open at implementation.

The end-of-session ritual — `team_memory_save`, claim your next lane, `status_update`, end — ships
as guidance in the primer and skill, because hooks remind and never act as the agent (ADR 049).
[ADR 100](100-harness-hook-memory-reinforcement.md) (SessionEnd memory auto-save) stays its own
separate proposal.

Work-order wake mechanics, all edges: the composed line is "lane `<id>` is yours — orient via
`team_next` and begin" — the board is the work order; the wake is the doorbell with a lane id on
it. Work-order wakes run `tool_policy: 'seat-policy'` — the workspace's own permission settings
govern, and the wake path still never passes a skip-permissions flag (ADR 131 §6, asserted by argv
tests). They get their own watchdog knob (`work_timeout_ms`, default 30 minutes — a coding
session, not a reply) and their own rate caps; `budget_usd` stays advisory per the honesty clause
(flags, never kills). One coupling is named rather than discovered: the host's own `--timeout`
ceiling (default 5 minutes) clamps every policy timeout today, **silently** — a 30-minute
work-order under a 5-minute host ceiling runs 5 minutes. The clamp must become loud (or the
ceiling per-derivation) the day this loop ships.

### The review loop

*Trigger:* a lane enters `ready_for_review`. *Route:* a reviewer — live counterpart, else woken
from `wake_pool`, human where required. *Outcomes:* a confirm closes the lane verified; a
send-back returns it to the owner.

When `pickReviewCounterpart` finds nobody live and `teamFamilyPosture().wake_pool` is non-empty,
the ready edge emits a work-order wake for the best cross-family candidate; the review ask already
waits in their inbox. One design point is settled here: `wake_pool` today lists offline seats with
no family attached (family is read from *live* presence rows only) and the `lane.ready_for_review`
audit stores only the pool's count — so "best cross-family candidate" needs a **durable family
source**, proposed as the seat's last-attested family from audit history (observation, aged, never
a declaration). Risky lanes are untouched by this loop's wake: [ADR 172](172-model-family-posture.md)
already requires a *human* reviewer there, on the `blocking` tier.

**The reject edge costs nothing.** A send-back moves the lane to `claimed` — and a `claimed` lane
with an offline `flow: auto` owner is precisely the dispatch loop's trigger. The needs-fix wake is
not implemented by the review loop; it is emitted as a board state the dispatch loop already
handles. This is the composition payoff, and the reason there is no needs-fix machinery anywhere
in this ADR.

**The circuit breaker ships with this loop, not later.** The known failure mode of composed loops
is the ping-pong: a lane bouncing `claimed` ⇄ `ready_for_review` forever, burning wake spend on a
disagreement no wake will resolve. A per-lane loop-fire counter trips after N bounces (N settled at
implementation) and raises a **blocking** `ask` to a human instead of another wake — the loop
stops, the humans decide, and the failure is recorded (`ask.raised`, breaker detail) rather than
amortized into spend. A tripped breaker never wedges the lane: the ask resolves per
[ADR 147](147-human-ask-stream.md)/[153](153-ask-reachability-gated-hold.md) like any other.

The worker's ≤5-minute self-close window stretches while a reviewer wake is in flight — the exact
contract is settled at implementation, but silence-after-a-failed-wake must still degrade to the
sanctioned self-close; never a wedge ([ADR 145](145-human-role-refounded.md)). The review-catch
rate and the no-candidate rate, first-class metrics per the ADR 169 amendment, go from
structurally-zero to measured.

### The merge loop

*Trigger:* a **verified** close (closer ≠ owner at close — the only kind the review loop makes
routinely possible). *Route:* unrisky ⇒ actuate the merge; risky ⇒ a human. *Outcome:* merged and
cleaned up, or an answered ask.

An **unrisky** lane auto-merges — the closing agent runs the one git workflow
([ADR 106](106-unified-git-workflow.md): squash, auto, delete branch), cleans up, and attests
`git.pr_merged`. A **risky** lane raises an `approve` ask to a human on the **`blocking` tier**
(15-minute hold — [ADR 172](172-model-family-posture.md)'s risky-lane rule, which postdates and
sharpens this ADR's original "Gate-B-style" phrasing), whose accept releases the merge. "Unrisky"
means no declared risk tag **and** no derived risk: a new team-policy map from surface globs to
implied risk tags closes the hole that risk is self-declared today — observation outranks
declaration ([ADR 158](158-model-attestation-truth.md)'s rule, applied to risk).

The merge loop is **independently installable** — a team may enable review without merge, running
the review loop for a week while merges stay manual, then flip merge on. That is the trust ramp:
loop by loop, never all at once. One tension is named explicitly: since
[ADR 180](180-review-after-bugbot.md), an advisory CI reviewer (Haiku, rolling PR comment) exists —
but it is not a musterd seat, so it can never produce a `verified` close under
[ADR 169](169-two-stage-close.md). The merge loop's precondition is satisfiable only by the review
loop or a human reviewer; CI commentary does not open the merge gate. Open at implementation:
whether the closer or the owner merges, and what `authorized_by` records on an auto-merge.

### Per-loop observability

Work-order wakes ride the existing `residency.*` audit family; because `AuditAction` is a closed
union, the loop and derivation ride `detail.derivation` on existing rows rather than new verbs,
and `deriveWakeMetrics` learns to parse it. Ordering constraint, stated so nobody builds it
backwards: per-derivation rate caps can only split **after** the `residency.woke` /
`residency.wake_failed` detail carries the derivation — caps read history. `/board` and
`team_report` surface: wakes by loop and outcome, sessions chained, review-catch and no-candidate
rates, circuit-breaker trips, auto- vs asked-merges, and per-seat daily spend — all derived from
audit rows. This section is doubly load-bearing: it is the operational dashboard *and* the
instrument that decides the loops-as-data reevaluation.

### The toggles

Two knobs, two meanings — **the seat is the unit of trust; the loop is the unit of installation**:

- A per-seat residency policy field `flow: 'manual' | 'auto'`, default `'manual'`. At `manual`,
  behavior is bit-identical to today. `auto` is opt-in per seat via the existing residency policy
  surface (team default ⊕ sparse per-seat override), set by an admin, audited like any policy
  change. This is the per-seat kill switch.
- A per-team, per-loop **enable switch** (dispatch / review / merge, each independently). A loop
  that is not enabled derives nothing, for any seat. This is the install unit, the mechanism of the
  loop-by-loop trust ramp, and the seed of the eventual declarative layer.

A wake fires only where both agree: the loop is enabled on the team *and* the target seat is
`flow: auto`.

### The harness actuation contract

Everything above actuates through one seam, and today that seam has exactly one implementation.
Naming the contract keeps the coupling bounded without building a second harness prematurely.

A **loop-capable harness** provides three signals, anchored on the `ActuatorBackend` seam
(`packages/cli/src/host/backend.ts`) — deliberately distinct from the *provisioning* adapter seam
(`Harness` in `packages/cli/src/onboard/harness.ts`, [ADR 026](026-harness-tool-environment.md)–[031](031-codex-adapter-scope.md)),
which shares only the harness id string:

1. **Wake** — start or resume a session headlessly from a one-line prompt.
2. **Liveness** — report session-alive and ended-cleanly ([ADR 166](166-session-liveness-by-enumeration.md)
   already frames enumeration as per-harness).
3. **Attestation** — evidence of what model ran ([ADR 158](158-model-attestation-truth.md)'s
   `observeModel` already ships this contract evenly across harnesses).

Claude Code provides all three today (`backends/claudeCode.ts`). The contract is written with a
second harness's documented capabilities on the desk, not implemented: Codex CLI offers `codex
exec` / `codex exec resume <id>` (wake), rollout JSONL under `~/.codex/sessions/` plus a
`session_index.jsonl` with per-session status (liveness), and model records in the rollout stream
with session-source hooks (attestation) — all three signals exist on paper, which is the evidence
the contract is not a Claude-shaped fiction. A harness that cannot wake (Cursor's GUI-first
surface) is not excluded: routing work to a seat on a wake-incapable harness degrades exactly like
routing to an unreachable human — [ADR 153](153-ask-reachability-gated-hold.md)'s hold/strand
machinery, notify out-of-band, never a wedge. Capability tiers, not a compatibility wall. The
contract stays a section of this ADR and is extracted to its own ADR only when a second harness
becomes real.

### Positioning: loop engineering

The field named this territory "loop engineering" (~June 2026) and its pattern catalogs — ReAct,
Reflection, Evaluator-Optimizer, Multi-Agent Supervisor — are almost entirely **intra-session**:
cycles inside one agent run, or an orchestrator scripting anonymous workers. musterd's loops are
**inter-actor**: they route work between named seats with model attestations and the right to
decline, and the human is a first-class route target, not an exception handler. We borrow two
things the catalogs got right — the **circuit breaker** (stagnation halts to a human, above) and
**external validation outranks self-assessment** (a merge fires on a verified close, never on the
worker's own say-so). We reject two — the supervisor pattern (an orchestrator over anonymous
workers is the trap itself) and intra-session reflection loops (the harness's business; the
three-verb interface forbids loops from reaching inside a session at all).

### Open at implementation

Deferred deliberately, each with its home named: daemon-side placement of the ended-cleanly signal
(dispatch loop, continuation edge); the loud-clamp vs per-derivation host timeout ceiling
(dispatch loop); the exact durable-family derivation for offline `wake_pool` ranking (review
loop); the self-close-window stretch contract while a reviewer wake is in flight (review loop);
the circuit-breaker bounce count N (review loop); closer-vs-owner merge and `authorized_by` on
auto-merge (merge loop).

## What deliberately does not change

- **No orchestrator, no runtime, no daemon timers.** The daemon derives candidates; the host
  actuates; the agent owns every clock and every decision about *what* to do — a woken session
  orients from the board and may decline, release, or raise an ask like any other session. The host
  executes reachability policy; it never decides work (ADR 131 §7's needle, threaded the same way —
  the three-verb interface is that needle restated per-loop).
- **No auto-pick from open lanes.** An idle seat is never woken because unowned work exists. Every
  work-order wake traces to a directed act (the handoff edge) or the seat's own recorded intent
  (the continuation edge). The "wake whoever for whatever is open" design was considered and
  rejected: it breaks the directed-act doctrine and needs an assignment concept that does not
  exist.
- **The ask leg.** ADR 147/153 already cover escalation, hold, and strand; a woken session uses them
  unmodified.
- **Verified-ness, risk, loop state stay derived**, never stored (ADR 048's standing bet).
- **Attribution invariants**: ADR 109 git identity, ADR 101/158 model attestation, ADR 150 gates
  all apply to woken sessions exactly as to attended ones — a work-order wake carries provenance
  `wake` like any other.

## Observability & Evaluation

**Traces.** Work-order wakes ride the existing `residency.*` audit family, distinguishable by
derivation (`immediate` / `batched` / `work_order`) and, within `work_order`, by loop
(`detail.derivation`), so every series below is a read-side projection over rows that already
exist or extend them: wakes by loop and outcome, review-catch and no-candidate rates (verified
closes ÷ `lane_ready` uses, and the ADR 169 amendment's denominator honesty), circuit-breaker
trips, merge audit coverage (`git.pr_merged` rows ÷ merges), and per-seat wake spend from
`residency.wake_cost`. The failure signals are the same rows read the other way: exhaustion and
watchdog kills trending up per seat, woken sessions that burn budget without a lane-state
transition, breaker trips concentrating on one lane or one seat pair, auto-merges on lanes that
later revert. `budget_usd` flags per the honesty clause; `flow` is the per-seat kill switch and
the per-loop enable is the per-team one. The gate's repair is itself instrumented: the
expired-grant failure mode was silent for a day — after the repair, a dead rail must be loud on
roster/doctor within one poll cycle.

**Eval.** Dataset: the preserved 2026-07-28 telemetry snapshot — 23 manual fresh-session starts,
190 acts, 27 lanes, 40 merges of which 9 audited, review-catch 0/3, zero wake leases. That day is
the baseline; the same queries re-run over a comparable flow-day with `flow: auto` on are the eval.
Pre-stated success: (a) manual session starts drop toward single digits; (b) review-catch leaves
zero without a human staging a reviewer; (c) every loop merge is attested; (d) the founder's
out-of-band steering (disposable `web-*` sign-ins, in-session relays) visibly shrinks. Mechanism
correctness is tested, not monitored: argv tests keep asserting no skip-permissions flag on any wake
arg builder, and the continuation-edge derivation gets a through-DB test that a live session vetoes
the wake.

**Experiment.** Two contrast axes, both natural A/Bs. Per seat: `flow: auto` flips one seat at a
time, so each flow-day yields within-team contrast between auto and manual seats on the success
metrics above. Per loop: the enable switches stage the hypotheses so each is falsifiable alone —
the review loop tests "a woken reviewer produces verified closes at acceptable spend" *before* the
merge loop bets merges on it; if the review loop's catch rate stays near zero or its spend is
ugly, the merge loop is not enabled. The same staging feeds the loops-as-data reevaluation: the
recorded trigger vocabulary across three shipped loops is the dataset that decision reads.

## Consequences

- The founder's manual loop — start session, paste context, relay nudges, restart — becomes: hand a
  lane to a seat (or let the seat queue its own next), and watch the board. The paste ritual was
  already obsoleted by the orientation spine; this ADR obsoletes the restart ritual.
- The trust step is real and is taken per seat and per loop, never globally: a work-order wake is a
  genuine coding session under workspace permissions, where today's wake is a bounded reply-only
  doorbell. The mitigations are the two toggle defaults, per-derivation rate caps, the watchdog,
  the circuit breaker, advisory budget, and the unchanged ask/strand machinery.
- The review loop must land before the merge loop can ever fire: auto-merge requires a verified
  close, and verified closes require a reviewer who can actually be produced — a bar the ADR 180
  advisory CI reviewer explicitly does not clear.
- Two-stage close stops being theater the day the review loop ships — and starts costing real wake
  spend, which per-loop observability makes visible.

## Related

- Supersedes nothing. Extends ADR 131 (wake), ADR 169 (review), ADR 112 (autonomy knob). Rewritten
  in place 2026-07-29 while still proposed; [ADR 180](180-review-after-bugbot.md) and
  [ADR 181](181-reviewer-sees-whole-files.md) are acknowledged in-body, and
  [ADR 182](182-the-writer-validates-what-the-reader-parses.md) is the freshest of the gate-adjacent
  rail fixes.
- The lanes-phase2 items this overlaps (`role-pool auto-assignment`, `auto-done on merge`) remain
  deprioritized as designed there; the merge loop's actuation is close-driven, not merge-watching.
- The board lanes titled "ADR 179 inc 0 — …" predate this rewrite and read as gate-ledger items;
  the lane ids in the gate table are the join key, and the title drift is cosmetic.
- [ADR 100](100-harness-hook-memory-reinforcement.md) (SessionEnd memory auto-save) and
  [ADR 176](176-the-team-home.md) (team home) proceed independently.
