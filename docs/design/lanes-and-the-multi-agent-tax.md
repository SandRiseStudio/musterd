# Lanes & the multi-agent tax — the P3 dogfood post-mortem → design arc

**Status:** design direction (not yet ADR'd). Captured 2026-06-30 from a live brainstorm off the
P3 cutover dogfood. The empirical sections are measured; the design sections are decided-in-principle.
The Phase-1 MVP is spec'd in **[lane-phase1-mvp-spec.md](./lane-phase1-mvp-spec.md)** (draft, for review).

**One line:** *Talk is cheap; wasted work is the tax. musterd's job is to turn a swarm into a team so
the same diff never gets produced twice — by making work-ownership a first-class, contention-aware
primitive (the "lane"), always advising, never gating.*

---

## 1. The session that produced this

Over ~28h on **2026-06-29 → 06-30**, four AI agents + the human (Nick) shipped the **P3 hard cutover**
(the breaking auth migration: per-member `token == identity` → team **agent key** + admin **grants** +
human **credentials**; `hello`/`mskd_` removed). Team "ritual".

| agent | surface | model | lane |
|---|---|---|---|
| June | Claude Code terminal | Opus 4.8 | cutover wiring + test migration + convergence |
| Cleo | Claude Code in Cursor | Sonnet 4.6 | web + server auth (authMember, claim handler, hello removal) |
| riley | Cursor agents | GLM | P3.1/P3.2 substrate — **weakest; wound down, handed off to June** |
| Jasmine | Claude Code | Opus 4.8 | Wave-1 + P0/P1/P2 governance — **clean, then went offline** |

Each ran in its own git worktree/branch. Merge funnel was **riley → June → Cleo → main**.

---

## 2. The data (and a meta-finding)

The only real machine traces of the session were the **musterd message DB** (171 messages) and
**`daemon.log`** (info-level routing metadata, no HTTP layer). Everything *designed* for observability
produced nothing for this window:

- **OTel** is wired into the source but was **inert** (no `OTEL_EXPORTER_*` set → SDK never booted).
- **Langfuse** empty; **PostHog** has no musterd project (never instrumented — zero `posthog` refs in
  the repo); the **audit table** (ADR 071) has 0 rows.

> **Meta-finding:** for a project whose thesis is coordination-observability, the flagship session left
> only a raw message log. → argues for **instrument-by-default** (batond) so the *next* dogfood is
> measurable live, and for treating this session's message DB as the seed coordination-traces dataset.

---

## 3. Empirical findings (measured)

### 3.1 The coordination trace (171 messages)
- **Act mix:** `status_update` 87 (**51%**), `message` 47, `accept` 14, `handoff` 12, `request_help` 9,
  `resolve` **2**, `decline`/`wait` **0**. Senders: June 72, Cleo 41, riley 34, Jasmine 19, Nick 5.
  63% team-broadcast, 37% directed.
- **Threading is broken:** only **2 / 171** carry a `thread_id` (18 set `in_reply_to` in meta). The
  firehose is a flat stream — you can't follow conversations.
- **`resolve` is nearly dead:** 21 loops opened (request_help + handoff), **2** resolved. Work gets
  picked up (14 accepts) but loops don't get closed.
- **Urgency is unstructured:** 0 urgent flags; "URGENT" lived in prose bodies.
- **Every act is a long essay** (handoff avg 1329 chars, request_help 1064, message 1050,
  status_update 639) — the act *label* is a thin veneer over near-identical verbose prose, which is why
  the types "all sound the same."
- **The bottleneck, quantified — directed-act → recipient reply latency:** **207 / 110 / 42 min** early
  (all targeting Nick, the human relay) vs **0–7 min** when two agents were synchronously live in a tight
  loop; one **108-min** gap when a recipient was offline. The human-prompted "check messages" *was* the
  clock. **~10%** of messages were delivered to an offline recipient (→ inbox, seen later). riley sent a
  **duplicate `request_help` 15 s apart** — a blind retry, because there is no delivery/read receipt.
- Connection churn: **132 `ws_hello` / 118 `ws_close`** (respawns, reconnects, 3 deliberate daemon
  restarts).

### 3.2 Git work-shape
- **94 commits authored — all as "Nick Sanders."** Git literally cannot attribute the four agents; only
  musterd's identity layer can. *(An argument for musterd: the coordination trace only exists because of
  the thing we're building.)*
- **The control case:** Jasmine's governance lane touched files no one else did → **1 rebase, 0
  conflicts, 0 dups** — the single-agent ideal. The instant three agents (riley/June/Cleo) edited the
  *same* auth substrate, the topology fractured into ~11 branches, a revert cycle, dup commits, and 2
  emergency reconvergence rebases.
- **riley's lane was redone:** `4eef879` ≡ `0c228bb` (byte-identical patch-id; the second titled
  "…June-confirmed"). A whole agent's output re-produced by another.

