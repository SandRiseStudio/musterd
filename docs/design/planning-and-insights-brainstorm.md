# Planning, work-items & the insight layer — open brainstorm

> **Status: OPEN BRAINSTORM, not spec, not scheduled.** Parked for a *dedicated* session. This is the agenda + everything decided so far, written so a fresh session can pick it up cold without re-reading the originating conversation (2026-06-11/12 dogfooding). Roadmap-level — none of this is v0.2. Parents: `human-agent-dynamics.md` §4 (the philosophy this extends), `../../ROADMAP.md` (the one-line roadmap entry), `../architecture/01-data-model.md` (acts/threads/envelopes this builds on).

## Why this exists

musterd v0.2 attaches all state to **members** (`status_update` + the `working:` roster label = a standup answer). It has no noun for **the work itself** — no board, no backlog, no milestones, no analytics. Real teams (and the companies musterd wants to serve) need leadership to see progress / blockers / milestones, and need PMs to stop hand-compiling status. This brainstorm is how that gets built *without* recreating the thing that makes Jira/standups rot.

## What's already decided (don't re-litigate; build on these)

1. **The governing maxim** (from `human-agent-dynamics.md`): *record facts, enforce boundaries, read meaning out of the durable record — never assert it into config.*
2. **Board = projection over the act log, never a stored second source of truth.** The acts are already kanban's verbs: `handoff` = reassignment, `accept`/`decline` = take/refuse, `request_help`+`meta.blocking` = blocked, `wait` = paused, `status_update.progress` = % done. **A thread is a proto-work-item**: opening act creates it, inner acts are transitions, the latest act is its column.
3. **Declared state splits in two — and only one kind rots.** *Mirroring* declarations (a "in progress" column that restates execution) decay the instant the mirror isn't polished → must be **derived**. *Creating* declarations (backlog/milestones/intent) have no underlying reality to drift from → may be **stored**. So: **execution state is always derived; planned work may be declared.**
4. **Two standing cautions:** **Goodhart** — measure outcomes (threads closed, asks answered, artifacts shipped), *never* message volume (agents emit cheap text). **Surveillance asymmetry** — analytics over agents is operations; over humans it's monitoring → v0.3 need-to-know visibility must govern who sees *derived metrics*, not just raw messages.
5. **Known spec gap:** the act log has **no terminal "done" marker** for a thread (`accept` ≠ finished). A thread-closing signal is a prerequisite the brainstorm must resolve (new act? `meta` on `status_update`? `progress: 1.0` convention?).

## Open threads (the actual agenda)

### A. The minimal planning noun *(the key question — start here)*
What represents *intended work not yet in flight*? Design space:
- **(a) New acts** (`plan` / `propose`) — but acts are deliberately stable; a new act is a SPEC version bump (and Principle: "one member does the work, the team coordinates" — careful a planner role doesn't sneak in, see ROADMAP "explicitly out of scope").
- **(b) A first-class work-item table** that threads reference — most board-like, most weight, a real new entity in the data model.
- **(c) The degenerate version** — *a thread opened with intent that no one has accepted yet.* Leans entirely on what exists.
- **Key discovery that shrinks the problem:** an unaccepted `handoff`/`request_help` to `@team` **already is** a backlog item (work offered, untaken — derivable today). So the noun only needs to cover **intended-but-unoffered** work. Boundary is crisp: *offered-but-untaken* = derive now; *intended-but-unoffered* = needs the noun.
- **Milestones = the same noun at coarser granularity.** One "intended work" concept with granularity (item → milestone/epic); **threads attach to it**; progress against a milestone is *derived* from its threads' states. Declared skeleton, derived flesh.

### B. Leadership reporting = narrative projection at altitudes
The status report should *write itself* from the log (compiling status is exactly the mirror-syncing toil that rots). Same log, three altitudes:
- **IC:** the board (every thread/column).
- **Team:** a digest ("14 threads closed; auth shipped; time-to-unblock up 2×").
- **Exec:** milestones + exceptions ("on track; one risk: session-shape decision blocked 2 days").
Open product questions: **who** asks for the digest, **where** it surfaces (CLI `musterd report`? dashboard? a *scheduled message posted into the team itself* — dogfooding the protocol?), and **cadence** (on-demand vs scheduled routine).

### C. Flow metrics over velocity, plus a metric humans never had
- Drop "velocity"/story points (human estimation theater; elastic agent capacity makes sprint velocity meaningless). Use **Kanban flow metrics** — throughput (threads closed/wk), cycle time (open → terminal act), WIP, work-item age. All derivable.
- **New, agent-native metric: cost per shipped work-item, in dollars.** Agents have meterable token/compute cost. "This milestone cost $340 / 6 days; bottleneck was human review" is a leadership sentence no human-team tool could honestly produce. Needs the log + per-member cost accounting.

### D. The canonical bottleneck is the human — build the "waiting-on" view
In human+agent teams, agents are fast/elastic; **the human is the rate limiter** (decisions, approvals, reviews). The single most actionable insight:
> "8 threads are waiting on nick — oldest 2 days."
Derived from unanswered asks addressed to each member, sorted by age. **Goodhart-safe** (measures queues, not output). Dovetails with **v0.3's approval lane** (human-gated decisions become explicit, queryable waiting states). Also the honest leadership answer to "what's blocking us": often, *us*.

## First questions to open the dedicated session
1. Resolve **A** first — pick the planning-noun shape (a/b/c), since board, milestones, and reporting all depend on it. Recommend starting from (c)+the discovery (derive offered-but-untaken; add the smallest possible noun only for intended-but-unoffered).
2. Resolve the **terminal-done signal** (gap #5) — without it, cycle time and "closed" are undefined.
3. Decide where reporting **lives** (B) and whether a scheduled digest *posts into the team* (protocol dogfood).
4. Sanity-check everything against the two cautions (#4) and the "never store execution state" rule (#3).
