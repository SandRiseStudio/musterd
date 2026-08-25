# 323 — Codex plugins as reproducible Workspace toolkit state

- Status: accepted
- Date: 2026-08-25
- Builds on: [ADR 031](031-codex-adapter-scope.md) (project-local `.codex/config.toml`, never the
  global file), [ADR 027](027-non-invasive-harness-coexistence.md), [ADR 281](281-multi-harness-worktree-selection.md) <!-- vocab:ok -->
  / [ADR 282](282-multi-harness-reconciler.md) (folder-scoped fragments), [ADR 296](296-terminology-architecture.md)
  (toolkit is Workspace equipment).

## Context

A Codex plugin is enabled by a `[plugins."PLUGIN@MARKETPLACE"]` table. `codex plugin add` writes
that table into **`~/.codex/config.toml`**, so every Codex occupancy on the machine receives it. The
Codex adapter already refuses to write that file (ADR 031): musterd owns only the project-local
`.codex/config.toml`, and Codex itself merges `plugins` from the project file (`plugins` is absent
from Codex's project-local denylist).

Toolkits already declare MCP servers and permissions as Workspace equipment. They had no way to
declare a Codex plugin, so standing up a security seat (Big Body) meant a host-level `codex plugin
add` that leaked onto every other Codex seat.

## Problem

1. How does a Workspace declare "this folder's Codex should run plugin X" so `musterd harness
   configure` can reproduce it, reverse it, and keep it off sibling seats?
2. How does that stay inside ADR 031 — never writing `~/.codex/config.toml` — when `codex plugin
   add` has no project-scope flag?

## Decision

### 1. Toolkits declare Codex plugins as `tools.codex_plugins`

The toolkit schema grows an optional `tools.codex_plugins` array of `PLUGIN@MARKETPLACE` ids
(e.g. `codex-security@openai-curated`). Other harnesses ignore the field — declared intent, the
same degradation Codex already applies to `tools.permissions` (ADR 031 §3). An empty toolkit /
`generalist` declares none.

### 2. The Codex adapter owns one folder-scoped fragment per declared plugin

Fragment key `plugin.<id>`, same container as `[mcp_servers.musterd]`. Desired payload is
`{ plugin, enabled: true }`. The adapter writes `[plugins."<id>"] enabled = true` through the
existing scoped TOML helper (add/replace/remove only those tables; every other section passes
through byte-for-byte). Observation fingerprints the same shape. Removal drops exactly those
tables.

The reconciler reads this folder's v3 `provisioned.json` `toolkit` name and loads that toolkit
(user file in `.musterd/toolkits/`, else a built-in). No toolkit name means no plugin fragments.

### 3. Cache install is a machine prerequisite, not a musterd write

`codex plugin add` installs bits into the machine cache **and** currently enables the plugin in
the global file. Musterd does not shell out to it. The doctor / `init --check` may report that a
declared plugin is not installed; it must not prescribe a command that writes `~/.codex/config.toml`.
The operator installs the cache once; musterd owns only the project-local enable table.

## Consequences

- A security (or any) toolkit that lists `codex-security@openai-curated`, recorded as this
  Workspace's toolkit, plus `musterd harness configure`, enables the plugin in **this folder only**.
- Sibling Codex seats without that toolkit declaration do not pick it up from musterd. A
  pre-existing host-level enable in `~/.codex/config.toml` is outside this ADR; musterd does not
  strip it.
- No new runtime dependency. No protocol / feature-epoch bump: toolkit JSON and
  `.musterd/provisioned.json` stay local.

## Observability & Evaluation

**Traces.** None added; this is local provisioning. The signal is the fragment observation
(`present` / `absent` on `plugin.<id>`) and `musterd harness status --json`.

**Eval.** Round-trip tests: toolkit parse accepts/rejects plugin ids; TOML helper upserts and
removes only the named `[plugins."…"]` table; the Codex adapter emits no plugin fragments for an
empty toolkit and writes/observes/removes a declared plugin without touching neighbouring MCP
tables. Baseline: before this ADR, `provisioned.json` had no plugin contribution and Big Body's
plugin lived only in `~/.codex/config.toml`.

**Experiment.** None yet — dogfood is one seat (Big Body) enabling `codex-security@openai-curated`
from a user toolkit, then confirming a sibling Codex seat without that toolkit does not gain a
project-local plugin table.