### 3.3 Token cost of coordination — **talk is cheap** (measured from Claude Code transcripts)
Writing **and** reading every musterd message consumed **~0.24% of June's fresh tokens, ~1.3% of
Cleo's, ~0.08% of Jasmine's**. A rounding error. The highest-volume messager (June, 63 sends) had nearly
the *lowest* ratio — because it also did the most work; the ratio is set by the denominator, not the
chatter. **This killed an earlier (elegant, wrong) "broadcast N² token cost" hypothesis.** (riley's
GLM/Cursor session writes no Claude transcript — unrecoverable.)

### 3.4 Wasted work — **the actual tax** (measured from git)
**~37% of the code produced never reached main** (range 36–40%; the throwaway pile was **58–68% the size
of everything that shipped**). A **floor** — riley's redone effort isn't in the line-counts.
- **53% of all waste is one commit:** the reverted WS handshake `d08cf43` (1,338 lines) — reverted
  because Cleo built the handshake against a schema June hadn't finished defining. A **dependency
  failure.**
- The rest is **byte-identical dup pairs** — work produced twice because handoffs moved *descriptions*,
  not *branches*.
- *(Rigor: the measurement disproved a fed-in hypothesis — the handshake's `b866c90` was the surviving
  reimplementation, not a discard; counting it would have inflated waste by ~950 lines. 37% is the figure
  that survived skepticism.)*

---

## 4. The theses (settled)

1. **Talk is cheap; wasted work is the tax.** ~1% of tokens vs ~37% of code produced. The multi-agent
   cost is the *redoing*, not the *talking*.
2. **Multi-agent value ∝ decomposition independence.** Fan-out genuinely won on the independent lane
   (Jasmine, parallel governance); it was near-pure tax on the shared-surface cutover. The benefit caps
   at the number of *independent lanes*; the tax scales with *shared-surface contention*. This is the
   "multi-agent trap" as a shape: sublinear-capped benefit vs. contention-driven cost.
3. **The tax bought review.** Cross-lane handoffs forced adversarial checking that caught real bugs (the
   migration/`claims.ts` mismatch; the privilege-escalation hole a solo agent likely ships). → the
   cost-optimal shape for a single shared surface is probably **1 implementer + 1 reviewer**, not N
   contending peers.
4. **Cheap models can be a false economy.** riley/GLM looked cheap per-token, but its output was redone
   in June/Opus tokens. Measure **landed-work per dollar**, not tokens per dollar. A cheap model on a
   shared, high-stakes surface pays twice.

---

## 5. The design direction

### 5.1 Positioning — team, not swarm
Do **not** market "fewest agents" (true internally, deflating externally). Market the *opposite of a
swarm*: **a team** — differentiated owners, roles, lanes, clean handoffs, humans included. A swarm is N
undifferentiated agents racing on the same work and colliding; a team ships. *"Swarms collide; teams
ship."* This silently encodes "the right number of agents on independent lanes" without ever saying
"fewer," and it's on-brand ("work as a teammate, not in isolation").

### 5.2 The model — Team → Project → Lane
```
Team (people, durable roster — the social/coordination unit)
  └── Project / workspace  (a surface-space; git-or-not; members opt in per-project, and
        │                    may be on DIFFERENT projects — team ≠ codebase)
        └── Lane { work-item (what) × owner (who) × surface (where, within this project) }
```
- **Contention is computed per-project, never across.** Two lanes collide only if they share a project
  *and* a surface. (Maps onto the existing ADR-068 *workspace* identity; a folder's seat-binding is a
  member opting into a project.)
- **The lane unifies three prior brainstorms:** work-items (Plan→Goal→feature→task — a task has a
  **done-state**, which fixes dead-`resolve`: a lane is `done` when its surface lands on main,
  auto-detected), roles (assignment bias — a backend task → a backend seat → server surfaces), and
  ownership (a **seat** — agent *or human*, symmetric).

### 5.3 The north star — "never produce the same diff twice"
Three advisory anti-dup layers, mapped 1:1 onto the measured waste:

| layer | fires | catches | measured waste it kills |
|---|---|---|---|
| **intent overlap** | before writing | two lanes claim the same work/surface | the dependency-revert (53% of waste) |
| **observed overlap** | during (file-level warn) | two agents in the same file, live | the near-dups / convergent edits |
| **merge-funnel** (symbol/hunk, git) | at integration | overlapping *diffs* about to land | last-mile collisions |

