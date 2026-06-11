# Human–Agent Dynamics — a working philosophy

> **Status: PHILOSOPHY, not spec.** Nothing here is buildable as written; it is the conceptual ground under decisions other docs make buildable. It came out of the first real dogfooding session (2026-06-11, the day v0.2 M1 landed): a human driving an agent through musterd noticed the roster showed the agent online and *himself* offline, and pulled the thread. Where this note proposes anything concrete it is flagged as a **design seed** with the milestone it belongs to. Companions: `membership-model.md` (v0.3 governance — the *enforced* layer below), `membership-impl-plan.md` (v0.2), `../decisions/007-v0.2-scope-cut.md`.

> **Living document.** Same protocol as everything else: corrections via ADR + smallest correct change, update this doc in the same commit.

## The maxim

> **Presence answers "is anyone there." Provenance answers "why are they there." The conversation answers "what are they to each other." Don't make any layer answer another layer's question.**

Every confusion this note untangles turned out to be one layer being asked to carry another layer's information. The design discipline that follows is the same one the two-clocks rule (ADR 007 / v0.2 M2) already encodes: **record observable facts; enforce boundaries; let meaning be *read out of* the durable record, never asserted into config.**

---

## 1. The presence problem: driving vs. supervising

The dogfooding moment: nick opens a Claude Code session wired to musterd as the agent **Tim**. Roster says *Tim — online via claude-code; nick — offline*. But the human is the one unmistakably present; the agent is his instrument. The one entity that is certainly here shows as gone.

**Root cause:** presence is *attachment-based*, and agents attach automatically (their harness holds the socket) while humans attach only when they explicitly act (`inbox --watch`). A human driving an agent is invisible because the agent holds the only connection in the room.

**The reframe:** the agent's presence is, today, a *proxy for human attention* — "Tim online" really means "a human is engaged here." The system gets interesting exactly when those two **diverge**: the human walks away and the agent keeps working (now "Tim online, nick offline" is true *and useful*), or the human supervises three heads-down agents at once. So the bug is not "nick shows offline"; the bug is that musterd cannot distinguish **"nick is gone"** from **"nick is right here, inside Tim."**

There are two human postures, and v0.1/v0.2 models only one:

| Posture | What the human is doing | musterd today |
|---|---|---|
| **Supervising** | `inbox --watch`; eyes on the whole team | ✅ human shows present |
| **Driving** | inside one agent's session, steering it | ❌ human shows offline; the agent stands in for them |

In reality the postures are not even discrete — a single sitting flows through supervising → pairing → delegating → walking away. Which leads to §2.

## 2. The relationship is a stance, not a role

A human's relationship to an agent shifts continuously, often within one hour, with one agent:

- **Supervising** — asked for something, now watching it reason and stream; intervening sometimes, sometimes not.
- **Pairing** — questions flowing both directions; genuine coordination between teammates.
- **Delegating** — kicked it off, walked away entirely, trusts it to decide and execute.
- **Deferring** — initiated the task, but the agent has the deeper domain expertise and is *driving the outcome*; the human is the requester **and** the junior party in the domain.

Two structural observations:

**Initiative ≠ hierarchy.** "I asked our security person to look at this" does not put the asker in charge of security. Any model that conflates *who started the thread* with *who has authority in it* misdescribes half of real teamwork, human or agent. The deferring posture — human initiates, agent drives — is the strongest argument for musterd's founding bet: a tool's output is attributed to its wielder, but a **member's** work is *theirs* — named, questionable, declinable, handed off. The moment an agent "is really the one driving the outcome," it has stopped being describable as a tool.

**The trap is making the stance a stored property.** "Tim: supervised agent, autonomy level 2" would be wrong within the hour. Humans never encode this with each other either — the stance is carried by *how they talk*. musterd should not model the relationship; it should record the facts that let the relationship be **read** from the record:

1. **Provenance** *(fact, cheap, objective)* — why does this presence exist? A human opened a harness session; someone asked the agent to do something; a hook/function/app fired; a schedule started it ("it's 9am"); it's a 24/7 daemon. Knowable at attach time, never guessed. → **Design seed (M3/v0.3 candidate): a `provenance` enum on attach** — e.g. `session | asked | hook | scheduled | daemon`. Note it dissolves most of §1 without modeling humans at all: `Tim — online via claude-code (session)` already tells the team "someone is behind this," vs. `(scheduled)` = "nobody necessarily is."
2. **Initiative** *(already shipping)* — who started this thread of work? Envelopes have `from`; the acts include `request_help`/`handoff`/`accept`/`decline`. The provenance of *work* is the thread itself.
3. **Disposition** *(designed, v0.3)* — what latitude was granted? Autonomy is *granted per engagement*, not owned by the agent — which is exactly what the grant model in `membership-model.md` encodes (once/TTL/standing, approval lane, per-seat capability narrowing). The dogfooding conversation independently re-derived this design.

