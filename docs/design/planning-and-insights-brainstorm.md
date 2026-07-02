# Planning, work-items & the insight layer — open brainstorm

> **Addendum (2026-07-02): the design below predates coordination lanes (ADR 083).** ADR 084
> ("lanes join the Plan") reconciles the two work-item nouns: below a Goal, the lane is the declared
> work item when ownership/contention matters (threads stay the conversational fabric + fallback);
> Goal status and flow metrics derive lanes-first over `Goals × lanes × threads` — the join is an
> optional `goal_id` on the lane. Read ADRs 048/050 **as amended by 084**. The frozen record below
> is otherwise unchanged.
>
> **Status: SESSION COMPLETE — decisions frozen (2026-06-24).** All six Parts are LOCKED; see **"Live session — 2026-06-24"** at the bottom (Session decisions + Synthesis). Net design: `Plan → Goal → feature → task`, declared skeleton + derived flesh, zero stored execution state. **Proposed ADRs 048–050** + a build sequence are in the Synthesis. Next step is implementation (write the ADRs when building); this doc is now the frozen design record. The original agenda below is preserved for provenance.
>
> **Status (original): OPEN BRAINSTORM, not spec, not scheduled.** Parked for a *dedicated* session. This is the agenda + everything decided so far, written so a fresh session can pick it up cold without re-reading the originating conversation (2026-06-11/12 dogfooding). Roadmap-level — none of this is v0.2. Parents: `human-agent-dynamics.md` §4 (the philosophy this extends), `../../ROADMAP.md` (the one-line roadmap entry), `../architecture/01-data-model.md` (acts/threads/envelopes this builds on).

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

---

# Live session — 2026-06-24

