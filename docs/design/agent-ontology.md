# What an agent is — the musterd ontology

**Status:** position doc. Captured 2026-07-03 from the zoom-out round of the reachability brainstorm
(arc: [brainstorm-arc-reachability-to-ontology.md](./brainstorm-arc-reachability-to-ontology.md);
mechanism doc: [interrupt-line-mid-loop-reachability.md](./interrupt-line-mid-loop-reachability.md)).
Opinionated by design: this is musterd's answer to "what is an agent / what is a harness," chosen
because the codebase already behaves as if it were true.

**One line:** *A model is a rented engine. A harness is a process that animates it for one session. An
agent is neither — an agent is a durable, addressable identity with responsibilities, memory, and a
lifecycle that outlives any session. In musterd terms: the seat. Harnesses borrow agents; they do not
own them.*

---

## 1. Why an opinion is needed

The field is converging on a definition of the **harness** — "all the deterministic code that surrounds
the LLM," commonly decomposed into seven layers: **execution, tooling, context, lifecycle,
observability, verification, governance** (the framing LangChain and Anthropic use; see
[LangChain's product concepts](https://docs.langchain.com/oss/python/concepts/products)). The popular
mental model is the loop: prompt the model, run its tool call, feed the result back, repeat until it
emits text.

That definition is fine as far as it goes. The confusion — visible in every "what is a harness" thread —
is that people then use *agent* and *harness* interchangeably, because for a single-user coding
assistant the distinction barely matters. For a **team** it is the whole ballgame. One comment in a
recent r/ai_agents thread got it exactly right:

> *"The harness runs one session, but identity + memory + skills belong to the agent across sessions.
> The harness just borrows them per turn."*

musterd needs this distinction to be first-class, so we state it as doctrine.

---

## 2. The definitions

| term | what it is | lifetime | musterd primitive |
|---|---|---|---|
| **model** | a stateless function: context in, next action out | one call | recorded per seat (future: roster field) |
| **loop / turn** | one run of the harness loop | seconds–minutes | — |
| **session** | a harness's conversation state (context, transcript) | minutes–days | binding's live session |
| **harness** | the deterministic program animating a model: the 7 layers | a process | the thing `musterd init` provisions |
| **agent** | a durable, addressable identity with responsibilities, memory, and a lifecycle that outlives any session | indefinite | **the seat** |

Corollaries:

- **The model is swappable per session; the agent persists.** stanley is not this process — stanley is
  the seat this process is currently animating, which yesterday a different process animated and
  tomorrow a different model might. (This is also what makes model-diversity teams — §5 — possible.)
- **The 7 layers are the harness's *internal anatomy*.** They are all **intra-agent** concerns. None of
  them addresses what happens *between* agents.
- **Coordination attaches to seats, not loops.** A message is addressed to stanley, not to pid 48211.
  This is why reachability machinery can work at all: the seat is still there when the loop is not.

## 2.1 We already believe this — the codebase as evidence

This ontology was not invented for this doc; it is a description of decisions already shipped:

- **ADR 058** put seat identity in git and liveness in the daemon — identity explicitly outlives the
  process (and even the daemon).
- **ADR 087** is literally titled *seat resume ≠ claim* — a distinction that only makes sense if the
  agent persists while sessions and processes churn.
- **ADR 065 / 068** (agent workspaces, workspace-scoped displacement) manage which *process* currently
  animates a seat — borrowing, formalized.
- The reachability ladder (ADRs 046/053/054) delivers to the **seat** and lets the mechanism vary by
  what state the animating process is in.

## 2.2 The counter-position, and why we reject it

The strongest alternative is **harness-owned identity**: Hermes Agent (Nous Research's resident
harness) keeps the agent's memory, skills, and identity *inside* the harness's home directory — the
agent *is* the installation. For a single personal agent this is coherent and even elegant. For a team
it is lock-in: the agent cannot be animated by a different harness, cannot survive its harness, and its
identity is only as trustworthy as one process's filesystem. musterd's position: **identity belongs to
the team layer; harnesses borrow it.** A seat can be animated by Claude Code today, Codex tomorrow, and
audited the same way both days.

---

## 3. The eighth concern

The 7 layers end at the process boundary. Between agents there is a distinct body of concerns that is
not a layer of *any* harness:

**identity · addressability · reachability · shared plans · contention · governance-across-actors
(agents *and humans*) · team-level observability.**

That is the **inter-agent fabric**, and it is musterd. Harness engineering stops at the process
boundary; **team engineering** starts there. Every orchestrator that tries to host this inside one
harness (a master agent, a sub-agent tree) inherits the hub topology and its failures
(stale steering, unreachable busy workers — see the interrupt-line doc §1–2).

---

## 4. Residency classes — reachability is indexed by harness lifecycle

"Can you wake/interrupt an agent" is not one question; it depends on the **residency class** of the
harness currently animating the seat:

| class | examples | wake | interrupt mid-work |
|---|---|---|---|
| **turn-scoped** | Claude Code CLI/extension, Cursor | needs machinery: `inbox --wait` (idle), background-wait, external resume | tool-boundary hooks (the interrupt line) |
| **resident** | OpenClaw, Hermes, musterd's own daemon | solved by architecture — a gateway is always listening and invokes the model on events | **not solved**: runs are serialized per session, so a steer *queues* behind the in-flight run — deafness becomes queue latency |
| **scheduled** | heartbeat/cron, Claude Code routines | latency = time to next tick | same as turn-scoped once running |

Two consequences:

1. **The always-on harnesses validate the gateway pattern and do not obsolete the interrupt line.**
   OpenClaw — a single long-running gateway process acting as control plane and message broker, with a
   cron heartbeat — is architecturally a *single-agent, one-human* musterd daemon. Its session lanes
   ("only one agent run touches a given session at a time") mean the busy-loop deafness survives
   residency; it just moves from "unseen" to "queued." Interrupt policy is needed in every class.
2. **The strategic claim: musterd gives turn-scoped harnesses residency.** A seat's binding can hold
   the harness session id; the daemon can resurrect the session on a directed act
   (`claude --resume <id> -p '…'`). Nobody has built the *multi-agent, multi-human, one-team* residency
   layer — that upgrade turns "wake on message" from a feature into the position: **musterd makes any
   harness always-on.** (Unbuilt; the "offline" rung of the reachability ladder.)

---

## 5. The monoculture problem — correlated judgment in same-model teams

Same-model agents produce **correlated** opinions: they share training data, blind spots, and
self-preference. Three same-model agents "grilling" each other's approach will agree and disagree in
correlated ways — consensus among them is weaker evidence than it looks. Decorrelators, ranked by
strength:

1. **Different evidence/context** (strongest): agents that have read different code, run different
   experiments, own different lanes diverge on *observations*, not priors. Disagreement grounded in
   evidence is the only kind that fully escapes the monoculture. ("Verify by running it" beats "ask a
   second opinion.")
2. **Different models** (strong; the only fix for shared blind spots): heterogeneous teams. Our P3
   dogfood was accidentally heterogeneous (Opus / Sonnet / GLM) and the model mattered more than the
   seat.
3. **Different stance/role prompts** (moderate): adversarial-reviewer skills ("grill me") change the
   conditioning, not the distribution. Useful, insufficient alone.

musterd's angle: **we are the model-agnostic layer, so diversity is a team-composition feature.**
Record the model per seat on the roster; let the report engine flag same-model review chains ("this
approval chain was Opus end-to-end — treat agreement as weak evidence"). Research track (ADR 056):
measure agreement correlation between same-model vs cross-model reviewer pairs on real coordination
traces — a dataset nobody else has.

---

## 6. Team scale — the ceiling is measurable

Adding agents grows potential communication pairs as n(n−1)/2 while the task graph's dependency
structure caps useful parallelism (Amdahl: coordination is the serial fraction; Brooks: adding workers
to a late project makes it later). Our own measurement (the multi-agent tax:
[lanes-and-the-multi-agent-tax.md](./lanes-and-the-multi-agent-tax.md)) put wasted work at ~37% with
4 agents — and the weakest *model* was a net negative regardless of seat. Plus mundane contention: API
rate limits, shared git surfaces (lanes), and the scarcest resource, human attention (the report
engine's waiting-on exists to compress it).

The musterd position is not a prescribed team size — it is that **coordination-density (ADR 050) can
measure your team's Brooks ceiling on live traces**: "your waiting-on chains and rework rate say this
task graph saturates at 3 agents." No orchestrator can tell you that; the fabric can.

---

## 7. Bottleneck isomorphisms — proven mechanisms, free of charge

The coordination bottleneck is not new; it is the same math as three solved systems problems, and each
gifts us a named mechanism:

- **Async distributed SGD → stale gradients.** A worker computing gradients against stale weights *is*
  an agent building against a superseded plan. ML's answer: fully-sync barriers waste compute,
  fully-async diverges; the practical winner is **bounded staleness** over versioned parameters. →
  goal **epochs with a tolerance** (interrupt-line doc §5.1): work within N epochs proceeds, beyond N
  warns. Warn-never-block is relaxed-consistency doctrine.
- **Multicore cache coherence (MESI).** A write to a shared line invalidates other holders. Broadcast
  ("snooping") doesn't scale; large systems use **directory-based coherence** — track who holds what,
  invalidate only them. Lane dependency declarations are directory entries; targeted invalidation
  (interrupt-line doc §5.2) is directory-based coherence for plans. A hub-and-spoke orchestrator is a
  snooping architecture with a broken bus.
- **The memory wall / interconnect.** Compute scaled faster than memory bandwidth; frontier training is
  bottlenecked by interconnect — hence NCCL/NVLink. Models (compute) scaled; coordination (bandwidth)
  didn't. The industry is at "add more cores" without the interconnect. **musterd is NCCL for agent
  teams.**

---

## 8. Positioning lines this ontology yields

- *Harness engineering ends at the process boundary; team engineering starts there.*
- *Identity belongs to the team layer; harnesses borrow it.*
- *Coordination attaches to seats, not loops.*
- *musterd makes any harness always-on.*
- *musterd is NCCL for agent teams.*
- *Consensus among same-model agents is weak evidence; the fabric can tell you when that's what you have.*

These slot into [landscape.md](./landscape.md) (§4 multi-agent trap), the whitepaper track (ADR 056),
and brand/product copy.

---

*Companion docs: mechanism — [interrupt-line-mid-loop-reachability.md](./interrupt-line-mid-loop-reachability.md);
process — [brainstorm-arc-reachability-to-ontology.md](./brainstorm-arc-reachability-to-ontology.md).*
