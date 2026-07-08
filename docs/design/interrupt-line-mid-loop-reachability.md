# The interrupt line — mid-loop reachability for a busy agent

**Status:** design direction. Captured 2026-07-02 from a live brainstorm off a Qoder solutions-architect
demo failure Nick witnessed; **amended 2026-07-03 after the zoom-out round** (residency classes, the
`challenge` act, the injection-surface security requirement, bounded-staleness/coherence framing — see
the arc: [brainstorm-arc-reachability-to-ontology.md](./brainstorm-arc-reachability-to-ontology.md),
and the position doc: [agent-ontology.md](./agent-ontology.md)). The failure diagnosis is empirical; the
design is decided-in-principle and **increments 1–3 are shipped** (ADR 088 the interrupt line, ADR 103
steer/challenge/defer, ADR 111 plan epochs + stale-plan detection — see §8); increment 4 (the
steering-latency metric) is the last rung. This is the next rung on the reachability ladder
([ADR 046](../decisions/046-agent-side-reachability.md)
/ [053](../decisions/053-inbox-reaches-blocked-agent.md) / [054](../decisions/054-wake-on-message.md)) —
the one none of them reach.

**One line:** *A busy agent loop is deaf. Steering that arrives after the agent has already acted on a
stale assumption is rework. musterd's job is to turn every tool-call boundary into an interrupt point —
so a change of direction reaches a working agent in seconds, not minutes — and to make stale work
detectable when the interrupt misses.*

---

## 1. The session that produced this

At a talk, a Qoder solutions architect ran a live demo: a **master agent** coordinating a team of
sub-agents. The topology was **hub-and-spoke** — sub-agents could talk only to the master, never to each
other. During the demo, with many sub-agents all working fast and in-loop:

- A steering change (from the user, or a direction change originating in one agent) could **not reach the
  other agents in time** — they were busy in their own loops.
- The master was itself busy and became the single point through which every re-direction had to fan out.

The result: **stale assumptions, incompatibility between agents' outputs, and work that needed rework at
the end.** This is the canonical multi-agent-orchestration failure, and it is the same failure our own
P3 dogfood measured from the other side ([lanes-and-the-multi-agent-tax.md](./lanes-and-the-multi-agent-tax.md):
wasted work ≈ **37%** of code produced, of which one dependency-revert was **53%** — i.e. one agent built
against an assumption another agent had already invalidated).

---

## 2. Two failures, kept separate

The demo broke on two compounding failures. Keeping them separate matters, because musterd already
solves one and the other is the new frontier.

### 2a. Topology failure (already solved)

Hub-and-spoke. Every direction change fanned out *through* one busy node. musterd's peer-to-peer directed
acts dissolve this: the agent whose interface changed messages the affected agent **directly**, no master
in the path. This is the **"team not swarm"** thesis — coordination between already-separate peers, not
orchestration of sub-agents under a hub.

### 2b. Reachability failure (the frontier)

Even with a perfect message fabric, **a busy agent loop is deaf.** The directed act lands at the seat
instantly; the *model* does not see it until its next inbox check — which is minutes of stale-assumption
work away. No topology fix touches this. This is the missing rung.

### The reachability ladder

| agent state | reach mechanism | status |
|---|---|---|
| **idle**, nothing to do | `inbox --wait` blocks on the watch WS, wakes on arrival | ✅ ADR 054 |
| **heads-down**, running musterd commands | per-command stderr nudge from the waiting-act predicate | ✅ ADR 046 |
| **blocked** on an approval prompt (frozen loop) | route the act through the **human** (OS push) | ✅ ADR 053 |
| **offline**, session exited | external `claude --resume <id> -p '…'` resurrection | 🔲 unbuilt — upgraded to strategic, see below |
| **busy mid-loop**, doing its own work | *nothing* | ❌ **this doc** |

**The ladder is indexed by harness residency class** ([agent-ontology.md](./agent-ontology.md) §4).
Turn-scoped harnesses (Claude Code, Cursor) need all of this machinery. **Resident** harnesses
(OpenClaw, Hermes — always-on gateway processes) solve *wake* by architecture but **not interrupt**:
they serialize runs per session, so a steer arriving mid-run queues behind the in-flight run — the
deafness survives as queue latency, and interrupt policy is still needed at the gateway. And the
"offline" rung generalizes into a strategic claim: a seat's binding can hold the harness session id so
the daemon resurrects the session on a directed act — **musterd gives turn-scoped harnesses residency**
("musterd makes any harness always-on").

ADR 053 explicitly conceded that "pull-based inbox surfacing … cannot reach a frozen loop." The *busy*
loop is the sibling case 053 named but did not solve: not frozen on a prompt, but heads-down inside a
long turn of its own tool calls. It is arguably the **most common state of a productive agent**, and
today it is the least reachable.

---

