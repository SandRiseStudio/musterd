# 156 — Packaging: lockstep npm release, Homebrew npm-wrapper, Node ≥22 at the boundary

- Status: accepted
- Date: 2026-07-23

## Context

Users install musterd via `pnpm add -g @musterd/cli` / `npx @musterd/cli` (ADR 009). Registry
packages last published at **0.2.0** while `main` moved on — including a new `@musterd/telemetry`
dependency that was never published. There was no in-repo release script, no Homebrew channel, and
packaged installs hit sharp edges: Node &lt;22 + `better-sqlite3` ABI mismatch (crashloop after
`service install`), and `service refresh` only works from a git checkout (ADR 118) without a clear
upgrade path for npm/brew users. Republish stayed human-gated and invisible (ADR 145).

## Problem

Without a repeatable release path and honest post-install messaging, “easy install” stays a stale
npm cut and a dogfood-only checkout story. Agents cannot hold npm credentials; humans need a
script that dry-runs safely and publishes in dependency order when they run it.

## Decision

1. **Lockstep publish of public packages** at a single semver (starting **0.3.0**):
   `@musterd/protocol` → `@musterd/telemetry` → `@musterd/server` → `@musterd/mcp` → `@musterd/cli`.
2. **`pnpm release`** (`scripts/release.ts`): refuse a dirty tree (unless `--allow-dirty`);
   `--dry-run` builds and packs without registry writes; real mode bumps versions, builds, and
   `npm publish`es in order. **No CI publish** in this decision — credentials stay with the human
   (ADR 145). After publish: tag `vX.Y.Z`, bump the brew formula.
3. **Homebrew** via custom tap **`SandRiseStudio/homebrew-musterd`**: an **npm-wrapper** formula
   that depends on Node ≥22 and installs `@musterd/cli@<version>` into the Cellar. Formula source
   of truth lives in-repo (`packaging/homebrew/musterd.rb`) and is copied to the tap. Not
   `homebrew-core` yet; no bottles/SEA/binary.
4. **`engines.node: ">=22"`** on every published package (matches monorepo root). CLI entry
   **fails fast** when the running Node major is &lt;22, with the same PATH/`node@22` voice as the
   existing `service install` ABI probe. Doctor notes for **packaged** installs: update via
   `npm i -g @musterd/cli@latest` / `brew upgrade musterd`; `service refresh` is checkout-only.

Out of scope: embedding `/live` in the published CLI (ADR 062), Windows service, curl|bash
installer, automated brew bump in CI.

## Consequences

- A human can republish current `main` with one scripted path; agents verify with `--dry-run`.
- Brew and npm share one artifact stream — brew tracks npm versions.
- Packaged users get clear Node/upgrade messaging instead of a crashlooping LaunchAgent.
- Docs (README Quickstart) list brew | npm | npx; roadmap must not claim “published” until the
  human publish actually lands.

## Observability & Evaluation

**Traces** — n/a (release/lifecycle, not runtime spans).  
**Evals** — unit tests for release helpers (order, bump, dry-run flags) and CLI Node-gate /
packaged-install notes; human smoke after publish (brew + npm → `musterd init`).

Refs ADR-009, ADR-118, ADR-145.
