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
   - **The `where` half of the same seed (workspace context; decisions locked 2026-06-12).** A bare `working: M2 shipped, awaiting M3 decision` is scope-blind — it could be any project, or any plan within one. The session already knows where it is, so capture it as fact at join, don't ask the agent to declare it. The key is a **gracefully-degrading label**, because no single signal is universal (not everyone branches; not everyone uses git): floor = **cwd folder name** (always exists); qualifier = **git branch when informative, else cwd subpath within the repo, else nothing**; an optional **declared label overrides** (one-time "what are you working on?" at init, or `MUSTERD_WORKSPACE`). Locked: **the most specific qualifier leads** the rendering; `where` is **sticky at join** (session context, lives with provenance — not re-declared per status); git-less projects get **one** dim, non-moralizing init line framed as a capability unlock ("musterd labels work automatically when the folder is a git repo — works fine without it"), never repeated. `state` stays narrative/temporal (what happened, what's next — progress belongs there); `where` is spatial/structural; redundancy between them is harmless once the anchor exists. Render `where` dim, as location context, not an authoritative scope verdict — the auto-signal is approximately right by design.
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

## 4. Work, not just workers — boards, planning, and the insight layer

*(Seeded 2026-06-12 from the kanban/standup discussion. Roadmap-level — nothing here is v0.2. **The dedicated brainstorm agenda — planning noun, leadership reporting, flow/cost metrics, the "waiting-on" view — is parked in [`planning-and-insights-brainstorm.md`](planning-and-insights-brainstorm.md) for a future session.** This section is the philosophy that note builds on.)*

A team has two mechanisms for knowing who's doing what, and they attach state to different nouns:

| | Standup | Board |
|---|---|---|
| Mode | push, narrative | pull, structured |
| State attaches to | **the person** ("I did X, I'm blocked on Z") | **the work item** (ticket: backlog → in progress → done) |
| musterd today | ✅ `status_update` + the `working:` roster label | ❌ no work-item noun exists |

Everything in musterd v0.2 attaches to *members*. The missing noun is *the work itself*. And the reason human boards rot (Jira drift) and standups ossify into theater is the same failure this note keeps finding: **declared state that must be manually synced with reality decays.** Updating the ticket is unpaid work done after the real work.

**Why agent teams may be the first place kanban works as designed:** for an agent the marginal cost of structured status is ~zero — its work happens through tools, it doesn't resent standups, and harness hooks (see `../harness-hooks.md`) prompt reporting mechanically at task boundaries. The economics that doom human boards (sync cost > perceived value) invert.

**The musterd-native build: project the board from the act log; never store it beside it.** The acts are already kanban's verbs — `handoff` = reassignment, `accept`/`decline` = taking/refusing a ticket, `request_help` + `meta.blocking` = the blocked flag, `wait` = paused, `status_update.progress` = percent done. **A thread is a proto-ticket**: the act that opens it creates the item, the acts within it are its transitions, its latest act *is* its column. A board is then a *view over messages* — no second source of truth to rot. (Natural home: the web dashboard already designed in `figma-brief-dashboard.md`.)

**The planning exception — and the principle that resolves it.** A board also holds *backlog*: work nobody has started, which no act log can supply. That looks like a contradiction (didn't we just outlaw declared state?) until you split declarations in two:

> **Declarations that *mirror* reality rot; declarations that *create* reality don't.** A ticket's "in progress" column mirrors execution and drifts the moment the mirror isn't polished. A backlog item *is* the intent — there is no underlying reality for it to drift from; it's performative, like a promise. So: **planned work may be stored declaratively; execution state must always be derived.**

**The insight layer (velocity, load, bottlenecks, leadership reporting).** Because every coordination event is a typed, timestamped, attributed envelope in SQLite, the analytics layer is *queries, not instrumentation*: time-to-unblock (`request_help` → `accept` latency), cycle time (thread open → terminal act), load distribution (who accepts the handoffs), bottlenecks (where threads stall, whose queue of unanswered asks grows), progress trajectories (`meta.progress` over time). A `musterd stats` CLI could ship cheaply as a taste; the dashboard is the real home. Two design cautions, recorded now: **(1) Goodhart** — message volume ≠ work; agents emit cheap text, so counting envelopes rewards chattiness. Measure outcomes (threads closed, asks answered, artifacts shipped), never volume. **(2) Surveillance asymmetry** — analytics over *agents* is operations; analytics over *humans* is monitoring, with the morale and trust costs leadership dashboards have always had. The v0.3 need-to-know visibility model must govern who can see derived metrics, not just raw messages. Known gap: the log has no terminal "done" marker for a thread (accept ≠ finished) — a thread-closing signal is a spec question for the board/insights work to answer.

## 5. What this note commits us to (summary)

- **Now (costless, doctrinal):** `role` is routing metadata + attention scope, never a capability claim or biography. Docs and examples model scope-style roles, not persona fiction.
- **M3 candidate:** the `provenance` enum on attach (smallest fact that dissolves the driving-posture confusion). Decide when M3 opens the adapter.
- **v0.3 (already designed):** grants/capabilities = the enforced layer; this note adds the *why* under that design.
- **Unscheduled seeds:** driver co-presence; surfacing provenance in roster rendering; whether scheduled/working-hours agents need first-class lifecycle support beyond `provenance: scheduled`; the board-as-projection + insight layer (§4) for the dashboard era, with the planning noun (stored intent) as its one legitimate declared object.
- **Never:** a stored "relationship" or "autonomy level" field on a member; presence semantics overloaded to imply who is behind an agent; **execution state stored beside the act log instead of derived from it**; metrics that count message volume instead of outcomes.
