# 259 — Memory: git as truth, derived indexes as caches

- **Status:** accepted 2026-08-12
- **Relates to:** ADR 090 (derive-don't-store — the doctrine this applies to knowledge), ADR 093
  (seat memory — the boundary this re-asserts), ADR 109 (seat git attribution — what makes wiki
  writes attributable), ADR 173 (absent-is-not-unknown — the staleness cousin), ADR 254 §increments
  (the measure-before-building discipline the retrieval increment reuses).
- **Spec:** `docs/superpowers/specs/2026-08-12-memory-system-reexamination-design.md`

## Context

"Memory" is three systems wearing one word, and agents drift between them per-session with no rule:
**musterd seat memory** (ADR 093 — server-side, per-seat, continuity-only by its own Decision),
**Claude Code file memory** (measured 2026-08-12 at 88 files / 608 KB with a 9.8 KB hand-maintained
index, one directory serving every seat worktree — de facto team memory, invisible to the team), and
**Cognee** (third-party, per-user, invisible to musterd and the repo).

Four findings ground this (measured 2026-08-12, re-verified at lane claim):

1. **ADR 093's boundary exists and nothing enforces it.** Live blob sizes spread 242–5798 bytes
   (24×); the big blobs are traps and technique, not continuity. The claiming seat's own blob grew
   786 bytes of durable knowledge _while the lane said not to_ — the boundary is not self-enforcing
   even for a reader who agrees with it.
2. **A hand-written index goes stale against its own detail, and the index is what gets read.** A
   topic file said FIXED (naming the PR) since 08-03; the one-line index summary still asserted the
   defect; a seat read the summary and broadcast a false claim to seven seats. Structural, not
   careless: corrections to the detail do not propagate to the summary, and nothing detects the
   contradiction.
3. **Third-party writes are not observably durable.** A Cognee write returned `ok:true,
queryable:false` and recalls minutes later were empty — a seat cannot know whether the thing it
   just saved exists.
4. **Memory is this week's defect class, unexamined:** instruments correct when built, wrong when
   later consulted. Memory has the same shape — observations stored, read back as state.

Underneath: musterd's thesis is that an actor without identity cannot be held to anything. A seat's
_knowledge_ currently has no identity, no provenance, and no falsifiability.

## Decision

**Sources of truth stay governed: git for knowledge, the message log for events. Every memory
system is a derived, rebuildable index over those sources — never a second source of truth.** This
is ADR 090's derive-don't-store doctrine applied to knowledge.

| Layer          | What                                                                | Governance                                             |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| **Truth**      | git (code, ADRs, wiki pages) + the message log (events)             | lanes, PRs, CI gates                                   |
| **Synthesis**  | `docs/wiki/` — agent-maintained, dated, falsifiable knowledge pages | normal review, ADR 109 attribution                     |
| **Continuity** | the ADR 093 blob, re-scoped to its original tiny job                | musterd; warn-never-block                              |
| **Retrieval**  | Cognee today / a temporal KG if ever / grep always                  | declared caches; rebuildable; nothing lives only there |

### The wiki: `docs/wiki/`

One markdown page per topic, relative cross-links, beside `docs/decisions/` deliberately. The
dividing line: **a choice the team made → ADR; a fact the team learned → wiki page.** Rules
(carried by `docs/wiki/README.md`, gate-checked where lintable by `pnpm wiki:check` in the
`format:check` chain):

- **The index is derived, never written.** `INDEX.md` is generated from each page's H1 + first body
  line (`pnpm wiki:index`); the gate fails CI on drift. Finding 2 becomes structurally impossible —
  a summary cannot drift from a detail it is generated from. The hand-written index is the one
  component this design deletes outright.
- **Defect-shaped claims carry a date and a falsifier**; the date is lint-enforced, the falsifier is
  template + review. Corrections **invalidate, dated — never overwrite** (git supplies
  bi-temporality; the convention keeps it legible on the page).
- **Writes go through the front door:** a normal branch + commit by a seat — ADR 109 attribution,
  review when non-trivial. Zero new governance tooling.

### The three existing stores

- **Claude Code file memory — migrate, then demote** (increment 2, its own lane): triage the 88-file
  corpus into the wiki; superseded history to an archive page; the hand-written `MEMORY.md` index is
  not ported. Afterward the harness memory instruction (nick's user-level CLAUDE.md) should direct
  durable knowledge to the wiki — **that config edit is nick's, named here as a rollout item a seat
  cannot do.**
- **Seat memory — re-asserted to ADR 093's own text, softly** (increment 3): seats trim blobs to
  continuity at next wrap-up; `team_memory_save`'s description states the boundary; the
  envelope-on-occupy already shows body size, so a 5 KB "continuity note" is visibly suspect.
  Warn-never-block; ADR 093's Decision needs no amendment — this re-asserts it.
- **Cognee — declared a cache, in writing:** third-party retrieval stores are derived and
  rebuildable; **nothing may live only there**; anything valuable surfaced from one gets
  re-materialized into the wiki when touched. Finding 3 stops being a knowledge-loss risk the moment
  the store is not a system of record.

### Retrieval: grep now, an index only on measured need

608 KB of markdown in-repo is greppable with tools every seat has. A retrieval index (Cognee
re-pointed at the wiki, or a Graphiti-class temporal KG) is a later increment gated on measure (4)
below — if grep demonstrably fails, evaluate; not before.

## Consequences

- Increment 1 (this PR): `docs/wiki/` with conventions + four seed pages, the derived index,
  `wiki:check` chained from `format:check`, this ADR.
- Increment 2: the ~85-file migration — separate lane, mechanical, reviewable in chunks.
- Increment 3: the re-scoping — `team_memory_save` description text, seats trim at next wrap-up,
  nick's CLAUDE.md rollout item (nick-only).
- Increment 4: a retrieval index — **only if measure (4) fires; explicitly may never be built.**
  - 2026-08-13: measure (4) was the one measure here with no instrument, and the obvious one — ask a
    seat at wrap-up — is a guaranteed false negative, since a seat re-derives a fact precisely
    because it did not know the page existed. `pnpm wiki:probe` inverts that (the seat names what it
    learned; the machine searches the wiki), the message log is the ledger, and the comparison of
    arms is pre-registered before any data exists:
    `docs/design/2026-08-13-measure-4-retrieval-sufficiency.md`. No index built, and the reading is
    _unmeasured_, not zero — the corpus is one day old; first honest read 2026-09-12.
- Deliberately not done: no new musterd server surface; no hard enforcement on seat memory (blob
  caps stand); no retrieval-vendor commitment; no generalization beyond this repo.

## Observability & Evaluation

**Traces.** Wiki writes are commits — attributed (ADR 109), diffable, dated; no new emitter.
`wiki:check` failures are CI events. Seat-memory blob sizes are already queryable server-side
(`seat_memory`), a longitudinal series for free.

**Eval.** Dataset: the live corpus and the live blobs. Baseline: 2026-08-12 measurements — 88
files / 608 KB un-governed; blob spread 242–5798 bytes (24×); one known false-broadcast incident
caused by index drift. Measures:

1. **Blob re-scoping.** Median seat-memory body size, before vs 30 days after. Success: the big
   four shrink toward continuity-sized (≲1 KB); the envelope line makes outliers visible.
2. **Index honesty.** Count of `wiki:check` catches (index drift, undated defect claims) — each
   catch is a prevented finding-2 incident, the metric that pays for the gate.
3. **Stale-claim incidents.** False broadcasts traced to a stale memory summary: baseline 1
   (2026-08-12); target 0.
4. **Retrieval sufficiency** (gates increment 4): instances of a seat re-deriving a fact that had a
   wiki page. Materially non-zero ⇒ evaluate a retrieval index; ~0 ⇒ grep suffices, build nothing.

**Experiment.** None for the migration itself — small corpus, governance change. The retrieval
increment, if measure (4) ever triggers it, runs a real comparison — grep vs Cognee-over-wiki vs
temporal KG on the team's actual lookup failures — before adopting anything.

**Reopening triggers.** Measure (1) regressing — blobs regrow — means soft enforcement failed;
consider an envelope warning line. Measure (3) recurring despite the gate means the falsifier
convention is not landing; tighten the lint or the template.
