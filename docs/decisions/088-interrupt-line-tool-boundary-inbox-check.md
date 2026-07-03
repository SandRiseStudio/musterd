# 088 — The interrupt line: a tool-boundary inbox check reaches a busy agent

- Status: proposed — design frozen 2026-07-03; not yet built
- Date: 2026-07-03

## Context

The reachability ladder ([046](046-agent-side-reachability.md) heads-down nudge,
[053](053-inbox-reaches-blocked-agent.md) blocked-on-approval via the human,
[054](054-wake-on-message.md) idle `inbox --wait`) has a missing rung: an agent **busy mid-loop on its
own work**. A directed act lands at its seat instantly, but the model doesn't see it until its next
inbox check — minutes of stale-assumption work away. This is the canonical multi-agent-orchestration
failure observed live in a Qoder demo (steering couldn't propagate to busy agents → stale assumptions,
incompatible work, rework) and measured in our own P3 dogfood (~37% wasted work; the largest single
item, a dependency revert, was exactly a steering message that arrived too late). Full arc:
[interrupt-line-mid-loop-reachability.md](../design/interrupt-line-mid-loop-reachability.md) — this ADR
freezes **increment 1** of that design.

The unlock: a busy loop is not opaque. Harness hooks fire on **every tool call, mid-turn**, and hook
output is injected into the model's context. Each tool-call boundary is an interrupt point — a place
the outside world can put one line in front of the model without the model's cooperation. (Resident
harnesses have the same need at their gateway: they serialize runs per session, so a steer queues
behind the in-flight run. The busy-loop deafness is universal; only the injection point varies.)

## Problem

Deliver a waiting, interrupt-worthy directed act to an agent that is mid-turn on its own work — within
seconds, not at the next task boundary — without a wire change, without polling waste, without letting
team chatter thrash deep work, and without opening a prompt-injection channel into every working agent
on the team.

## Decision

### 1. `musterd inbox --interrupt-check` — the primitive

A one-shot, local, sub-50ms query against the daemon: *is there an interrupt-class directed act waiting
for this seat?*

- **No** → exit 0, **zero output**. The common case must be free: no context added, no tokens spent.
- **Yes** → exactly **one line** to stdout and exit 0, e.g.
  `⚡ musterd: urgent from june (handoff) — run 'musterd inbox' to read it.`

It reuses the waiting-act predicate ADR 046 built for the per-command nudge — this extends that nudge
from "musterd commands only" to "every tool call the agent makes." No SPEC bump, no new wire frames.

### 2. Provisioned as a PostToolUse hook by `musterd init`

`musterd init` (and `musterd agent`) wires the check as a **PostToolUse hook** in harnesses that
support hooks (Claude Code first), alongside the SessionStart hook it already writes
([060](060-verify-provisioning-not-assume.md); layered-guidance stamping, ADR 085). `init --check`
verifies the wiring (the 060 drift-detector pattern). Where hooks are thinner (Cursor today) the
design degrades to the ADR 046 per-command nudge; where absent, the ladder's other rungs apply.

### 3. Interrupt-class is scarce by construction

Only acts that clear a severity bar raise the line; everything else waits for the natural
task-boundary inbox check:

- **urgent-tier directed acts** ([044](044-notification-tiers-localhost.md)), which
  `can_flag_urgent` (ADR 071 governance) already gates by capability — a seat without the capability
  gets downgraded-and-delivered, and **cannot interrupt**.
- Future steering acts (design §4.2–4.3: `steer` / `challenge`) are interrupt-class by definition —
  they arrive in increment 2 and need no change here beyond act names.

### 4. Injection-surface mitigations are launch requirements, not follow-ups

Injecting teammate-authored text into a working agent's context mid-turn is a prompt-injection vector;
a compromised seat could steer every busy agent on the team. Therefore, from the first release:

- The injected line is **daemon-composed** from structured fields (sender, act, tier) — **never the raw
  message body**. Reading the body is an explicit follow-up act by the agent (`musterd inbox`).
- Sender identity is always present in the line, so the model can weigh the source.
- The capability gate (§3) bounds *who* can raise the line at all.

## Consequences

- Steering reaches a busy agent at its **next tool boundary** (typically seconds) instead of its next
  task boundary (minutes). The deaf window shrinks to: one tool call's duration, mid-generation gaps,
  and the ADR 053 approval-parked case — which keep their existing rungs.
- Cost at rest is one fast local process per tool call and zero context growth in the no-message case.
  If measured overhead is noticeable, the hook can throttle (e.g. skip if last check < Ns ago) without
  design change.
- The interrupt line becomes the delivery channel later increments ride: `steer`/`challenge` acts,
  goal-epoch mismatch warnings, and dependency-invalidation flags (design §§4–5) all arrive as more
  reasons the same line can fire.
- A new provisioning surface to keep honest: `guidance:check`/`init --check` must cover the hook so a
  renamed flag can't silently kill reachability.

## Observability & Evaluation

**Traces** — emit `musterd.interrupt.check` (counter, dimension: `result` = `silent` | `raised`) and
`musterd.interrupt.raised` audit events carrying act id + sender + tier, so every raised line is
first-party auditable (who grabbed the mic, when, at whom). The raised→read pair (raised event followed
by the inbox read of that act) is the delivery-confirmation signal.

**Eval** — the headline metric this ADR exists to move: **steering latency** — time from an
interrupt-class act being sent to the recipient's next act acknowledging it (measurable today from the
message DB; the P3 dogfood is the baseline, where the dependency-steer went unseen for a full work
cycle and produced the 53%-of-waste revert). Targets: median steering latency under one tool call's
duration for hooked agents; interrupt precision (raised lines that the operator/agent judges
interrupt-worthy) high enough that nobody disables the hook — the disable rate is itself the guard
metric.

**Experiment** — the built-in A/B: same two-agent task with a mid-task direction change, hook on vs
hook off (hook-off = today's behavior, the control), comparing steering latency and rework (reverted
lines attributable to stale assumptions). This is also the launch demo and a coordination-traces
benchmark scenario (ADR 056).
