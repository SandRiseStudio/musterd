# Team memory — findings a team can find

An exploration of nick's 2026-08-22 capture ("cross team memory"), clarified 2026-08-25: agents re-hit
traps a teammate already recorded privately; findings should be savable so the whole team can access
them. Exploratory design for lane `01M0KNQR70MZTAAENJ2N33S4F6`; freezes once its decisions land in
ADRs. Status: **explored 2026-08-25, multi-machine interaction confirmed against ADR 325** — the
decision itself graduates via a follow-up implementation ADR (a typed act is a SPEC change, hard rule 1).

## The problem, sharpened

musterd has two knowledge tiers and a hole between them:

| Tier | Home | Write cost | Visibility |
| ---- | ------------------------------------------------------------------ | ------------------ | ---------------- |
| Governed knowledge | `docs/wiki/` (ADR 259) | branch + PR + gates | greppable, in-repo |
| Working continuity | seat memory (ADR 093) | one tool call | **seat-private** |
| **The middle** — a trap, a measured number, how-X-actually-works | *nowhere fast* | — | — |

Evidence the middle is real and painful:

1. Seats stash knowledge where it cannot help anyone else. ADR 259's own measurement (2026-08-12):
   live seat blobs spread 242–5798 bytes (24×) and "the big blobs are traps and technique, not
   continuity" — the exact content nick wants shared, locked in a private store.
2. Findings posted as free text are unfindable after the fact. On revive today: **3,576 `message` +
   3,065 `status_update` acts**, and no retrieval surface of any kind (no FTS table in the daemon db,
   no search verb in CLI or MCP). A trap posted yesterday is functionally gone unless you were
   online when it landed.
3. The governed path is priced for its governance. A wiki page costs a branch, commit, push, PR,
   CI, review — right for a convention, wrong for "the daemon crashloops if installed from node 20,
   here is the one-liner". ADR 259 predicted the outcome: seats would keep stashing privately
   (finding 1), and re-scoping the blob was chosen over building a faster shared path.

## Doctrine constraints (what any answer must not violate)

- **Derive-don't-store** (ADR 090): never a second source of truth.
- **Git is truth for knowledge; the message log is truth for events** (ADR 259). Derived stores are
  declared caches, rebuildable, nothing lives only there.
- **Seat memory is private by design** (ADR 093 §4) — team-readable working notes were rejected once;
  whatever shares findings must be a different object with consent built in at write time.
- **Context budget** (ADR 212): delivery must be pull-first or tightly budgeted; no broadcast dump.
- **No secrets** (hard rule 5): audit records sizes, never content.

## Options considered

### A. Discipline only — write the wiki

Rejected as insufficient: finding 1 shows seats already bypass it under friction, and the cost curve
is structural (review is the point for conventions; there is no fast lane). Also repo-bound: traps met
while dogfooding in *other* projects have no wiki to go to.

### B. A team-scoped memory table (new server surface)

`team_memory` rows next to `seat_memory`, MCP save/read/search. Rejected for now: ADR 259's ruling
("deliberately not done: no new musterd server surface") is thirteen days old and nothing measured
since overturns it; a second prose store beside the message log duplicates truth-carriers and invites
the drift ADR 259 exists to prevent. If the log-based option below fails, revisit with a fresh ADR.

### C. Typed insight acts + a derived search index (**recommended**)

The message log is already team-readable, durable, attributed, dated, cursor-addressed truth for
events. "Ghost learned trap T while doing L" *is* an event. So:

1. **Write path**: a typed act — `insight`, carrying `{ headline, body ≤ ~2KB, tags?, repo? }`.
   One tool call from any surface (`team_insight_save` / `musterd insight`), attributed by existing
   provenance machinery, audit-recorded by size only. Additive protocol change → SPEC minor gated by
   its own ADR (hard rule 1).
2. **Read path**: a derived, rebuildable full-text index (SQLite FTS5 projected from the log, same
   posture as every other derived store) plus `team_memory_search "<query>"`. Grep-grade first;
   ADR 259's retrieval-increment gate applies unchanged to anything fancier.
3. **Delivery**: pull-first. At most a one-line digest at task boundaries via existing inbox
   mechanics — never a push into every session's context (ADR 212).
4. **Promotion norm**: when an insight proves durable, it is re-materialized into `docs/wiki/`
   (ADR 259's "re-materialize when touched", pointed upward this time). The insight act stays as the
   event; the wiki page becomes the knowledge.

This keeps every doctrine intact: the log gains no new authority (it already had it), the index is a
declared cache, the wiki stays the synthesis home, privacy is untouched (insights are written
team-visible on purpose).

### D. A shared file sidecar (git-tracked memory file)

Rejected: ADR 093 §4's reasoning applies verbatim — half-done notes and pasted secrets in repo
history, drift between writers, review friction identical to the wiki's.

## Multi-machine interaction (resolved against ADR 325)

Stanley's multi-machine design (ADR 325, PR #1069; census in
`docs/wiki/federation-data-census.md`) keeps "one team, one **authority**" but splits state into
three residences: (1) hub-authoritative linearizable CAS for exclusive facts; (2) locally-appended,
replicated events — every daemon pushes origin-stamped (`origin_node`, `origin_seq`) events and pulls
the merged log with a cursor, the seeds-relay pattern generalized; (3) host-local never-replicated
ephemera (presence, wake leases).

Option C lands entirely in residence 2:

- The `insight` act is an ordinary append-only message-log event — origin-stamped and replicated
  across machines for free once federation lands. A trap recorded on the laptop is findable from the
  studio daemon without any new mechanism.
- The FTS index is a residence-2 *fold*: each daemon rebuilds it locally from its own copy of the
  merged log. It must stay rebuildable-from-the-log — never a source of truth — or it would become
  the first residence-2 object that cannot survive a rebuild (stanley's one explicit warning).
- No hub CAS is needed: insights are append-only facts about having learned something, not exclusive
  claims like lane ownership.

This closes the only open dependency. The design survives multi-machine unchanged.

## What would change the answer

- Measure (4)'s first honest read (scheduled 2026-09-12) showing seats already fail to *find* wiki
  knowledge ⇒ strengthens the read-path investment regardless of the write-path choice.
- Stanley's multi-machine design placing logs per-machine ⇒ C's index becomes per-daemon and
  promotion-to-wiki becomes the only cross-machine channel — which may flip the balance toward B.
- Dogfood evidence that insights would be spam (high volume, low reuse) ⇒ cap per-seat open insights
  or require tags, before any index matters.

## Observability & Evaluation

**Traces.** `insight.save` rides existing act telemetry (sizes, never content); search queries are
tool spans like any other (ADR 089).

**Eval.** Pre-register before any build: (1) trap-recurrence incidents where a later-dated insight
named the same trap — baseline collectable from the log retroactively once typed; (2) search usage
per active seat per week; (3) promotion count (insights → wiki pages) — the number that justifies
the write path's existence.

**Experiment.** None yet; named: run option C behind the existing seats for two weeks and compare
trap-recurrence against the pre-typed-log baseline.
