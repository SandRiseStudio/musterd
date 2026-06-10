# AGENTS.md — Execution Contract

You are an agent implementing **musterd**. This file is the contract. Follow it literally. The docs are written so you can execute end-to-end **without judgment calls** — when you find yourself about to make one, stop and write an ADR instead (see "Deviation protocol").

## Read order (do this before writing any code)

1. `docs/architecture/00-overview.md` → `01` → `02` → `03` → `04` → `05` → `06` → `07` (in order).
2. `docs/design/brand.md` (glossary §5 + ANSI mapping §2 are load-bearing for the CLI).
3. `SPEC.md` (the normative protocol; `02-protocol.md` is its implementation-facing distillation).
4. The relevant `docs/design/figma-brief-*.md` when touching that surface.

The five glossary terms — **Team, Member, Presence, Surface, Act** — mean exactly one thing each (`brand.md` §5). Use them, and only them, in code and prose.

## Build order (strict — do not start a package until the one above passes its acceptance tests)

1. **`@musterd/protocol`** — types + zod schemas (`02-protocol.md`). The contract; everything imports it.
2. **`@musterd/server`** — SQLite store + WS/HTTP + presence + inbox (`01`, `03`). 
3. **`musterd` (CLI)** — human surface (`04`). Done when two humans on one team exchange messages.
4. **`@musterd/mcp`** — universal adapter (`05`). Done when Claude Code joins, then Codex joins, the same team.

Only `@musterd/protocol` is imported across package boundaries. The CLI and MCP talk to the server **over the wire**, never by importing `@musterd/server`.

## Verification command per milestone

| Milestone | Verify with |
|-----------|-------------|
| protocol  | `pnpm --filter @musterd/protocol test` (act-meta rules, envelope round-trip, version pin; ≥95% lines) |
| server    | `pnpm --filter @musterd/server test` (`03-server.md` acceptance list; ≥85%) |
| cli       | `pnpm --filter musterd test` + Scenario A (`06-testing.md`) + Figma terminal snapshot match |
| mcp       | `pnpm --filter @musterd/mcp test` + Scenario B |
| flagship  | `pnpm test:scenarios` (Scenario C — the 3-pane demo as an automated test) |
| any "done"| `pnpm -r build && pnpm -r lint && pnpm test` all green |

A milestone is **done** only when the `07-conventions.md` "Definition of done" checklist is fully satisfied.

## Hard rules (violating these is a bug, not a choice)

1. **Never change `@musterd/protocol` schemas without an ADR.** Other implementations depend on the protocol.
2. **CLI output must match the Figma terminal frames** (`figma-brief-terminal.md`). Snapshot tests enforce it; a divergence is resolved by fixing code or, with an ADR, the frame — never by silently letting them drift.
3. **Docs and code never disagree at the end of a commit.** A behavior change updates its doc in the same commit.
4. **Parse all external input** (frames, HTTP bodies, argv, MCP tool args) through `@musterd/protocol` zod schemas at the boundary. Never trust raw input.
5. **Never log tokens.** Tokens are shown once at `team add` and stored only as `sha256` on the server / chmod-600 config on clients.
6. **No new runtime dependency without an ADR** noting why and the alternative considered.
7. **One Member is not one session.** Presence is where a Member is attached; the Member persists. Don't conflate them in schema, code, or naming.

## Course-correction / deviation protocol

When you find an error, contradiction, missing field, or a better approach:

1. **Do not silently deviate.**
2. Write `docs/decisions/NNN-<slug>.md` (sequential N; template in `07-conventions.md`): Context, Problem, Decision, Consequences.
3. Make the **smallest correct change**.
4. Update the affected doc(s) **in the same commit**, referencing the ADR in the commit footer (`Refs ADR-00N`).

Pre-flagged ADRs you will likely write: **001** (members table folds memberships — `01-data-model.md` already calls this out) and any dependency additions (`hono`, `cac`/`mri`, `tsup`, …).

## What is out of scope for v1 (do not build — it's on `ROADMAP.md`)

Sandbox runtime, schedule **enforcement** (availability is stored, not enforced), team-to-team federation, iOS/web/Slack surfaces, the web dashboard *build* (it's designed in Figma now, built later), Python SDK. Keep the schema fields that anticipate these; don't wire behavior to them.

## Definition of "the product works"

The three automated scenarios in `06-testing.md` pass: (A) two humans on one team, (B) agent + human request_help→accept loop, (C) the flagship 3-pane scenario across CLI + two MCP surfaces. Scenario C is both the final acceptance test and the script for the recorded README demo.
