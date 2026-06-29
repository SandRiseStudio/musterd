# 065 — One command to add an agent with its own isolated workspace

- Status: accepted
- Date: 2026-06-29

## Context

Dogfooding a two-actor team (a human + an agent, or two agents) on one machine kept hitting **identity
thrash**. The per-folder binding (ADR 018/020) stores one identity in `.musterd/binding.json`, and
`claim` overwrites it. When a second agent ran `claim` in a folder already bound to someone else, the
binding flipped and the first actor lost its seat in that folder. A 2026-06-29 session reproduced it
live: a human (Nick) and an agent (June) both working in `/Users/nick/agents` fought over the one
binding, and a fresh onboarding agent twice escalated to hand-editing the live SQLite DB to get unstuck
(see also the seat-claim-disaster notes).

The deeper constraint is harness-level, not just file-level: **in Claude Code one folder = one
`-s local` MCP registration = one identity.** Two live agent sessions cannot coexist in a folder no
matter how tokens are stored. ADR 059 already gave the machine a multi-identity *vault* (so
`musterd send --as <name>` resolves any known identity regardless of the folder binding — the human is
safe via `--as`). What was missing was an *easy* way to give each agent its own isolated workspace.

A second, related friction surfaced in the same run: re-adding a **soft-removed** member name dead-ended.
`leaveMember` tombstones the row (`left_at` set, ADR 019/058), but the `(team_id, name)` UNIQUE index
still squats the name, so `team add <sameName>` failed with a raw constraint error and no CLI escape.

## Decision

- **`musterd agent <name> [--role <r>] [--here | --path <dir>]`** — one command that (1) adds (or
  revives) the agent member on the team, (2) provisions an **isolated workspace**, (3) writes that
  folder's `binding.json`, and (4) registers the musterd MCP server *there* with autojoin. Opening a
  Claude Code session in the printed folder then **is** that agent — no thrash against your own seat.
  - **Workspace = git worktree by default** (`onboard/workspace.ts`): a sibling dir on its own
    `agent/<name>` branch, so two agents can edit in parallel without colliding on one working tree.
    Outside a git repo it falls back to a sibling folder. `--here` keeps the legacy single-folder
    behavior; `--path` targets an explicit dir.
  - MCP registration reuses the Claude Code adapter with cwd set to the workspace (the adapter's
    `-s local` keys off cwd). If the `claude` CLI is absent, the member + workspace + binding are still
    set up and the exact manual `claude mcp add` line is printed — the command never half-fails silently.
- **Re-adding a soft-removed name revives it** (`store/members.ts addMember`): when a tombstoned row
  holds the name, route to the existing ADR 058 `reviveMember` (reuse the seat id → history stays
  continuous, re-mint the token → deletion was a revocation) instead of a UNIQUE dead-end. This makes
  "add an agent named X" robust even if X was removed before.

## Consequences

- The common multi-agent setup is now one command instead of a five-step worktree + claim + register
  dance, and it stops actors clobbering each other's seats — the structural fix the dogfood asked for.
- The human stays themselves via the ADR 059 vault + `--as`; agents get isolated worktrees. The two
  models compose instead of fighting over one binding.
- The name-squat fix removes a documented "escalate to raw SQL" trap from onboarding.
- Not done here: a clobber *guard* on plain `claim`/`init` (warn before overwriting a different live
  member's binding) — noted as a small follow-up; this ADR removes the *need* to clobber by giving each
  agent its own folder.
- Composes with ADR 018/020 (per-folder binding), ADR 059 (identity vault), ADR 058 (revive), and the
  Claude Code adapter (ADR 027).

## Observability & Evaluation

**Traces** — `musterd agent` is a local provisioning command; it emits no coordination acts itself. The
spans worth attributing if a future `musterd doctor`/provisioning telemetry lands are the structured
result it already returns under `--json`: `{member, team, dir, kind, branch, mcpRegistered}`. The
downstream signal is on the team timeline: the agent it provisions, once a session opens in the
worktree, emits the normal `join` + coordination acts (ADR 051) — this command governs whether that
agent comes online *cleanly* (its own seat) versus displacing another.

**Eval** — success metric: the rate of agent-onboarding attempts that reach a live, correctly-identified
`join` **without** clobbering another actor's binding or escalating to manual DB/`claude mcp` surgery —
target near 100%. **Dataset**: onboarding runs across teams on a dev machine (the dogfood corpus that
produced this ADR). **Baseline**: the pre-065 multi-step flow, where the 2026-06-29 session shows the
collision + raw-SQL-escalation failure mode at high frequency for a second actor in a shared folder.
Unit coverage: `workspace.test.ts` (worktree/folder/here/reuse), `agent.test.ts` (orchestration +
graceful MCP-failure), and the revive path in `store.test.ts`.

**Experiment** — none built yet, but named: once batond exists, compare time-to-first-`join` and
clobber-incident rate for `musterd agent` vs the manual flow across seeded two-actor onboarding runs —
does one-command isolated provisioning measurably cut the "actors fight over a seat" failure (a
concrete MAST environment/coordination failure mode)?
