# Brainstorm arc — from "can we wake an agent?" to an ontology (2026-07-02 → 07-03)

**Status:** process log. This doc records *how the thinking evolved* across a two-round human+agent
brainstorm, both as provenance for the two artifacts it produced and as a template for the practice
itself. Artifacts: [interrupt-line-mid-loop-reachability.md](./interrupt-line-mid-loop-reachability.md)
(mechanism, round 1 + round 2 amendments) and [agent-ontology.md](./agent-ontology.md) (position,
round 2).

**One line:** *Round 1 produced a mechanism. A day of Nick talking to people and watching a live demo
produced questions the mechanism couldn't answer. Round 2 zoomed out and produced the ontology the
mechanism was silently assuming — and the ontology then improved the mechanism.*

---

## The timeline

### Round 0 — a factual question (2026-07-02)

Nick asked whether "wake on message" was ever fully implemented, given how harness sessions actually
behave (Claude Code spins down between prompts; exited sessions print `claude --resume <id>`). Working
through it produced the **reachability ladder** as an explicit table for the first time — idle
(`inbox --wait`, ADR 054), heads-down (nudge, ADR 046), blocked-on-approval (human push, ADR 053) —
and exposed two unbuilt rungs: **offline** (external `claude --resume` resurrection) and
**busy mid-loop** (nothing).

### Round 1 — the Qoder failure → the interrupt line (2026-07-02)

Nick brought a concrete failure he'd watched live: a Qoder solutions-architect demo where a master
agent coordinated sub-agents hub-and-spoke, agents were busy in their loops, steering couldn't
propagate in time → stale assumptions, incompatible work, rework. The brainstorm split it into a
**topology failure** (hub-and-spoke — already solved by musterd's peer-to-peer acts) and a
**reachability failure** (a busy loop is deaf — the unsolved rung), found the unlock (**tool-call
boundaries are interrupt points**; hooks inject without the model's cooperation), and froze the design:
`inbox --interrupt-check` + hook provisioning, tier-gated severity, a `steer` act, goal epochs,
dependency-targeted invalidation, a steering-latency metric. **Frozen to the interrupt-line doc the
same day.**

### The interlude — Nick offline (≈ a day/night)

Nick took the round-1 result out into the world: conversations with people, the Qoder talk's loose
threads, a Reddit deep-dive on harness definitions, the LangChain 7-layer framing, the "grill me"
skill recommendation, and awareness of Hermes Agent / OpenClaw. He came back not with feedback on the
mechanism but with a **pile of deliberately unorganized questions** that mostly didn't mention the
mechanism at all: What about 24/7 agents? What even *is* an agent vs a harness — should musterd have an
opinion? Are same-model agents' agreements meaningful? Can humans defer/reorder/question agents' plans?
Do too many agents break things? Is this bottleneck like bottlenecks in ML/chips? What about
sandboxing, identity, audit?

### Round 2 — the zoom-out (2026-07-03)

The questions forced altitude. Key moves, in order of how the thinking actually turned:

1. **Grounding first**: checked what OpenClaw and Hermes actually are (resident gateway processes,
   heartbeat crons, per-session run serialization) rather than reasoning from vibes.
2. **The residency insight**: always-on harnesses solve *wake* by architecture but not *interrupt* —
   runs serialize, steers queue. So the reachability ladder is **indexed by residency class**, and the
   round-1 mechanism survives contact with the always-on world.
3. **The ontology crystallized**: the ladder only makes sense if the thing being reached is not the
   process. Agent = seat (durable identity), harness = borrower, model = engine — and the codebase
   already believed it (ADRs 058, 087, 065). The industry's 7 layers are intra-agent; the inter-agent
   fabric is the eighth concern, and it is musterd.
4. **The ontology paid the mechanism back**: residency classes went into the interrupt-line doc; the
   "offline resume" follow-up got upgraded to a strategic claim (*musterd gives harnesses residency*);
   the monoculture question became a team-composition feature (model per seat, same-model-chain
   warnings); Nick's "question a task" idea became the **`challenge` act**; the ML/chips analogy
   question yielded named mechanisms (bounded staleness → epochs, directory coherence → targeted
   invalidation); and the security thread caught that **the interrupt line is itself a
   prompt-injection vector**, moving mitigations into increment 1 as launch requirements.

---

## How the thinking evolved — the specific reversals and upgrades

| round 1 belief | round 2 belief | what changed it |
|---|---|---|
| The interrupt line is a musterd *feature* | Reachability is a property of the **seat**, indexed by harness **residency class** | Hermes/OpenClaw: wake solved by residency, interrupt not |
| Offline resume is a nice follow-up | **"musterd makes any harness always-on"** is a strategic position | Seeing that nobody has built the multi-agent, multi-human residency layer |
| Tiers/`can_flag_urgent` are noise control | Tiers are the **security model** for interruption — who may grab the mic | Asking "what if a compromised seat raises the line?" — injection surface |
| Peer topology solves the Qoder failure | Peer topology + **decorrelated judgment**: same-model consensus is weak evidence | The monoculture question ("won't 3 same-model agents always agree?") |
| Steering = one act | A vocabulary: **reorder/defer** (plan mutation) · **steer** (directive) · **challenge** (epistemic) | Nick's "question a task → agent revalidates" |
| Epochs/invalidation justified by intuition | Justified by isomorphism: **bounded staleness** (async SGD) + **directory coherence** (MESI) — warn-never-block ≙ relaxed consistency | The "is this like ML/chip bottlenecks?" question |
| Agent/harness definitions are background noise | An **opinionated ontology is the intellectual spine** (landscape, whitepaper, brand) | The Reddit/LangChain definitional churn + Hermes' harness-owned identity as a real counter-position |

Also answered honestly along the way: an agent (this one included) brainstorming with you produces
opinions **correlated with its model's training** — which is itself an argument the round-2 doc makes
(decorrelate via evidence, then model diversity, then stance). The strongest decorrelator in this arc
was **Nick's offline day** — human-gathered evidence the model didn't have.

---

## The practice, named (so we can repeat it)

1. **Brainstorm hot, freeze same-day.** Round 1 went from anecdote to frozen design doc in one
   session. Unfrozen brainstorms evaporate.
2. **Take the frozen artifact into the world.** Talks, demos, threads, other people. The human is the
   high-bandwidth sensor for evidence outside the model's distribution.
3. **Return with raw, unorganized questions — don't pre-digest.** The disorganization is a feature: it
   prevents the agent from just defending the round-1 artifact.
4. **Zoom out before amending.** Answer the questions at their own altitude first (here: an ontology),
   *then* let the higher-altitude answers flow back down into the mechanism doc as amendments.
5. **Log the arc** (this doc) — the reversals table is the payload: it is the evidence that the process
   changed conclusions, not just word count.

This is itself a data point for the coordination-research track (ADR 056): a two-round
human+agent design loop with a measurable evidence-injection step in the middle.
