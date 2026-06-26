# Competitive landscape — coordination vs. the substrate

> **Living document.** The competitive picture on the *coordination* side, complementing the observability-market snapshot in `observability.md` §2. Substantive positioning shifts go through an ADR. Status: **draft**, 2026-06-17.

This doc records what neighboring tools build, where they stop, and why musterd's choices are deliberate counter-positions rather than gaps. It is evidence for the thesis, not the thesis itself (that lives in `README.md`, `ROADMAP.md` "How priorities are decided", and `observability.md` §3).

## 1. The pattern: frameworks delegate coordination to the substrate

Every serious agent framework solves *per-agent* execution and *per-agent* observability, then treats the space **between** agents as infrastructure's problem — usually a platform primitive, not something they model.

**Flue** (flueframework.com, repo `withastro/flue`, by the Astro team) is the clearest 2026 example, and worth studying because it is well-engineered, not a strawman. Source inspected 2026-06-17:

- **Deep per-agent durability.** A real durable-execution engine: per-turn write-ahead journal (`before_provider → provider_started → tool_request_recorded → committed`), attempt markers, and a 7-mode resume classifier (`submission-state.ts`) that correctly avoids re-executing side-effecting tools after a crash mid-tool-batch. Backend-neutral store contract (SQLite/Postgres/MySQL/Mongo/Redis) with conformance tests.
- **Per-agent observability.** `@flue/opentelemetry` emits `workflow → operation → turn → tool` spans using the **gen_ai semantic conventions**, with a content-redaction hook (`exportContent`) and parent-trace stitching (`resolveRootContext`).
- **Coordination delegated to the substrate.** Their own comment: *"Cloudflare DOs are single-threaded per instance — leases are advisory-only."* Single-active is **bought** from the Durable Object (or, on Node, a lease + heartbeat over OS processes). They build nothing *between* distinct agents: no cross-agent work queue, no peer arbitration, no shared-resource contention. The `task` tool spawns subagents, but that is a parent→child call tree, not peer coordination.

This is not an oversight — it's the natural seam. Per-agent durability is the product; the between-agent space is "let the platform handle it." That seam is exactly where musterd (coordination) and batond (coordination observability) begin. The same shape holds for LangChain / CrewAI / AutoGen: they orchestrate from a single driver process and emit per-agent spans; none model durable, named, cross-process coordination with humans as peers.

**Takeaway for positioning:** "the coordination layer is nearly empty" (observability.md §2 fact 3) is not just a research-paper claim — a credible, recent, well-funded framework demonstrably stops where we start. Don't let their breadth tempt musterd toward durable execution / retries / channels: Flue validates "protocol over framework" *by being the framework*; musterd's smallness is the differentiator (Principle 4, ADR 007).

## 2. The reclaim axis: expiry vs. preemption (validates ADR 017)

Single-active occupancy has two opposite correct answers, depending on the catastrophe you fear:

| | **Flue (and lease-based systems)** | **musterd (ADR 017)** |
|---|---|---|
| Protected unit | one agent instance's submission queue | a coordination member slot |
| Worst case avoided | **double-execution** of a side-effecting agent | **lockout** of a human/member who reloaded |
| Reclaim trigger | lease **expiry** (timeout, ~30s) | **newer intent** (preemption) |
| On crash / reload | wait up to lease duration | takeover is instant |
| Incumbent trust | none — only expiry relinquishes | none — newest declaration wins |
| Revocation primitive | **none** — relinquish only via lease lapse or graceful settlement | **`superseded`** frame → force-close → hub-evict → attach newcomer |

Flue's ownership model has **no way to revoke owner X *now***. musterd's ADR 017 `superseded` path is exactly that primitive — musterd already ships what a lease-based runtime structurally can't express. The two defaults are both correct because the domains differ: Flue's autonomous-background work makes mutual exclusion right (running a tool twice is the disaster); musterd's interactive, human-in-loop, localhost-single-operator domain (ADR 007) makes preemption right (locking a human out of their own seat is the disaster — see the ADR 017 dogfood deadlock in `implementation-plan.md` §4.A).

**Consequence for integration:** control-plane integration with a lease-based runtime is a dead end — musterd's newest-wins semantics can't ride on a contract with no revocation primitive. The honest integration is **observability**, not control (see §3).