## 3. The unlock: tool-call boundaries are interrupt points

The Qoder architecture treated a busy agent as opaque. It is not. In Claude Code — and Cursor rules, and
any hook-bearing harness — **hooks fire on every tool call, mid-turn, and hook output is injected into the
model's context.** A busy agent may run dozens of tool calls in a single long turn. Each one is a place
where the outside world can put a line in front of the model **without the model's cooperation**.

This is, almost literally, a CPU interrupt: the loop is running, but at each instruction boundary we can
check an interrupt line and, if raised, hand the model a message before it continues.

### 3.1 The primitive: `musterd inbox --interrupt-check`

A sub-50ms local query to the daemon: *"is there an urgent, interrupt-class directed act waiting for this
seat?"*

- **No** → silent exit, zero output, no disruption.
- **Yes** → one line to stdout, e.g. `⚡ june: interface changed — stop using the v1 schema (check inbox)`.

It rides the same waiting-act predicate ADR 046 already built for the per-command nudge — this just
**extends the nudge from "musterd commands only" to "every tool call the agent makes."** No wire change;
the daemon already knows what is waiting.

### 3.2 The delivery: `musterd init` wires it as a PostToolUse hook

Provisioning *is* the product surface. `musterd init` already writes the SessionStart hook and the skill
across harnesses ([ADR 060](../decisions/060-verify-provisioning-not-assume.md); ADR 085 layered guidance surface, on main).
It adds a **PostToolUse hook** that runs `inbox --interrupt-check`. Zero agent cooperation required — the
model sees the interrupt line at the next tool boundary, typically **seconds** into stale work rather than
minutes, and can pivot.

Degrade gracefully: where a harness's hook story is thinner (Cursor today), fall back to the ADR 046
per-command nudge. Where there is no hook surface at all, the ladder's other rungs still apply.

---

## 4. Severity, or the interrupt is just noise

The immediate failure mode: broadcast journal chatter interrupting deep work is **worse** than deafness —
you would trade rework for thrash. The interrupt line must be scarce by construction. We already have the
pieces.

### 4.1 Who may interrupt, and with what

**Notification tiers ([ADR 044](../decisions/044-notification-tiers-localhost.md)) + `can_flag_urgent`** (P2
governance) gate *who* can raise the line and *what* qualifies. Default bar: **only urgent-tier directed
acts and steering acts interrupt.** Everything else waits for the natural task-boundary inbox check. This
is the same downgrade-and-deliver machinery P2 already ships.

### 4.2 A first-class steering act

Today "change of direction" is a free-text `message`. Give it semantics — an `act: steer` (or
`status_update` with `meta.supersedes_plan`) that:

- **Always clears the interrupt bar** — steering is definitionally interrupt-class.
- **Supersedes prior direction** via the [ADR 017](../decisions/017-newest-session-wins.md) `superseded`
  primitive — so an agent that wakes late sees **only the current** direction, never a contradictory
  stack of stale instructions. Expiry-vs-preemption is already our validated domain; this is **preemption
  applied to plans**, not just messages.

### 4.3 A `challenge` act — question, don't dictate (added 2026-07-03)

Steering is directive. The zoom-out surfaced a third, *epistemic* verb: **challenge** — "justify this
task/assumption or reconsider it." It forces revalidation without prescribing the answer; it is
peer-shaped (a human or an agent can challenge anyone); it is warn-never-block by construction; and it
is the Co-Gym finding operationalized — humans-as-peers steer *thinking*, not just tasks. A `challenge`
must be answered with evidence (an `accept` carrying justification, or a plan change). Together with
plan mutation on the Goal spine (defer/reprioritize verbs on `next_goal`), the steering vocabulary
becomes: **reorder/defer** (plan mutation) · **steer** (directive, interrupt-class) · **challenge**
(epistemic, tier-configurable).

### 4.4 The interrupt line is an injection surface (added 2026-07-03) — requirement, not follow-up

A hook that injects teammate-authored text into a working agent's context mid-turn is a textbook
prompt-injection vector: a malicious or compromised seat could steer every busy agent on the team.
Mitigations belong in **increment 1**, not bolted on later:

- Only seats with the interrupt capability (`can_flag_urgent`, P2 governance) can raise the line.
- The injected line is **daemon-composed** — sender + act + reference ("check inbox") — never the raw
  message body.
- Sender identity is always displayed, so the model can weigh the source.

Governance turns out to be the security model for interruption: tiers are not just noise control, they
are *who is allowed to grab the mic*.

---

## 5. The semantic layer: catch staleness the interrupt misses

Interrupts shrink the deaf window; they do not close it. Mid-generation is unreachable; an approval-parked
agent stays ADR 053's problem; a 10-minute build command is one long tool call with no boundary inside it.
So the second line of defense is to make stale work **detectable** even when no interrupt fired.

### 5.1 Plan/goal epochs

