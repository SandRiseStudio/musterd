# Research radar — implementation plan

> **Plan, not built.** The implementation plan for the *ingest* half of musterd's research practice (ADR 056): a scheduled agent that sweeps new research, triages it for relevance, and emits an in-repo digest a human curates. Build later. Corrections via ADR + update this doc. Status: **planned, 2026-06-25**.

## 1. Goal & scope

Keep musterd shaped by the field without a human manually trawling arXiv. Each week the radar sweeps new multi-agent-coordination / human-agent-collaboration research, scores each candidate for relevance to musterd's thesis, and writes a digest. A human decides what graduates: relevant findings append to `research-foundation.md` (evidence); decision-changing ones become an ADR.

**It is:** one scheduled agent + a versioned prompt + a seen-ids file + a markdown digest.
**It is not:** a platform, a web UI, a service, a database, or a queue. (See §10 — the amprealize anti-pattern.)

## 2. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Cadence | **Weekly** | Matches paper-publication pace; daily is mostly empty/noise. |
| Output | **In-repo file** (`docs/research/radar/<YYYY-WW>.md`) | Versioned, diffable, reviewable; a notify pings when ready. |
| Graduation | **Digest only** | Radar surfaces + scores; human picks winners; ADRs/evidence drafted on request. No auto-merge into the thesis. |
| Run location | **Cloud routine** (via the `schedule` skill) | Survives the machine being off; it's a standing job. |

## 3. Architecture — lift, don't reinvent

Both halves already exist in Nick's prior projects (see [[research-radar-prior-art]] in memory). The radar wires proven pieces; it does not design a new pipeline.

| Half | Source project | What to lift |
|---|---|---|
| **Ingestion** | **Exploring Next** (`/Users/nick/sandrise`, prod sandrise.io) | `workers/exploring-ingest/src/index.ts`: `fetchArxivPaper()` (arXiv XML API) + `fetchHuggingFacePaper()` (HF JSON API) — the radar's exact two sources. API-first over scraping; browser UA + ~8s timeout + 2 retries; word-boundary truncation; length guards; store body once. |
| **Triage + artifact** | **amprealize** (`/Users/nick/main`) | `research_service.py` (ingest → comprehend → evaluate weighted-score+veto → verdict ladder); the "brutal honesty" eval prompt; `wiki_service.py` git-backed markdown + frontmatter + index + append-only log + lint (adopt the *convention*, not the service); the unified `LLMClient` + Pydantic phase contracts. |

These are external repos; the radar reimplements the small slices it needs in the musterd repo (or a tiny standalone tool) — it does **not** depend on either project.

## 4. Pipeline (one synchronous run)

1. **Sweep** — arXiv (`cs.MA`, `cs.AI`, `cs.HC`) + HF Papers on a fixed query set: multi-agent coordination, human-agent collaboration, agent failure taxonomies, LLM-agent eval/observability, agent topology, human-in-the-loop. Reuse the Exploring Next fetchers' shape.
2. **Dedup** — drop anything already in `docs/research/radar/seen.json` (by arXiv id / HF id). *This is the gap both prior projects left open — it is load-bearing for digest readability.*
3. **Tier-1 filter (cheap model)** — score the ~50 new candidates for coarse relevance; keep a shortlist (~5–10). Mirrors Exploring Next's cheap-planner pattern.
4. **Tier-2 honest-score (stronger model)** — on the shortlist only: the weighted relevance score + the **brutal-honesty** gut-check + a verdict. Expensive model runs on few items.
5. **Emit** — write the weekly digest + append the surfaced ids to `seen.json`; emit a one-line "digest ready" notify.

Synchronous, single-threaded, no queue. A weekly job has no need for async workers (amprealize proved the sync core works; its queue pivot never shipped).

## 5. File & data conventions

```
docs/research/
  README.md                  # lab notebook (exists)
  radar/
    seen.json                # {"arxiv": [...ids], "hf": [...ids]} — dedup ledger
    <YYYY-WW>.md             # one digest per week
```