Plus the non-warning mechanism that kills the biggest single loss: **a handoff transfers the lane *with
its branch/commit*, not a prose description** — so the receiver builds *on* the diff instead of
re-deriving it (the exact `4eef879`≡`0c228bb` failure).

### 5.4 Surface model — graceful degradation (non-git + git)
| tier | needs | gives |
|---|---|---|
| **declared** | nothing (works anywhere, non-git) | intent-level overlap warnings |
| **observed (fs/git)** | a workspace dir | live file-level "who's touching what" |
| **observed (git)** | git | file-level live **+ symbol/hunk merge-funnel + auto-`done` on merge** |

Locked: **file-level warn + symbol-level merge-funnel.** Git is the capability cliff — *that's* the
concrete reason we recommend it. Non-git teams stay at the intent/declared tier, which is Phase 1
(the highest-ROI layer anyway); observation is a git bonus.

### 5.5 The intent signal + what stacks on it
Intent = a **forward-looking, semantic claim** made *before* a file is touched — *"I'm taking the auth
cutover"* — carrying the **work-item** (not a path list), so the earliest warning is semantic and fires
before either agent writes a line. On top: **reconciliation** (intent vs observed edits sharpen the
warning), **dependency edges** (*"needs lane X first"* → the critical path + who blocks whom; this is
the layer that catches the 53%-of-waste revert), and **assignment** (intent + role → proposed
owner/surface).

### 5.6 Killing the human-as-bus (humans stay peers)
The trap was "human as **router**," not "human in the loop." Keep humans as peers (they own lanes,
accept handoffs, do work, get asked); stop making them the switchboard. One primitive: **deliver a
directed act → wake the owner**, with two backends already half-built — resume the agent's loop
(wake-on-message, ADR 054) or notify the human (ADR 024/035); the seat-kind picks the backend. Then an
**escalation ladder**: directed peer → no-ack/blocked → re-route or escalate to a human. Human = the
fallback for *judgment*, not the *default hop*. **Pull > push > ask** (read shared state on demand;
prefer it to broadcasting state or interrupting a peer).

### 5.7 Principles (throughout)
- **Warn + make-visible, never block.** musterd sits *beside* the work, never *in front of* it —
  workflow-agnostic, preserves humans-as-peers. **Not a gatekeeper** (no merge-train, no blocking hooks).
- **musterd held to its own thesis.** The watcher must cost *far* less than the waste it prevents, or it
  becomes the tax. So the observation layer is: **piggyback** a cheap `git diff --name-only` on the
  ambient-presence touch that already fires each command (no poll, no process, **zero agent tokens** —
  it's adapter code, not the LLM); **cheap check first** (file-level set-intersection server-side),
  **expensive analysis gated + lazy** (symbol-level only on the rare file-overlap, once); **silent until
  actionable** (nothing enters an agent's context until a real, directed, small warning).

---

## 6. Phasing

- **Phase 1 — intent + dependency layer.** Declarations + edges. **git-optional** (works for non-git
  teams), cheap, and it catches the *single biggest* waste (the dependency-revert, 53%). Highest ROI,
  build first.
- **Phase 2 — lightweight observation.** Piggybacked git sampling → file-level warn + lazily-escalated
  symbol-level merge-funnel. **Watcher, never gatekeeper**; near-zero standing cost.

---

## 7. Open questions / next steps

- **Phase-1 MVP spec:** the intent/dependency object, its handful of verbs (claim/declare-intent/
  depends-on/handoff-with-artifact/resolve-auto), and *how a warning actually surfaces to an agent
  mid-task* without becoming a broadcast.
- **Surface granularity tuning** — file-level false positives (two agents in one big file, different
  functions); where symbol-level pays for itself.
- **The single-vs-multi experiment** — re-run the P3 cutover single-agent (the stale branches are
  preserved) and compare wall-clock + bugs-caught + wasted-work. The rigorous version of "one agent would
  have been faster."
- **Instrument-by-default** — wire real telemetry so the next dogfood is measurable live (the obs-gap
  finding).
- **Coordination evals** — the metrics this post-mortem computed *are* the first coordination evals:
  wasted-work ratio, resolve-rate, directed-act latency, dup-rate, landed-work-per-dollar.

---

## Appendix — headline numbers
- Coordination = **~1% of tokens** (talk is cheap). Wasted work = **~37% of code produced** (the tax).
- `resolve`: **2 / 21** loops closed. Threading: **2 / 171** messages threaded.
- Directed-act latency: **207/110/42 min** (human relay) → **0–7 min** (both agents live).
- Biggest single waste: `d08cf43`, **1,338 lines** (53% of measured waste), a dependency failure.