The four postures then become an *emergent reading* of provenance + initiative + disposition + the live conversation — a field nobody maintains and therefore nobody lets go stale.

**Open seed (unscheduled): driver co-presence.** The adapter knows when it is running inside a human-initiated session; it *could* emit a paired human presence ("nick — driving Tim"). Cheap signal, makes the roster tell the truth in the driving posture. Deliberately not committed to a milestone: it may fall out more cleanly from provenance display than from a second presence row. Revisit when M3's activation work touches the adapter.

## 3. Expertise: declared, enforced, demonstrated

The ecosystem's "this is the security agent / senior staff UX designer" pattern bundles three different things into one config file:

| Layer | What it is | Truth condition | Where it lives in musterd |
|---|---|---|---|
| **Declared** | the *lens* — a role/persona prompt steering attention | behavioral, not credential | the member `role` string — a **routing hint + attention scope** |
| **Enforced** | the *license* — actual differential access: tools, data, credentials | verifiable at a boundary | capabilities + grants — the v0.3 set (`membership-model.md`) |
| **Demonstrated** | the *record* — what it has actually done under a stable name | accumulated, inspectable | the persistent message log — **emergent, already shipping** |

Same maxim, applied: a role string must not gate tool access (declaration ≠ enforcement); tool possession must not be read as competence (license ≠ skill); and no layer should fabricate another (no fictional résumés — the log *is* the biography).

**What the research says about the declared layer.** The systematic evidence is in, and it cleanly splits the anecdotes:

- The largest controlled study — 162 personas, 4 LLM families, 2,410 factual questions — found persona prompts give **no improvement, or small negative effects, on accuracy**, with no reliable rule for picking a "good" persona ([Zheng et al., arXiv:2311.10054](https://arxiv.org/abs/2311.10054)).
- A 2026 result sharpens it into a trade-off: expert personas **improve alignment (tone, framing, orientation) while damaging factual accuracy** ([PRISM, arXiv:2603.18507](https://arxiv.org/abs/2603.18507)).
- Task-type analyses consistently find personas help on **style, register, and open-ended work**, not on accuracy-based tasks — where they can actively hurt ([PromptHub survey](https://www.prompthub.us/blog/role-prompting-does-adding-personas-to-your-prompts-really-make-a-difference), [SEJ summary](https://www.searchenginejournal.com/research-you-are-an-expert-prompts-can-damage-factual-accuracy/570397/), [Emergent Mind overview](https://www.emergentmind.com/topics/expert-persona-prompting)). Vague identity personas ("You are a mathematician") perform worst of all; much of the pro-persona lore formed on older, weaker models where the steering effect was more visible.

So: **declare the lens, not the résumé.** "Attend to vulnerabilities; prioritize authn/authz; check dependency CVEs" buys the same steering as "you are a veteran security analyst with 10 years of experience" — without the fiction and without the measured accuracy tax. musterd should never encourage credential-fiction in a `role`; the credibility claim belongs to the log, the capability claim to the grant table.

**What persistence buys that sub-agents cannot have.** A sub-agent's expertise can only ever be *declared* — it spawns, performs its persona, and vanishes; every invocation is a stranger with a confident bio, and nothing can recalibrate trust in it. A persistent member accrues a record: the handoffs it accepted, the calls that held up. Teams (human and agent readers of the log) calibrate trust in members the way they do in colleagues. *Expertise as track record* is structurally unavailable to ephemeral-agent frameworks and is native to musterd's seats-accrue-history model.

**Organs vs. colleagues.** Both patterns stay legitimate: a sub-agent is an **organ** of its orchestrator (Tim spawning a throwaway explore-agent inside his own task is fine and invisible to the team); a member is a **colleague** (durable, addressable, accountable; a handoff to it is a visible, declinable act, watchable from the inbox — which is the supervising posture working as intended). The design line: **an organ deserves to become a colleague when its work needs to be addressable, declinable, or remembered.** And the "same model underneath" objection cuts no ice: every human specialist runs on the same brain architecture too. The unit of expertise was never the substrate — a member is a **named configuration**: model × lens × licenses × memory-of-work. That is a respectable expert, *iff* the licenses are enforced and the memory is real.

## 4. What this note commits us to (summary)

- **Now (costless, doctrinal):** `role` is routing metadata + attention scope, never a capability claim or biography. Docs and examples model scope-style roles, not persona fiction.
- **M3 candidate:** the `provenance` enum on attach (smallest fact that dissolves the driving-posture confusion). Decide when M3 opens the adapter.
- **v0.3 (already designed):** grants/capabilities = the enforced layer; this note adds the *why* under that design.
- **Unscheduled seeds:** driver co-presence; surfacing provenance in roster rendering; whether scheduled/working-hours agents need first-class lifecycle support beyond `provenance: scheduled`.
- **Never:** a stored "relationship" or "autonomy level" field on a member; presence semantics overloaded to imply who is behind an agent.