> This section is the live capture of the dedicated session. It survives reloads. A resuming agent should read this top-to-bottom, then jump to **Resume state** at the end. **Decisions land here as we converge — this doc *is* the handoff artifact** (and the meta-solution to the problem we're brainstorming).

## Scope (locked)

**Full planning + insights layer** — the whole parked agenda in one session: the handoff/orientation spine **plus** leadership reporting (B), flow metrics + cost-per-item (C), and the waiting-on-human view (D). Output → ADR(s) + freeze this doc into accepted design.

## How the session runs (locked)

- **Capture:** decisions written here live (this section).
- **Whiteboard:** attempted via the amprealize tldraw whiteboard (MCP wired into this session). **Abandoned mid-session** — the minimal local stack didn't materialize content (`readcanvas` returned 0 shapes despite successful `addshape` calls; PNG/SVG export null; browser `@tldraw/sync` stuck "Connecting…" though the server accepted the WS). Cleared MCP-wiring/login/CORS/WS-upgrade layers; the content layer itself was the wall. Text + this live doc carried the session (the whiteboard was always *supplemental — text primary*). A fitting data point for the amprealize lessons.
- **Screen recording:** Nick triggers an OS screen recording (⌘⇧5) — can't be started agent-side. Polished *terminal* casts/GIFs are a post-build artifact, not for the design discussion.

## Finalized agenda (dependency-ordered)

1. **The work-item noun & tree + its NAME** *(foundation — resolve first)*
   - Q1: below-feature work = always a thread, or any pre-declared task storage?
   - Q2: add a shallow `parent` to the noun (epic→feature), task depth in the log? — **see amprealize caution below.**
   - **Naming (Nick's note):** "roadmap" reads as coarse public direction, but we now describe a tree teams reference/manage down to task level. Keep "roadmap" for the curated declared top layer and give the managed-work concept its own noun fitting musterd's glossary (Team/Member/Presence/Surface/Act)? Candidates to react to: *Track, Plan, Effort, Item, Objective, Work.* Or collapse: "work item" is the noun, roadmap = its coarsest altitude.
2. **Orientation & handoff** — `musterd next`/`brief` (derived floor: last shipped · in flight · next by wave) + `handoff` act carrying `roadmap_id`; a `musterd done` bundling resolve + handoff-next + roadmap-tick. The fresh-agent self-orientation flow that removes Nick as the human router.
3. **Enforcement ladder** — docs → nudge (ADR-046 posture) → cheap `musterd done` → harness hook (Stop/SessionEnd) → **derived floor that works at zero agent compliance.** How hard on day one.
4. **Leadership reporting** (B) — three altitudes (IC board / team digest / exec milestones); where it surfaces (`musterd report`? a scheduled digest *posted into the team* = protocol dogfood?); cadence.
5. **Metrics** (C) — Kanban flow metrics over velocity; the agent-native one: **cost-per-shipped-work-item in $.** Goodhart guard.
6. **Waiting-on-human view** (D) — "N threads waiting on nick, oldest X" — ties to v0.3's approval lane and the ADR-046 reachability nudge just shipped.

**Cross-cutting:** Goodhart (measure outcomes, never message volume) + surveillance asymmetry (analytics over humans = monitoring → v0.3 need-to-know governs who sees derived metrics).

## Locked framework (don't re-litigate — from the recovered pre-reload brainstorm)

1. **Two sources of truth.** Declared = roadmap (`packages/web/src/content/roadmap.data.ts`); derived = the act log. *Execution state is always derived; planned work may be declared.*
2. **The handoff prompt is 3 bundled layers** — contract (AGENTS.md, write-once), work-item (roadmap + ADR, already persistent + IDed), pointer (per-handoff, tiny). Only the pointer is genuinely per-handoff; that's the toil to kill.
3. **Pointer mechanism** (Nick's pick): a `handoff` act carrying `roadmap_id` + a `musterd next` that reads it back.
4. **Granularity = a ragged tree of intent**, not a board: one recursive work-item noun with optional `parent`; "epic/feature/task" are labels on depth; tasks are *threads* whose latest act is their status. No Kanban board, no hand-maintained columns.
5. **Enforcement = a compliance ladder** with a **derived floor that works at zero agent compliance** — the handoff act *enriches* the brief, it is never *required* for it.
6. **Terminal-done signal** — already solved by `resolve` (ADR 025). The old gap #5 is closed.

## Lessons from amprealize (the cautionary anchor)

Nick's prior platform (`/Users/nick/main/amprealize`) bundled an agile board + work-items and rotted. The dig (read-only, 2026-06-24) found:

- **It STORED execution state and dual-wrote it** — an agent-run table *and* a `work_items.status` column, no transaction between them → drift. Boards were **lost twice and recreated by hand** (`scripts/recreate_boards.py`, `scripts/migrate_board_statuses.sql`). → **Empirical proof of our maxim: execution state is always derived from the act log, never stored.**
- **Its `parent_id` hierarchy (Goal→Feature→Task) was a direct bug source** — failed moves, missing-column INSERTs, board-reorder breakage (`amprealize/services/board_service.py`, 3,438 lines). → **Q2 caution: if we add `parent`, keep it containment-only; build NO move/reorder/column CRUD. The tree's status is derived, never dragged.**
- **Heavy schema rots** — 8+ tables (boards, columns, sprints, sprint_stories, WIP limits, assignment_history). → "Threads *are* the work items, no board entity" is the antidote.
- **14 epics in parallel before proving one thing.** → Ship the **derived `musterd next` floor first**; layer the rest.
- **Polymorphic assignee (user OR agent) caused casting/permission bugs.** → musterd's clean Member kinds already avoid this; don't reintroduce it.

## Session decisions (captured live)

### Part 1 — the noun & tree — LOCKED (2026-06-24)

- **Umbrella noun: `Plan`** — names the whole planned-work layer; `musterd plan` shows it. Plain, fits the Team/Member/Presence/Surface/Act lexicon, strain-free across altitudes.
- **Top altitude: `Goal`** — declared outcomes; **replaces "roadmap" as the coarse level** (roadmap-as-noun retires; the curated top is now "Goals"). Outcome-framed ("what this team is *for*"), more meaningful than a listy "roadmap."
- **Below: feature → task are depth-labels**, not schemas. Features/tasks are **threads** (derived); status = latest act.
- **Q1 — below-feature = always a thread.** No task table, no new entity. Offered-but-untaken threads = backlog (derivable today); only *intended-but-unoffered* needs declaring.
- **Q2 — `parent` is immutable + containment-only.** No move/reorder/column CRUD (exactly where amprealize's `parent_id` rotted). A Goal's progress is **derived** by counting its children's terminal (`resolve`) acts — never typed.
- **Migration (minimal, per amprealize's lesson):** existing roadmap items (IDs like `agent-reachability`) *become* **Goals**; `packages/web/src/content/roadmap.data.ts` stays as the top-altitude store/view — **conceptual reframe, no forced file rename**. A `handoff` will carry `goal_id` (was `roadmap_id`) — see Part 2.
- **amprealize-collision note:** Goal/feature/task *is* amprealize's exact hierarchy, but its rot was **architectural** (stored + dual-wrote execution state), not lexical — so reusing the words as depth-labels on a declared/derived tree is safe.

### Part 2 — orientation & handoff — LOCKED (2026-06-24)

- **Goal status is DERIVED, not stored** *(the session's central decision).* Status = a projection over threads joined by `goal_id`: resolved representative thread → `shipped`; accepted-but-unresolved → `in-flight`; no threads → declared default `planned`. This **kills the manual roadmap status-tick** (the exact mirror-sync toil Clyde hit flipping `agent-reachability` to `shipped` this session).
- **`roadmap.data.ts` keeps the declared skeleton** (Goal existence, intent, `wave`, `dependsOn`) but **drops the `status` field**; the web map and `ROADMAP.md` generator (ADR 041) must read derived status from the act log. "Declared skeleton, derived flesh."
- **`musterd next`** = the brief. **Derived floor (zero-compliance):** last-shipped + in-flight from the act log; next Goal = first un-shipped Goal by `wave`, minus in-flight, minus `dependsOn`-blocked. **Enrichment:** the latest `handoff` act → @team/@me (the human-authored *why*), never required.
- **`handoff` act** carries `--meta goal_id=<id>` as the structured pointer `next` reads back (the `roadmap_id`→`goal_id` rename). Body = the why.
- **`musterd done`** collapses to the honest minimum: `resolve` the thread (+ optionally post the `handoff` for the next goal, which it can compute via the same derivation as `next`). **No status-tick step exists to forget.**
- **OPEN SEAM (→ Part 4):** where do *declared* Goals live for a **general** team? `roadmap.data.ts` is musterd's own dogfood store (a repo file); the product needs an **in-band Goal-declaration** mechanism. Derived status is agnostic to this (it only needs a stable `goal_id`). This is the parked doc's noun-question A at the product altitude.

### Part 3 — enforcement ladder — LOCKED (2026-06-24)

- **Principle: robust to non-compliance, not dependent on it.** The derived floor (Part 2) self-orients a fresh agent even at zero command compliance.
- **The load-bearing act is `resolve`** — it drives derived status; without it Goals look `in-flight` forever. Orientation is auto-injected; `handoff` is enrichment, never enforced.
- **Day-one rungs:** (1) the derived floor; (2) **auto-inject `musterd next` on SessionStart** (the hook already exists in this repo — extends the current inbox-check line); (3) an **ADR-046-style nudge** when you hold an accepted-but-unresolved thread (`⚑ open thread → musterd done`), self-clearing on `resolve`.
- **Deferred:** a SessionEnd/Stop hook (remind before exit).
- **Principle on hooks:** they **remind / inject context, never auto-act as the agent** — auto-posting a `resolve`/`handoff` would assert a fact the agent didn't intend (against "record facts, don't assert"; "one member does the work"). Auto-injecting the *brief* on start is context, not an act → fine.

### Browser access note (whiteboard, dev)
The web-console route guard needs an `amprealize_auth` *session* object, not just `amprealize_token`. To view a room locally, seed a dev session in the browser console (set `localStorage.amprealize_auth` = `{session:{id,actor:{type:'human',role:'ADMIN',surface:'WEB',…},tokens:{accessToken:'dev',tokenType:'Bearer',expiresAt:<future>,scopes:['*']}},pendingConsents:[]}` + `amprealize_token='dev'`, then reload). Server-side PNG export returns null on the minimal stack (no headless renderer) — use the live canvas.

### Part 4 — leadership reporting + Goal-declaration seam — LOCKED (2026-06-24)

- **Reporting = a projection over the act log, never stored** (hand-compiling status is the mirror-toil that rots). Three altitudes from one log: **IC** (the board — every thread, latest-act column), **Team** (digest: "14 threads closed · auth Goal shipped · time-to-unblock 2×"), **Exec** (milestones + exceptions).
- **Day-one surface: `musterd report [--altitude ic|team|exec]`** — on-demand CLI, no scheduler, no new wire traffic.
- **Later: dashboard/web** — same projection on the web console (the roadmap map is already there). Deferred, consistent with the roadmap's deferred dashboard build.
- **Considered, not day-one:** a scheduled digest *posted into the team* (protocol dogfood) — kept as a future enrichment, not the primary surface.
- **Seam resolved (where declared Goals live):** a Goal is declared **in-band as a thread to `@team` carrying goal metadata** (title / `parent` / `wave`); unaccepted = *intended-but-unoffered*. **No new act, no new table.** musterd's own dogfood keeps `roadmap.data.ts` as its curated Goal source. Both are "a Goal source" that `next`/`report` read, joined to threads by `goal_id`.

### Part 5 — metrics — LOCKED (2026-06-24)

- **Flow metrics over velocity** (drop story points — agent capacity is elastic, sprint velocity is meaningless): throughput (threads closed/wk), cycle time (open → `resolve`), WIP, work-item age. All derivable from the act log.
- **Goodhart guard:** measure **outcomes** (threads closed, asks answered, artifacts shipped), **never message volume** (agents emit cheap text).
- **Cost-per-shipped-work-item in $** = the agent-native flagship metric ("this Goal cost $340 / 6 days; bottleneck was human review" — a sentence no human-team tool could honestly produce), but **deferred to the cost-ingestion seam**: it needs per-member token/compute cost accounting (the observability / "batond" surface). Ships when that data exists; not plumbed into musterd's clean core now.

### Part 6 — waiting-on view — LOCKED (2026-06-24)

- The view = `openActionNeeded` (the ADR-024/046 predicate) **aggregated by recipient, sorted by age**: "Waiting on: nick — 8 threads, oldest 2d." Nearly free — reuses shipped machinery.
- **Goodhart-safe by construction:** measures queues (unanswered directed asks), never output or message volume.
- Names the real bottleneck: in a human+agent team the human is the rate-limiter; the honest answer to "what's blocking us" is often "us."
- **Surface:** a section of `musterd report`; the per-person slice already exists as the ADR-046 nudge + the `status` comeback summary.
- **Visibility:** team-wide on localhost now (a queue, transparency unblocks); **v0.3 need-to-know governs** later — same "localhost down-payment → v0.3 governed" posture as availability/notify.
- Natural home for v0.3's approval lane (human-gated decisions = explicit, queryable waiting states).

## Synthesis — the design & build sequence (session complete, 2026-06-24)

**The model in one line:** `Plan` (the layer) → `Goal` (declared outcome, top) → feature → task (threads, derived). **Declared skeleton** (existence, intent, wave, dependsOn, parent) + **derived flesh** (status, progress, reports, metrics, queues) — all projected from the act log. One new declared notion, **zero new execution-state storage.** The entire insight layer is projections over `Goals × threads`.

**Build sequence (down-payment posture — smallest correct floor first):**
1. **Kill the copy-paste (the spine, Parts 1–3):** rename `roadmap_id`→`goal_id` on `handoff`; `musterd next` (derived floor — last-shipped/in-flight from the log + next Goal by `wave`); **derived Goal status** (drop `status` from `roadmap.data.ts`; the web map + `ROADMAP.md` generator read the projection); `musterd done` (resolve + optional handoff); SessionStart auto-inject `next` + the ADR-046-style resolve-nudge.
2. **Insights floor (Parts 4 & 6):** `musterd report [--altitude ic|team|exec]` + the waiting-on section (reuses the predicate).
3. **Metrics (Part 5):** flow metrics (throughput / cycle-time / WIP / age). Cost-per-item deferred to the cost-ingestion seam.
4. **Later:** in-band Goal declaration for general teams; dashboard/web; scheduled team-digest (protocol dogfood); v0.3 governance (need-to-know visibility, approval lane, cost-per-item).

**Proposed ADRs (write when building):**
- **ADR-048 — the Plan/Goal work-item model + derived status** (foundational: declared skeleton, derived flesh; `roadmap.data.ts` drops `status`).
- **ADR-049 — orientation & handoff** (`musterd next`/`done`, `goal_id`, SessionStart auto-inject, resolve-nudge; hooks remind, never auto-act).
- **ADR-050 — insights** (`musterd report` altitudes, flow metrics, waiting-on view; cost + dashboard deferred).

**Standing cautions carried through:** Goodhart (measure outcomes/queues, never message volume); surveillance asymmetry (v0.3 need-to-know governs who sees derived *human* metrics); amprealize's lessons (no stored execution state, no board/column CRUD, minimal immutable hierarchy, prove the slice before breadth).

## Resume state (post-reload — READ THIS FIRST on resume)

- **Why a reload happened:** wired the amprealize whiteboard MCP into this session; the Claude Code extension loads MCP servers only at startup.
- **MCP (CORRECTED location):** the Claude Code extension reads per-project MCP servers from `~/.claude.json` (NOT `.cursor/mcp.json`, which is Cursor's *native* agent — a dead end here, and also not the project `.mcp.json`). The `amprealize` stdio server was added to `~/.claude.json` → `projects["/Users/nick/agents"].mcpServers` (whiteboard startup group, console URL `http://localhost:5273`). Backup at `~/.claude.json.bak.*`. The stale `/Users/nick/agents/.cursor/mcp.json` is unused (harmless, gitignored). After reload, confirm tools via ToolSearch "amprealize".
- **Whiteboard stack (restart each reload — it's session-bound):** `WEB_PORT=5273 /Users/nick/main/amprealize/scripts/brainstorm-min.sh sqlite` — API :8000, sync :3040, web-console :5273. Shared sqlite store `/Users/nick/Main/amprealize/.whiteboard-dev.db` (matches the MCP block). Logs: `/tmp/brainstorm-min-{sync,web}.log`. The script needs `cwd`-independence — it self-`chdir`s, so launch from anywhere. Server boots fine; "Stdin closed, shutting down" on a manual probe is expected (not a crash).
- **Next action on resume:** (1) restart the whiteboard stack; (2) confirm `amprealize` whiteboard tools present (ToolSearch "amprealize"); (3) open a whiteboard (topic "musterd planning & work-item layer", phase `diverge`), share `http://localhost:5273/whiteboard/<id>`; Nick sets `localStorage.setItem('amprealize_token','dev')` in the browser if empty. **SESSION COMPLETE — all six Parts LOCKED.** No resume needed; the design is frozen (see Session decisions + Synthesis). Next step is implementation: write **ADRs 048–050** and build per the Synthesis sequence (start with the copy-paste-killing spine). The whiteboard stack is stopped; don't restart it (it didn't persist content — see "How the session runs").
- **Recording:** Nick triggers ⌘⇧5 screen recording when ready.
- **Recovered transcript of the pre-reload brainstorm** (for full reasoning): session `16fea864-19ef-43bb-8ba1-7dff2acecff7` in `~/.claude/projects/-Users-nick-agents/`.