Digest frontmatter (adapted from amprealize's `wiki_service`):
```yaml
---
week: 2026-W26
generated: 2026-06-29
prompt_version: radar-v1
tier1_model: <id>
tier2_model: <id>
candidates_seen: 47
shortlisted: 8
---
```
Body grouped by verdict (§6), each entry: title · link · 1-line what · why-it-matters-to-musterd (which thesis dimension / which ADR it touches) · honest gut-check · confidence.

## 6. Triage design

- **Relevance dimensions** (the musterd thesis surface): coordination layer (between-agent), human↔agent loop, notification/reachability, agent eval/observability, failure taxonomies (MAST), multi-agent topology.
- **Weighted score** per amprealize's `EvaluationResult.calculate_overall_score()` shape, with a **relevance floor** (below threshold = `ignore`, never surfaced — the radar's analog of amprealize's safety veto).
- **Verdict ladder** → graduation gate: `ignore` / `record-as-evidence` (→ research-foundation.md) / `consider-ADR` (→ draft an ADR on request). Maps onto amprealize's ADOPT/ADAPT/DEFER/REJECT.
- **Brutal-honesty injection** (verbatim spirit of amprealize's): *"Be ruthlessly honest. If this repackages known ideas, say so. If an existing approach already covers it, name it. Give a 2–3 sentence unvarnished gut-check."* Keeps the radar high-signal and anti-hype; pairs with ADR 056's Goodhart cautions.
- **Prompt versioning** — pin `prompt_version` (e.g. `radar-v1`) and record it + both model ids in every digest's frontmatter. This makes the radar itself a small instance of the ADR 051/052 flywheel — a producer of eval data, not just a consumer.

## 7. Models

Two-tier, cost-conscious (Exploring Next's pattern):
- **Tier-1 (filter):** a cheap, fast model over all new candidates.
- **Tier-2 (honest-score):** a stronger model over the shortlist only.
Model ids live in one config constant; recorded per-run. Avoid amprealize's "Opus for everything" cost and Exploring Next's full multi-provider rotation (overkill for a weekly job) until there's a reason.

## 8. Scheduling

A weekly cloud routine via the `schedule` skill (cron, e.g. Monday 08:00 local). The routine runs the radar command/agent, which writes the digest + updates `seen.json` + notifies. The routine is the one outward-facing artifact — its exact schedule/command gets confirmed before creation.

## 9. Guardrails

- **Read-only sweep**; the radar never edits thesis docs — it only writes its own digest + `seen.json`.
- **No auto-merge** into research-foundation.md or ADRs — human gate (ADR 056).
- **Dedup** via `seen.json` so nothing resurfaces.
- **Volume cap** (top-N shortlist/week) so the digest stays readable; if it ever truncates, it says so (no silent caps).
- **Goodhart / human-vs-agent cautions** (`human-agent-dynamics.md` §4) on any score it reports — diagnostic, never a ranking.

## 10. Anti-patterns to avoid (the amprealize lesson)

amprealize's *core* research_service stayed lean and worked; the platform around it sank it — 5 abstraction layers (behaviors→BCI→actions→workflows→agent-loop), 220 MCP tools, multi-tenant RLS from day one, dual OSS/Enterprise repos, a 400KB monolith, an unfinished queue rearchitecture that became dead code. Radar rules, in order of importance:
1. One cron'd agent + prompt + seen-file + markdown. Nothing more until it has run for weeks.
2. Synchronous. No queue/worker until a measured bottleneck demands it.
3. No DB — git-backed files are the store.
4. No new abstraction layer until 3+ similar pipelines exist to generalize from.
5. Ship minimal end-to-end first; polish (more sources, dashboards, rotation) only after it's earning its keep.

## 11. Build milestones (when implemented)

- **M1 — scaffold:** `docs/research/radar/` + empty `seen.json` + the versioned triage prompt.
- **M2 — ingestion:** arXiv + HF fetchers (port the Exploring Next slices) + dedup against `seen.json`; verify a dry sweep returns sane candidates.
- **M3 — triage:** tier-1 filter + tier-2 honest-score + verdict ladder; verify on a hand-picked week.
- **M4 — emit:** digest writer (frontmatter + verdict grouping) + `seen.json` update + notify.
- **M5 — schedule:** the weekly cloud routine; confirm cadence/command with Nick before creating it.

Each milestone is a complete, runnable step (run the radar by hand through M4 before automating in M5).

## 12. Deferred / open

- Extra sources (Semantic Scholar, specific venues, conference RSS) — after v1 earns it.
- Auto-drafted ADR stubs for top `consider-ADR` hits — explicitly *not* in v1 (chose digest-only).
- A benchmark/leaderboard or dashboard over digests — out of scope; that's the produce-side / batond.

## 13. Connections

- **ADR 056** — this is the ingest mechanism that doc names; `docs/research/` is the produce-side counterpart.
- **ADR 051/052** — prompt-versioning + per-run model/eval recording makes the radar a small flywheel data source, dogfooding the gate.
- **Exploring Next** — beyond ingestion code, it's a ready distribution channel for the produce side: feed a finding/digest to it → a podcast episode about musterd's research. Opportunity, not scope.
