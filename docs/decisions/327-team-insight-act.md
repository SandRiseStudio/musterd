# 327 — Team insight act and searchable team memory

- Status: proposed
- Date: 2026-08-25
- Builds on: [ADR 259](259-memory-git-truth-derived-indexes.md) (git-as-truth doctrine and its
  deliberate "no new server surface", which this ADR amends narrowly), [ADR 093](093-persistent-seat-memory.md)
  (seat-private continuity this deliberately does not touch), [ADR 090](090-per-recipient-delivery-status.md)
  / [ADR 212](212-standing-context-budget.md) (derive-don't-store, context budget),
  [ADR 325](325-multi-machine-federation.md) (the three-residence model this rides).

## Context

Nick captured "cross team memory" on 2026-08-22 and clarified it on 2026-08-25: agents repeatedly hit
traps a teammate already recorded — but recorded **privately**, in seat memory, or **ephemerally**,
in free-text stream traffic. The full exploration is
[`docs/design/2026-08-25-team-memory.md`](../design/2026-08-25-team-memory.md); its findings:

1. Seat blobs hold what nick wants shared. ADR 259's measurement stands: blob sizes spread
   242–5798 bytes and the large ones are "traps and technique, not continuity".
2. Findings posted as prose are unfindable. On revive: 3576 `message` + 3065 `status_update` acts,
   and no retrieval surface anywhere (no FTS table, no search verb in CLI or MCP).
3. The governed tier (`docs/wiki/`, ADR 259) is priced for governance — branch, PR, CI, review —
   which is correct for conventions and wrong for one-line traps, especially ones met while working
   in other repos.

Stanley's multi-machine design ([ADR 325](325-multi-machine-federation.md)) places
append-only replicated events in residence 2: origin-stamped, pulled by cursor, rebuildable folds
computed locally. Anything that is an ordinary log event inherits replication across machines for
free; any derived index must stay rebuildable-from-the-log and never becomes a source of truth.

## Problem

Give a team a fast, attributed, dated, *findable* home for mid-size findings without violating the
memory doctrine: no second source of truth (ADR 090/259), no widening of seat-memory privacy
(ADR 093), no context-budget regression (ADR 212), and no store that cannot survive a rebuild under
ADR 325's replication model.

## Decision

**A finding is an event, so it rides the event log.** Three pieces:

### 1. The `insight` act

The twelfth collaboration act: `ACTS += 'insight'` (additive, appended last per `acts.ts`
convention). The envelope **body carries the finding text** (server-enforced cap: ≤2048 bytes);
required `meta.headline` (≤120 chars, the commit-subject discipline ADR 093 chose); optional
`meta.tags` (array of short strings, ≤8) and `meta.repo` (a slug when the finding is repo-bound).
An insight is written **team-visible on purpose** — directed to `@team`, no private variant exists,
so ADR 093's privacy boundary is untouched. Audit records sizes, never content (hard rule 5).

### 2. A derived search index (declared cache)

Migration adds a SQLite FTS5 virtual table projected from `messages WHERE act = 'insight'`, rebuilt
from the log on demand (`rebuild` path shipped with the migration). Search is
`GET /teams/:slug/memory/search?q=…` (member-authenticated), exposed as MCP
`team_insight_search` and CLI `musterd insight search`. The index is a residence-2 fold under
ADR 325: every daemon can rebuild it locally from its own copy of the merged log; nothing lives only
there. Grep-grade relevance only — ADR 259's measure-gated retrieval increment still applies to
anything fancier.

### 3. The promotion norm (guidance, not machinery)

When an insight proves durable, the finder re-materializes it into `docs/wiki/` per ADR 259 — the
insight act remains the event, the wiki page becomes the knowledge. Carried as a skill playbook line
(ADR 085 layering), never enforced by code.

Surfaces: MCP `team_insight_save { headline, body, tags?, repo? }` + `team_insight_search { query, limit? }` (canonical; `team_memory_search` remains as a deprecated alias for one epoch — ADR 296 one-meaning-per-word, ryder finding on #1073); CLI `musterd insight save` / `musterd insight search`; the web tray MAY render insights later (no gate depends on it).

Delivery stays pull-first: insights arrive through the ordinary inbox/stream like any act; no digest,
no standing-context injection (ADR 212).

## Consequences

- Twelfth act; additive per SPEC §6 — senders MUST be current-version, receivers that do not
  recognize `insight` are unaffected (§2's unknown-act tolerance has always been delivery-side).
- ADR 259's "deliberately not done: no new musterd server surface" is hereby amended narrowly: the
  surface added is derived (an index over truth that already exists), not a second truth-carrier.
  Seat memory keeps its continuity-only scope; nothing reads another seat's blob.
- Cross-machine for free under ADR 325: insights replicate as events; each daemon folds its own
  index. No hub CAS — insights are append-only facts, not exclusive claims.
- Spam is the honest risk. Mitigations chosen: headline discipline, size caps, and the eval below;
  if volume outruns value, tag requirements tighten — the act needs no change.
- Increments: (i) protocol enum + meta schema + SPEC; (ii) server acceptance/caps/audit + FTS
  migration + search route; (iii) MCP tools; (iv) CLI + skill guidance line.
- _Implementation note (dated 2026-08-26): increment (i) landed in #1073; increments (ii)–(iv) in
  #1078._ Migration v46 carries the `insights_fts` fold with insert/delete triggers and a
  delete-first backfill; the fold lives in `store/teamMemory.ts` — deliberately named apart from
  `store/insights.ts`, which is the ADR 050 coordination-insight *report* engine, not this. The
  search route is `GET /teams/:slug/memory/search`; surfaces are MCP `team_insight_save` /
  `team_insight_search` (alias `team_memory_search` retained one epoch) and CLI `musterd insight save|search`; guidance v18 (bumped to v19 for the `team_insight_search` rename) carries the playbook
  line (search before you re-derive; promote durable findings into docs/wiki/). The standing-context
  budgets were raised for the tool pair under that file's own raise protocol, each justification
  naming this ADR and the eval that must show the bytes earn their rent.
- _Amendment (dated 2026-09-03, surface survey #1245 item 2): the one-epoch retention of the `team_memory_search` alias elapsed (FEATURE_EPOCH moved 17 → 18 on 2026-09-02, #1200); the alias is removed. `team_memory_save` / `team_memory_read` now say **seat-private** in their descriptions, because every MCP tool wears the `team_` namespace prefix and this pair is where a reader's first guess (shared) is wrong._
- _Amendment (dated 2026-08-27, ryder review of #1073): two dead ADR-325 links cited `325-federation-prereqs-guarded-lane-cas.md` (the PR title) — fixed to `325-multi-machine-federation.md` — and the MCP read name `team_memory_search` drifted from the write/CLI vocabulary `insight` (ADR 296 one-meaning-per-word). Canonical is now `team_insight_search`; `team_memory_search` stays as a deprecated alias for one epoch so existing callers do not bounce. `wiki:check` covers `docs/wiki/` only, so ADR link rot had no gate — follow-up to add a `docs/decisions/` link check is tracked separately._

## Observability & Evaluation

**Traces.** `insight.save` rides existing act telemetry with `insight.bytes` / `insight.tag_count`
attributes (never content); search queries are ordinary tool spans (ADR 089); FTS rebuild logs row
counts.

**Eval.** Pre-registered before build: (1) trap-recurrence — after N weeks, incidents where a seat
hits a trap already described by an earlier insight (retroactive baseline collectable once typed);
(2) search usage per active seat-week — near-zero means the write path built a library nobody walks
into; (3) promotion count — insights re-materialized into wiki pages, the number that proves the
fast tier feeds the governed one.

**Experiment.** Two-week dogfood behind existing seats, comparing trap-recurrence against the
pre-typed-log baseline. Success looks like fewer re-derivations *and* non-zero promotions; failure
looks like high save volume with zero searches — which falsifies the read-path choice, not the act.
