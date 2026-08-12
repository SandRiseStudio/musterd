# Memory reexamined — git as truth, a governed wiki as synthesis, indexes as caches

- **Status:** design, awaiting approval. Lane `01KZVPW7J5KFJ6PCD05WC0T9BN` (opened by miley at nick's
  request, claimed by ryder). ADR number assigned at PR time via `scripts/adr-next.ts` — reserve with
  a draft PR first (ADR 223).
- **Relates to:** ADR 093 (seat memory — the boundary this re-asserts), ADR 090 (derive-don't-store —
  the doctrine this applies to knowledge), ADR 109 (seat git attribution — what makes wiki writes
  attributable), ADR 173 (absent-is-not-unknown — the staleness cousin), ADR 254 §increments (the
  measure-before-building discipline the retrieval increment reuses).

## Problem

"Memory" is three systems wearing one word, and agents drift between them per-session with no rule:

1. **musterd seat memory** (ADR 093) — server-side, per-seat, envelope-on-occupy. Its Decision says
   _continuity only_: "durable seat knowledge stays in docs … neither goes in the blob."
2. **Claude Code file memory** — `~/.claude/projects/-Users-nick-agents/memory/`: measured today at
   **88 files, 608 KB, with a 9.8 KB hand-maintained index**. One directory serves every seat
   worktree on the machine — it is already de facto _team_ memory, invisible to the team.
3. **Cognee** — third-party, per-user, node-set-tagged. `grep -rli cognee` over the repo returns one
   incidental line. Load-bearing for recall, invisible to musterd and to the repo.

