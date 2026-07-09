# 113 — CLI visual system: a command catalog, a render toolkit, and a warm grouped help

- Status: accepted — ships the CLI UX overhaul; 2026-07-09
- Date: 2026-07-09

## Context

The `musterd` CLI works but does not feel like the product it belongs to. `musterd help` printed the
ASCII banner and then dumped every command as one flat `usage:` list — ~35 lines, no grouping — which
is overwhelming for the humans, agents, and agentic workflows that all read it. Newer commands
(`next`, `lanes`, `report`, `status`) already rendered warmly with sectioned headings and glyphs, but
the older ones were plain and there was no shared render vocabulary, so output drifted command to
command. The `--no-color` global flag was advertised and parsed but wired to nothing (only `NO_COLOR`
and non-TTY detection worked), and line width was hard-coded to 80.

The web surface has a deliberate identity — a **warm isometric office at dusk** ([DESIGN.md](../design/office-rive-character-spec.md),
[08-web.md](../architecture/08-web.md)): "warm, together, at work", "candlelit, not cool blue-gray",
"delight in moments, not on every pixel". The CLI should echo that within the terminal constraints
[brand.md](../design/brand.md) §2 and [figma-brief-terminal.md](../design/figma-brief-terminal.md)
already fix: a **16-color ANSI cap** so output degrades cleanly.

## Problem

Make the CLI warm, scannable, and delightful — one visual language every command speaks — **without**
introducing new hues (16-color cap), **without** hype words ([brand.md](../design/brand.md) §4 bans
"magic"/"revolutionary"; the _experience_ carries the warmth, the words stay plain), and **without**
breaking the guidance drift check ([ADR 085](085-layered-guidance-surface.md)) that treats the help
text as the canonical command inventory.

Three sub-decisions:

1. **Where does the command surface live**, now that help needs a grouped overview, per-command
   detail, a machine-readable form, _and_ the flat string `guidance:check` imports?
2. **What is the shared render vocabulary**, and how does `--no-color` finally become authoritative?
3. **How does warmth read** in a 16-color terminal with plain copy?

## Decision

**1. A structured command catalog is the single source of truth.**
[`packages/cli/src/help/catalog.ts`](../../packages/cli/src/help/catalog.ts) is pure, import-free data
— groups (rooms), and per-command `{ name, signature, summary, group, primary?, detail?, examples? }`.
Four consumers derive from it and nothing is duplicated but names (the [ADR 085](085-layered-guidance-surface.md)
doctrine): the grouped overview and per-command detail ([`render/help.ts`](../../packages/cli/src/render/help.ts)),
the `musterd help --json` catalog dump (a stable surface for agents/agentic workflows), and the plain
`HELP` string ([`help/plain.ts`](../../packages/cli/src/help/plain.ts) → `help.ts`) that walks the whole
catalog, so `guidance:check` stays green by construction. The check now imports the catalog leaf
directly (import-free → hermetic on Node's native TypeScript) instead of the rendered string.

**2. A small render toolkit on the existing picocolors seam — no new deps.**
[`render/ui.ts`](../../packages/cli/src/render/ui.ts) adds the reusable primitives every command
composes: a 16-color-safe glyph set (`✓ ✗ ⚠ ⚑ ⧖ → ↦ ↪ ● ○ ◆ ⎇ ▌ · • …`, mirrored from the web
act-glyph vocabulary), `termWidth()` (real columns, clamped; non-TTY → 80), visible-length padding
(`visibleLen`/`padEndVisible`, ANSI-aware so colored columns still align), `heading`/`subhead`/`rule`/
`hint`/`dim`, an aligned two-column `defList`, and `success(msg, { next })` — the confirmation shape
that never dead-ends (a `✓` plus the obvious next command). [`render/theme.ts`](../../packages/cli/src/render/theme.ts)
swaps its fixed picocolors singleton for a mutable instance behind `setColorEnabled(false)`, wired once
in `bin.ts`: `--no-color` is now authoritative for every command that renders through the seam (and a
`paint` proxy carries the toggle to the `init` wizard's out-of-palette colors). Colour is only ever
forced _off_ — enabling stays with picocolors' auto-detection, so pipes and `--json` never gain ANSI.

**3. Warmth via form, not hue or hype.** The grouped help reads like a floor plan: a short "start
here", then commands grouped into labelled rooms, with flags/examples one `musterd help <command>`
away — which is what kills the flat wall. Identity colour is carried everywhere (agent = cyan, human =
magenta, the 16-color degrade of the web's jade/rose), delight is reserved for moments (a `✓` settle,
an incoming `⚑`), and empty-states are cozy, plain, and reuse the web's own strings (`inbox empty —
nobody's mustered anything yet`). An unknown command or help topic gets a Levenshtein "did you mean".

## Consequences

- One catalog to edit when a command changes; the help views and the guidance invariant follow.
  `guidance:check` reads the catalog leaf, not the rendered string — one less coupling.
- Every command inherits the toolkit; a follow-up pass brings the plainer commands' confirmations and
  empty-states up to the standard incrementally, no big-bang rewrite.
- `--no-color` is a real flag now. Width adapts to the terminal (tests run non-TTY → 80, so the
  existing render assertions are unaffected).
- Reversible and small: the identity stays [brand.md](../design/brand.md)'s one mustard accent + 16
  colours; no new dependency, no wordmark or palette change. Human names remain magenta (the web's warm
  rose degrade) — no brand deviation.

## Observability & Evaluation

- **Traces:** no new acts or spans. Help and the restyle are presentation over existing data; the
  `musterd.cli.command` span ([ADR 089](089-cli-telemetry.md)) already covers `help` like any command,
  and `--json` output is unchanged in shape.
- **Eval:** n/a — this is CLI presentation, not a model-facing capability with a dataset/baseline. The
  guardrails are mechanical instead: `guidance:check` (every skill-named command resolves),
  `arch-trees:check` (the file tree is documented), and the render unit tests
  (`render/ui.test.ts`, `render/help.test.ts`, `help/catalog.test.ts`) pin the visible contract.
- **Experiment:** n/a — no online experiment. The dogfood signal is qualitative: is the next action
  obvious from `musterd help` to a first-time human and to an agent reading `help --json`.
