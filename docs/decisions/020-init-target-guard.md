# 020 — `init` target guard: warn before setting up an agent in the wrong folder

- Status: accepted
- Date: 2026-06-17

## Context

`musterd init` binds an agent to the **folder** it runs in: it writes a Claude Code `-s local`
config (or `.cursor/mcp.json`), a `.musterd/binding.json`, and an `AGENTS.md` primer, and mints a
member on the team. The 2026-06-15 dogfood (`implementation-plan.md` §4.A, finding c) ran `init` in
the musterd source repo (`/Users/nick/agents`) instead of the target project — wiring a binding
(folder→`Ryan`) + `config.current=dawn` into the repo itself, with nothing flagging "this isn't the
project you meant." Because the binding is per-folder, a wrong-folder run is a multi-artifact slip
whose only undo is manual: `git restore AGENTS.md`, `claude mcp remove musterd -s local`, and
`musterd team remove` the stray member (ADR 019).

## Problem

Give init a chance to catch a wrong-folder run **before** it writes anything, without:

- **blocking** a genuine run — init must stay runnable in any folder the user means, including this
  repo, for dogfooding;
- adding **schema** — reuse what exists;
- coupling the check to the interactive prompt layer, which is the §4.C wizard-coverage gap.

## Decision

Add a pure heuristic helper `inspectInitTarget(cwd): { warnings: string[] }`
(`packages/cli/src/onboard/guard.ts`) and a thin interactive wrapper `confirmInitTarget()` in
`init.ts`, slotted right after the daemon check (before the team step, so a wrong-folder run bails
before it creates a team or mints anything). When any heuristic trips, init shows the warnings and
a single `p.confirm` defaulting to **yes** — the happy path is at most one extra keystroke.

Three folder-suitability heuristics, in priority order:

1. **cwd is the musterd source checkout** — `package.json` name is `musterd-monorepo`, or the
   `packages/cli` + `packages/server` layout is present. The exact dogfound slip.
2. **cwd already has `.musterd/binding.json`** — already bound to `<member>` on `<team>`; init will
   mint a new member and repoint the binding. (Read via the shared `BindingSchema` + `BINDING_DIR`/
   `BINDING_FILE`, so it can't drift from `config.ts`/the MCP adapter. The harness "already
   configured → repoints" note at `init.ts` is about _harness config_; this is the binding file.)
3. **cwd has an `AGENTS.md` without the musterd primer markers** — an unrelated/contributor
   `AGENTS.md` the primer would append to (finding a). Detected via `hasPrimerMarkers` exported from
   `primer.ts` (same marker constants the primer block uses — no hardcoded copy).

**Why warn, not block.** Every heuristic is a _signal_, not a certainty: a user legitimately
dogfoods in this repo, re-points an existing binding, or has their own `AGENTS.md`. A hard block
would break those; a default-yes confirm makes the slip visible at near-zero cost. Best-effort and
non-throwing: a guard error returns "allow" and never crashes init.

**Why the logic is pure and separate from the prompt.** `inspectInitTarget` takes a `cwd` and
returns strings, so it is unit-tested directly without driving the `@clack/prompts` wizard — exactly
the coverage gap §4.C calls out. `init.ts` owns the I/O.

## Consequences

- A wrong-folder `init` now surfaces a clear, accurate confirm before any artifact is written;
  declining makes no changes. Closes `implementation-plan.md` §4.A finding (c).
- Unit-tested via the pure helper (`onboard.test.ts`): source-tree (both detections), already-bound
  folder (names the member), unrelated `AGENTS.md`, a primer-bearing `AGENTS.md` that does _not_
  trip, a clean folder, and multi-warning accumulation.
- **No cross-folder registry (scoped out).** There is no global index of per-folder bindings, so
  musterd cannot today detect "this member name is already bound in _another_ folder" (the §7
  wording). Adding one would mean having `saveBinding` record each binding's absolute path into the
  global config — a reasonable, additive extension, but out of scope here to keep the PR to the
  three folder-suitability heuristics. Tracked as the follow-up; the §7 collision-guard idea is
  otherwise satisfied by these three checks.
- **Out of scope:** any auto-undo/rollback of a mis-targeted init (manual undo via `git restore` +
  `claude mcp remove` + `team remove` is acceptable for v0.2); the v0.3 seat model.