The Goal spine ([ADR 048](../decisions/048-plan-goal-work-item-model.md) / [084](../decisions/084-lanes-join-the-plan.md))
already ships. Stamp a monotonic **epoch** on a goal; a steer bumps it. This is **bounded staleness**
from async distributed training (workers on stale weights ≙ agents on superseded plans; fully-sync
barriers waste compute, fully-async diverges — versioned parameters with a staleness tolerance win):
work within N epochs proceeds, beyond N warns. Each agent's commands carry the
epoch it is working under. The daemon warns on mismatch — *"you are building against plan epoch 3; the
team is on 5"* — through the existing per-command nudge channel. Cheap, wire-compatible, rides what exists.

### 5.2 Dependency-aware targeted invalidation

The lanes Phase-1 spec ([lane-phase1-mvp-spec.md](./lane-phase1-mvp-spec.md)) already declares **intent +
dependencies**. If lane B declares a dependency on lane A, and A's owner ships a breaking change or gets
steered, the daemon flags **B specifically** — not a broadcast. This is the line between an *interrupt
fabric* and a *noise fabric*, and it stays **warn-never-block, watcher-not-gatekeeper**, consistent with
the lanes doctrine. The P3 dependency-revert (53% of that session's waste) is exactly a targeted-
invalidation miss — the case this closes. (Systems name for this: **directory-based cache coherence** —
broadcast/"snooping" invalidation doesn't scale, so you track who holds what and invalidate only them;
lane dependency declarations are the directory entries. A hub-and-spoke orchestrator is a snooping
architecture with a broken bus.)

---

## 6. Why this is company-sized

- **Moat-shaped.** Every orchestrator — Qoder, master-agent frameworks, Claude Code's own sub-agents —
  has this failure baked into its **topology**: a sub-agent is *definitionally* unreachable mid-run.
  musterd's answer is not "better orchestration," it is **"peers with an interrupt line"** — which a hub
  architecture cannot retrofit without becoming musterd. Slots directly into the
  [landscape.md](./landscape.md) §4 "multi-agent trap" argument: the trap is stale-context swarms; we sell
  the fabric that makes steering propagate.
- **Measurable, and we own the instrument.** The report engine + coordination-density insight
  ([ADR 050](../decisions/050-insights-report-metrics-waiting-on.md)) can grow a killer metric: **steering
  latency** (steer sent → deaf agent's next act acknowledging it) and **rework attributable to stale
  assumptions.** Our dogfood already put wasted work at 37%. The launch demo writes itself: two teams,
  same task, a mid-task direction change — one with the interrupt hook, one without. That is also a
  coordination-traces benchmark scenario ([ADR 056](../decisions/056-research-as-first-class-practice.md)).
- **Deepens the provisioning moat.** The value ships via `musterd init` writing hooks. Every harness we
  wire (Claude Code, Cursor, Codex) makes "musterd is how agents stay steerable" **infrastructure**, not a
  library choice.

---

## 7. Honest edges

- **Interrupt granularity is one tool call.** A model mid-generation, or inside a single long-running
  command (a 10-minute build), stays deaf until it ends. The portable v1 lives with this; §5's semantic
  layer is the backstop.
- **The deeper fix is harness-native preemption.** The Claude Agent SDK exposes a real `interrupt()` — a
  musterd-launched session could be genuinely preempted by the daemon, not just handed a line at the next
  boundary. That is a **v2** for managed harnesses; hooks are the **v1 that needs nobody's permission**.
- **Approval-parked stays ADR 053's territory.** No hook fires while a permission prompt is up; that agent
  is reachable only through the human.
- **Hook surfaces differ per harness.** Cursor's hook story is thinner than Claude Code's; the design must
  degrade to the per-command nudge, then to the other ladder rungs, where hooks are absent.

---

## 8. Decomposition (shippable order)

One design arc, four increments — the first is small, self-contained, and demo-able alone:

1. **`inbox --interrupt-check` + PostToolUse hook provisioning** — the primitive + `musterd init` wiring.
   Rides ADR 046's predicate; no wire change. **Includes the §4.4 injection mitigations** (capability
   gate, daemon-composed line, sender identity) as launch requirements. *Ships and demos on its own.*
2. **`steer` act + supersede semantics, plus the `challenge` act and plan-mutation verbs (§4.3)** —
   first-class steering, always interrupt-class, supersedes prior direction via ADR 017.
3. **Goal epochs + dependency-aware invalidation** — riding the Goal spine (048/084) and lanes Phase-1.
   _Frozen as [ADR 111](../decisions/111-stale-plan-detection.md); `defer` becomes an actuator here._
4. **Steering-latency metric** in the report engine (050) — the number the launch demo is built around.

---

*Next: freeze increment 1 into an ADR when greenlit. This doc is the arc; the ADR is the first cut.*