Four findings ground the lane (miley's measurements, 2026-08-12, re-verified at claim):

**1 — ADR 093's boundary exists and nothing enforces it.** Live blob sizes: dolly 5798 · **ryder
3617** · miley 3150 · izzo 2826 · stanley 2451 · compo 256 · wanderer 242. The big blobs are not
continuity notes — they are traps, standing rules, technique. The sharpest evidence is reflexive:
ryder's blob was 2831 when the lane was filed and 3617 two hours later, because the claiming seat
added 786 bytes of durable knowledge _while the lane said not to_ — having read ADR 093 that week.
The boundary is not self-enforcing even for a reader who agrees with it.

**2 — The index goes stale against its own detail, and the index is what gets read.** miley's topic
file said in bold, since 08-03, that a defect was FIXED, naming the PR. The one-line index summary of
the same memory still asserted the defect existed. The summary is what loads into context; miley read
it and broadcast a false claim to seven seats. Structural, not careless: a correction written to the
detail does not propagate to the summary, and nothing detects the contradiction.

**3 — Writes are not observably durable.** A Cognee write today returned `ok:true, queryable:false`
and recalls minutes later were empty. A store that accepts knowledge and cannot say when it is
retrievable means a seat cannot know whether the thing it just saved exists.

**4 — Memory is this week's defect class, unexamined.** The team found six-plus instruments that were
correct when built and wrong when later consulted (reply-shaped `answered`, wake candidacy on unread,
`team_next`'s why, the ADR gate, the review-loop breaker, the uninstrumented install path). Memory is
the same shape: we store observations and read them back as state.

Underneath: musterd's thesis is that an actor without identity cannot be held to anything. A seat's
_knowledge_ currently has no identity, no provenance, and no falsifiability. A fact in Cognee cannot
be cited by a teammate or contradicted by evidence, because nobody else can see it.

## The landscape (researched 2026-08-12, so the bet is informed, not parochial)

Current agent-memory systems make different bets: **Mem0** (user personalization), **Letta**
(OS-style context for one long agent), **Zep/Graphiti** (temporal knowledge graph — every fact-edge
carries _when it was true_ and _when it stopped being true_; new information invalidates, dated,
rather than overwrites), **Cognee** (document corpora into a graph+vector hybrid). Zep's bi-temporal
model is the one that speaks to our failure class: finding 2 _is_ a bi-temporality failure — a claim
true when written, falsified on a known date, with no way to represent the transition. Benchmarks are
vendor-tilted (LoCoMo does not score knowledge updates at all), so none of them decides anything here.

The **LLM-wiki pattern** (Karpathy 2026-04; DeepWiki/AutoWiki for codebases; "wiki memory" in the
frameworks literature) is the synthesis: an agent reads sources once and maintains a compact,
cross-linked wiki of markdown pages — raw sources immutable underneath, the agent reading the wiki
rather than the raw pile. The property that matters: **the wiki layer is just files**, so it can live
in a repo, versioned, reviewed, attributed. It is "git as truth, memory as derived synthesis,"
productized.

## Decision

**Sources of truth stay governed: git for knowledge, the message log for events. Every memory system
is a derived, rebuildable index over those sources — never a second source of truth.** This is
ADR 090's derive-don't-store doctrine applied to knowledge.

Four layers:

| Layer          | What                                                                       | Governance                                             |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Truth**      | git (code, ADRs, wiki pages) + the message log (events)                    | lanes, PRs, CI gates                                   |
| **Synthesis**  | `docs/wiki/` — agent-maintained, dated, falsifiable knowledge pages        | normal review, ADR 109 attribution                     |
| **Continuity** | the ADR 093 blob, re-scoped to its original tiny job                       | musterd; warn-never-block                              |
| **Retrieval**  | Cognee today / a temporal KG if ever / grep always — indexes over the wiki | declared caches; rebuildable; nothing lives only there |

Under this frame, "which memory system is best?" becomes a low-stakes, empirical question about the
index — answerable later, reversibly — because nothing lives only in it.

### The wiki: `docs/wiki/`

One markdown page per topic, ordinary relative cross-links, beside `docs/decisions/` deliberately.
The dividing line: **a choice the team made → ADR; a fact the team learned → wiki page.** (Traps,
techniques, measured numbers, how-X-actually-works.)

**The index is derived, never written.** A script walks the pages and emits the one-line-per-page
index from each page's own first line. Finding 2 becomes structurally impossible: a summary cannot
drift from a detail it is generated from. The hand-written index is the one component this design
deletes outright.

**Claims carry dates and falsifiers.** Page convention, template-carried, gate-checked where lintable:

- A claim of the dangerous shape — _"X is broken / missing / never happens"_ — carries a date and a
  **falsifier**: the command, file, or check that would disprove it. (The prevented incident:
  "autorefresh never installs (2026-07-31; falsify: read `needsInstall` in `service.ts`)".)
- Corrections **invalidate, dated** — "FIXED 2026-08-03 by #570" beside the struck-but-visible old
  claim. Git history supplies bi-temporality for free; the convention keeps it legible on the page.

**`pnpm wiki:check`** joins the `gates` job beside `adr-numbers:check`/`vocab:check`: derived index in
sync with pages; defect-shaped claims carry a date (lintable heuristic — flag matching lines missing a
`(20\d\d-` stamp); no dead intra-wiki links. What cannot be linted (falsifier quality) lives in the
template and in review.

**Writes go through the front door.** A wiki edit is a normal commit by a seat on a normal branch —
ADR 109 attribution, review when non-trivial, merge SHA. Zero new tooling for governance; the entire
enforcement layer is the one the repo already runs.

### The three existing stores

**Claude Code file memory → migrate, then demote.** One triage lane ports the 88-file corpus into
`docs/wiki/`: most pages port nearly as-is; superseded dogfood history goes to an archive page rather
than vanishing; the hand-written `MEMORY.md` index is not ported (replaced by the derived one).
Afterward the harness memory instruction (nick's user-level CLAUDE.md) should direct durable knowledge
to the wiki, keeping the per-machine store for genuinely machine-local facts. **That config edit is
nick's; the design names it as a rollout item a seat cannot do.**

**Seat memory → re-scoped to ADR 093's own text, softly.** Each seat trims its blob to continuity at
its next wrap-up, moving durable content into wiki pages. Enforcement is visibility, not a wall:
`team_memory_save`'s description states "working state only — durable knowledge goes in `docs/wiki/`",
and the envelope-on-occupy already shows body size, so a 5 KB "continuity note" is visibly suspect. A
hard classifier would misfire; warn-never-block is the house style. ADR 093's Decision needs **no
amendment** — this re-asserts it.

**Cognee → declared a cache, in writing.** The ADR states the position musterd has never taken:
third-party retrieval stores are derived and rebuildable; **nothing may live only there**; anything
valuable surfaced from one gets re-materialized into the wiki when touched. Finding 3
(`ok:true, queryable:false`) stops being a knowledge-loss risk the moment the store is not a system of
record.

### Retrieval: grep now, an index when measured need exists

608 KB of markdown _in the repo_ is greppable by every seat with tools it already has. A dedicated
retrieval index (Cognee re-pointed at the wiki, or a Graphiti-class temporal graph) is a **later
increment gated on measured need** — the ADR 254 increment-2 discipline: if grep over the wiki
demonstrably fails to surface pages seats need (measurable: a seat re-derives a fact that had a wiki
page), then evaluate; not before. The temporal-KG insight survives regardless, as the
invalidate-dated convention above.

## What this deliberately does not do

- **No new musterd server surface.** No memory acts, no wiki endpoints. The repo is the store; musterd
  keeps only the continuity blob it already has.
- **No hard enforcement on seat memory.** Warn-never-block; the blob caps (8 KB) stand.
- **No commitment to any retrieval vendor.** Explicitly reversible; the gate is measured need.
- **No generalization beyond this repo.** Whether other projects want a `docs/wiki/` is their call;
  this design governs the musterd/agents corpus only.

## Observability & Evaluation

**Traces.** Wiki writes are commits — attributed (ADR 109), diffable, dated; no new emitter.
`wiki:check` failures are CI events. Seat-memory blob sizes are already queryable server-side
(`seat_memory`), giving a longitudinal series for free.

**Eval.** Dataset: the live corpus and the live blobs. Baseline: today's measurements (88 files /
608 KB un-governed; blob spread 242–5798 bytes, 24×; one known false-broadcast incident caused by
index drift). Measures:

1. **Blob re-scoping.** Median seat-memory body size, before vs 30 days after. Success: the big four
   shrink toward continuity-sized (≲1 KB); the envelope line makes outliers visible.
2. **Index honesty.** Count of `wiki:check` catches (index drift, undated defect claims) — each catch
   is a prevented finding-2 incident, the metric that pays for the gate.
3. **Stale-claim incidents.** False broadcasts traced to a stale memory summary: baseline 1 (miley,
   2026-08-12); target 0.
4. **Retrieval sufficiency** (gates the index increment): instances of a seat re-deriving a fact that
   had a wiki page. Materially non-zero ⇒ evaluate a retrieval index; ~0 ⇒ grep suffices, build
   nothing.

**Experiment.** None for the migration itself — the corpus is small and the change is governance, not
behaviour. The retrieval increment, if measure (4) ever triggers it, warrants a real comparison
(grep vs Cognee-over-wiki vs temporal KG on the team's actual lookup failures) before adoption.

**Reopening triggers.** (1) regressing — blobs regrow — means soft enforcement failed; consider an
envelope warning line. (3) recurring despite the gate means the falsifier convention is not landing;
tighten the lint or the template.

## Increments

1. **The wiki exists** — `docs/wiki/` with template + conventions page, the index generator,
   `wiki:check` in `gates`, and 3–5 seed pages ported as proof (including the two pages this session's
   own knowledge would have gone to). The ADR lands here.
2. **The migration** — triage the remaining ~85 files; separate lane, mechanical, reviewable in
   chunks.
3. **The re-scoping** — `team_memory_save` description text; seats trim at next wrap-up; nick's
   CLAUDE.md rollout item.
4. **Retrieval index** — only if measure (4) fires. Explicitly may never be built.

## Open questions

None blocking. Two calls made here rather than left open: the location is `docs/wiki/` (not
`docs/knowledge/` — the pattern has a name; use it), and the migration is a separate increment so the
ADR is not held hostage to 88 files of triage.
