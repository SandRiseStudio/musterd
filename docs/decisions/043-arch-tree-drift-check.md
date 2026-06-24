# 043 — architecture file trees are drift-checked against the source

- Status: accepted
- Date: 2026-06-24

## Context

The `docs/architecture/*` docs are the "how it's built *now*" layer (AGENTS.md → "Where each doc
lives") and are meant to track code. Several carry a ``## File tree `packages/<pkg>/src/` `` block —
an indented tree where **each line pairs a file with a curated one-line description**. Nothing
enforced that these trees stayed complete, and they drifted: an audit found `04-cli.md` listing **7 of
13** commands and omitting the `notify/` dir and the codex adapter; `03-server.md` missing
`context.ts`/`activity.ts`/`metrics.ts`/`telemetry.ts`/`rows.ts`; `05-mcp.md` missing
`binding.ts`/`workspace.ts`/`otel.ts`/`tools/format.ts`. By contrast `ROADMAP.md` cannot drift —
ADR 041 generates it from a typed source and `format:check` runs `roadmap:check`. The file trees had
no equivalent guard.

## Problem

Stop the architecture file trees from silently falling behind `src/`, **without** discarding the
per-file descriptions that are the trees' whole value.

## Decision

Add a **checker**, not a generator: `scripts/check-arch-trees.ts` (`pnpm arch-trees:check`), wired
into `format:check` after `roadmap:check`. It auto-discovers every doc under `docs/` with a
``## File tree `packages/<pkg>/src/` `` heading, parses the indented fence into the *set* of file
paths it declares, and compares that set to the real `*.ts` files under that `src/` (excluding
`*.test.ts`). Any file in `src/` missing from the doc — or any stale doc entry no longer in `src/` —
fails the check (exit 1) with the exact paths. Native-TypeScript Node script, no build step, no new
dependency (mirrors `gen-roadmap.ts`).

**Why check, not generate.** A generator would have to either drop the descriptions or move them into
a parallel data module (the ROADMAP-style single source). Both are worse here: the description belongs
*next to* the architecture prose, and a newly added file should fail the gate until a human writes a
real description for it — never ship with a blank or auto-stubbed one. So we enforce the **structure**
(the set of files) and leave the **description** hand-authored. This is the `roadmap:check` half of
ADR 041 applied to the trees, without its `roadmap:gen` half.

**Scope.** Only the `src/` file-tree blocks. The checker compares membership of `.ts` files; it does
not validate descriptions, ordering, or indentation beyond what it needs to extract paths. The single
documented exclusion is `*.test.ts` (tests are never in the trees); a deliberate future exclusion
would extend `isIgnored` in the script with a comment.

## Consequences

- **Drift is now caught by `pnpm format:check`** (and therefore CI and the definition of done,
  `07-conventions.md`) for all three trees — server (24 files), cli (37), mcp (16). Adding a source
  file without a doc line fails the gate; the failure names the file.
- The fix that prompted this (the manual resync) plus the checker caught one more straggler the manual
  pass missed — `store/rows.ts` — which is now documented. The checker reports **in sync** for all
  three.
- **New package docs are free**: any future doc that adds a ``## File tree `packages/X/src/` `` heading
  is picked up automatically — no script change.
- **Not covered (accepted):** description accuracy/freshness (prose, not membership), and non-`src`
  trees. The checker guards completeness, not correctness of the words — those stay a review concern.
- No new runtime or dev dependency; `scripts/check-arch-trees.ts` runs on Node's native TS like
  `scripts/gen-roadmap.ts`. Cross-references: ADR 041 (the ROADMAP single-source + check this mirrors),
  AGENTS.md "Where each doc lives".