## 3. Integration posture: ingest, don't control

batond's positioning is "native to musterd, not captive to it" — it ingests musterd logs first-class **and** plain OTel GenAI/agent spans (observability.md §5, brand-coordination-observability.md §1). Flue is the ideal **first non-musterd ingestion target**:

- It is a real framework emitting exactly the per-agent gen_ai spans batond links *between* — proving "completes, doesn't fight" with a third party, not a strawman.
- Its `task` tool produces a parent→child agent tree: a minimal multi-agent topology batond can render **with zero musterd involved**, de-risking the "captive to musterd" criticism before musterd ingestion is even built.
- Mirror Flue's two hooks — `exportContent` (redaction gate) and `resolveRootContext` (parent stitching) — in batond's ingestion design; they are table stakes you'd otherwise discover late.

Caveat (and the moat): Flue has **no** cross-agent attributes — no waits, contention, or "B blocked on A." Deriving the between-view is the work, not a shortcut Flue hands over.

## 4. The "multi-agent is a trap" critique sharpens our line (Sierra, 2026)

The strongest recent argument *against* multi-agent systems comes from Sierra's head of product (Max Agency / LangChain podcast, May 2026) — and parsing it is the cleanest articulation of musterd's domain, because it reads as an attack and isn't one.

His critique: most multi-agent systems are a mistake. People build them to "ship their org chart," or because two problems *feel* more comfortable held apart — not for impact. And splitting one job into a triage agent + a task agent **deprives each of the other's context**, which is "destructive of value." The fix is usually a monolith with better context engineering, not more agents. He's a self-described "monolith loyalist," and he's right — **for what he's describing.**

The thing he's describing is **intra-task orchestration**: decomposing one job into sub-agents. That is precisely *not* what musterd is — "musterd connects agents; it does not run them" (ROADMAP out-of-scope; Principle 4, ADR 007). The frameworks in §1 *are* orchestrators (single driver process, parent→child `task` trees); musterd is the substrate **between actors that already exist independently**. The two are different layers, and his critique lands squarely on the orchestrator, not the coordination substrate.

He even hands over the carve-out: multi-agent is justified for "truly separable jobs where there's no purpose of the first context being part of the second." **A human is the maximally separable actor** — you cannot context-engineer a person into the prompt. So the human↔agent loop (the Co-Gym wedge, `research-foundation.md`) is exactly the case his monolith argument *cannot absorb*. That is musterd's robustness: its bet is on humans-as-peers, the one coordination that no amount of context engineering collapses into a monolith.

**Two consequences:**
- **Honest exposure.** If most agentic *work* does collapse into well-engineered monoliths, the agent-to-agent coordination market is thinner than a naive multi-agent thesis assumes. musterd's durability comes from the human loop — a reason to keep the headline on humans+agents-as-peers and resist drifting toward sub-agent-swarm orchestration (the very trap he names).
- **A design constraint, not just positioning.** His context-deprivation point means a musterd `handoff` that carries too little context recreates the value-destruction he warns about. Handoffs/threads must propagate real context (`thread_id` + `meta.otel` trace-linking lean this way); a handoff is not a bare pointer. Worth teaching explicitly in `agent-primer.md`.

**Takeaway for positioning:** the best available critique of multi-agent systems is an argument *for* musterd's framing — coordination of separate actors (humans first), not orchestration of sub-agents. Use it: when someone says "but multi-agent is a trap," agree, then point at the human in the loop.

## 5. Patterns worth borrowing (non-coordination)

- **Agent-pullable onboarding** — Flue's `flue add` detects whether the caller is an agent (`@vercel/detect-agent`) and emits raw markdown to stdout, else prints `… --print | claude` instructions for a human; blueprints are versioned with a mandatory "Upgrade Guide". A `musterd primer --print` with the same branching would let an agent self-onboard mid-session, not just at `init`. See `agent-primer.md` §10.
- **Two-pronged liveness** — Flue infers liveness from the substrate signal **plus** its own durable marker with a staleness cutoff, trusting neither alone. The ADR 017 deadlock root cause was liveness inferred from the WS socket alone (an orphaned socket kept a zombie "alive"). A musterd-owned heartbeat/marker independent of the WS connection is the fix shape for the residual "stuck non-reconnecting presence" follow-up.
