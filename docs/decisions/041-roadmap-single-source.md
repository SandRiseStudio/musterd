# 041 — the roadmap is single-sourced to typed data; ROADMAP.md is generated

- Status: accepted
- Date: 2026-06-23

## Context

The roadmap existed in **two** hand-maintained copies: `ROADMAP.md` (prose, declared the source of
truth) and `packages/web/src/content/roadmap.data.ts` (a typed projection the web roadmap map renders).
The web surface (ADR 037) needs structure the prose can't carry — a `status` enum, `category` lanes,
`dependsOn` edges, a blurb/detail split, and structured ref links — and at a **finer granularity** than
the prose (one `ROADMAP.md` "human↔agent loop" bullet is six cards on the map). Keeping the two in
sync by hand was error-prone and they drifted (the cross-network item shipped in code while both copies
still listed it unbuilt).

## Problem

Eliminate the double-maintenance without losing the web map's structured, card-granular view — and
without adding a runtime/build dependency (hard rule #6).

## Decision

**`packages/web/src/content/roadmap.data.ts` is the single source of truth.** The web imports it
directly (no change there); **`ROADMAP.md`'s item region is generated from it.**

- **Generator:** `scripts/gen-roadmap.ts` renders the items (grouped by status, sorted by category) +
  the "How priorities are decided" section (from `WEDGE`) into `ROADMAP.md` between
  `<!-- BEGIN/END GENERATED ROADMAP -->` markers. The intro and the SPEC-versioning footer stay
  **hand-authored outside** the markers (their single home is `ROADMAP.md`; they aren't shown on the
  web, so no duplication).
- **No new dependency.** The generator runs on **Node's native TypeScript execution** (Node ≥ 22.18;
  the repo `engines` is bumped to `>=22` to match — AGENTS.md already targeted Node 22). It imports the
  data module with an explicit `.ts` specifier; all of `roadmap.data.ts` is erasable syntax.
- **Drift is blocked by the gate.** `pnpm roadmap:gen` writes; `pnpm roadmap:check` fails if
  `ROADMAP.md` is stale, and is wired into `format:check` so the standard verification step catches a
  forgotten regeneration.

This **inverts** the prior "ROADMAP.md stays the source of truth" note (web README, the old
`roadmap.data.ts` header) — both are updated in this commit (living-doc rule).

## Consequences

- **One copy to maintain:** edit the typed module (type-checked, structured), regenerate, done. The web
  reads the source live; `ROADMAP.md` follows automatically.
- **`ROADMAP.md`'s item bullets become generated** (concise, card-shaped) rather than hand-wordsmithed
  grouped prose; its narrative intro/footer remain hand-authored. The "why it's defensible" nuance is
  not re-narrated — it lives in `landscape.md` / `research-foundation.md` (linked), per the AGENTS.md
  anti-pattern against re-narrating.
- **`engines.node` is now `>=22`**; a Node-20 contributor can't run `roadmap:gen` (the repo already
  targeted Node 22). `03-server.md`'s runtime line is aligned.
- No protocol/SPEC change; no product-code change. Tooling + docs only.
- Cross-references: ADR 037 (web surface), `packages/web/README.md`, AGENTS.md "Where each doc lives".
