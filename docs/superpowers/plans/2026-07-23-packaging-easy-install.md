# Packaging / Easy Install — Implementation Plan

> Executed under lane `feat/packaging-easy-install`. Spec: [2026-07-23-packaging-easy-install-design.md](../specs/2026-07-23-packaging-easy-install-design.md). ADR 156.

**Goal:** Users install current musterd via npm/`npx`/Homebrew; post-install fails fast on Node &lt;22.

**Architecture:** `pnpm release` lockstep-publishes `@musterd/*`; brew formula wraps npm; CLI `engines` + Node gate + doctor notes.

See ADR 156 and the attached Cursor plan for task detail. Human publish checklist: [packaging/HUMAN-PUBLISH.md](../../packaging/HUMAN-PUBLISH.md).
