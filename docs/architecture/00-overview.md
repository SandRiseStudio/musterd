# 00 — System Overview

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

## What we are building

**musterd** is a local-first coordination layer that turns agents (in any harness) and humans into named, persistent **Teams** of **Members**, with shared messaging defined by a versioned protocol (`SPEC.md`). See [`brand.md`](../design/brand.md) §5 for the canonical glossary — those five terms (Team, Member, Presence, Surface, Act) mean exactly one thing each, in code and docs.

The load-bearing architectural idea is the **identity / presence / transport split**:

- **Team** = a standing roster, not a project. It outlives any one repo: reuse the same Team across folders to keep the same agents talking. The folder only decides *where* a Member runs (the folder→agent binding); the Team is the durable, cross-project roster. (Surfaced in `musterd init` copy and `docs/design/human-agent-dynamics.md` §2.)
- **Member** = durable identity (name, kind, role, lifecycle, availability). Not a session.
- **Presence** = where a Member is currently attached (a Surface: cli, claude-code, codex, …). One Member, many possible Presences.
- **Transport** = the Team Server routes each message to wherever the recipient is present; if nobody is present, it lands in the recipient's durable **Inbox**.

## Package dependency graph

```
@musterd/protocol   (types + zod schemas, generated-from-spec, zero runtime deps beyond zod)
        ▲
        │ depends on
   ┌────┴─────┬───────────────┐
@musterd/server   musterd(cli)   @musterd/mcp
 (daemon)       (human surface)  (harness adapter)
```

- `@musterd/protocol` depends on nothing in the repo. It is the contract.
- `@musterd/server` depends on `@musterd/protocol`.
- `@musterd/cli` (the CLI package; installs the `musterd` bin — unscoped `musterd` is blocked on npm, see ADR 009) depends on `@musterd/protocol` (and talks to the server over WS/HTTP — it does **not** import `@musterd/server`).
- `@musterd/mcp` depends on `@musterd/protocol` (and talks to the server over WS/HTTP — it does **not** import `@musterd/server`).

Only the protocol package is imported across boundaries. Everything else communicates over the wire protocol. This keeps the server replaceable (a Python server could speak the same protocol).

## Build order (strict)

1. **`@musterd/protocol`** — envelope + act schemas, member/team/presence types. Nothing else compiles without it.
2. **`@musterd/server`** — SQLite store, WS+HTTP API, presence + inbox. Verified by integration tests against an in-memory DB.
3. **`musterd` (CLI)** — human membership end-to-end. Verified when two humans on one team can exchange messages.
4. **`@musterd/mcp`** — the universal adapter. Verified when a Claude Code session joins a team and a Codex session joins the same team.

Do not start a package before the one above it passes its acceptance tests (`06-testing.md`).

## Reading order for the implementing agent

`00 → 01 → 02 → 03 → 04 → 05 → 06 → 07`, then `AGENTS.md`, then `SPEC.md`. Read all of it before writing code; the docs are designed so that an agent without deep judgment can execute without guessing. When you must guess, stop and write an ADR instead.

## The living-doc / deviation protocol (read this twice)

These docs are prescriptive but fallible. The contract:

1. **Find a problem** (error, contradiction, a better way, a missing field). Do **not** silently deviate.
2. **Write an ADR** in `docs/decisions/NNN-<slug>.md`: Context, Problem, Decision, Consequences. Number sequentially (`001`, `002`, …).
3. **Make the smallest correct change.**
4. **Update the affected doc(s) in the same commit.** Code and docs never disagree at the end of a commit.

Hard rule: **never change `@musterd/protocol` schemas without an ADR.** The protocol is the part other implementations depend on.

## Out of scope for v1 (on `ROADMAP.md`, schema-reserved where noted)

Sandbox runtime, schedule **enforcement** (availability is stored, not enforced), team-to-team federation, iOS/web/Slack surfaces, the web dashboard build, Python SDK. Schema fields that anticipate these (e.g. `availability`, `lifecycle`) exist from day one so nothing is designed into a corner.
