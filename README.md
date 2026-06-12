```
 _ __ ___  _   _ ___ | |_ ___ _ __ __| |
| '_ ` _ \| | | / __|| __/ _ \ '__/ _` |
| | | | | | |_| \__ \| ||  __/ | | (_| |
|_| |_| |_|\__,_|___/ \__\___|_|  \__,_|
```

**Muster your agents and humans into persistent teams.**

Named, persistent teams of agents and humans — across any harness, framework, model, or surface — with a shared communication protocol. Humans are first-class members, not approvers.

[![license: MIT](https://img.shields.io/badge/license-MIT-E1AD01)](./LICENSE) · [SPEC](./SPEC.md) · [Roadmap](./ROADMAP.md) · [Architecture](./docs/architecture/00-overview.md)

> Status: **v0.1, designed in the open.** Local-first. No account, no cloud required.

<!-- Demo GIF — produced from examples/flagship-demo.mjs or the 3-pane recording; see docs/demo.md -->
![flagship demo: one human + two agents on three surfaces](./docs/assets/flagship.gif)

## The wedge nobody else covers

- **MCP** connects an agent to *tools*.
- **A2A** connects an agent to another agent, *per request*.
- Neither models a **persistent team with identity, presence, and humans as peers.** That's musterd.

A **Member** is an identity, not a session. **Presence** is where that member is currently attached — a Claude Code session, a Codex session, a CLI, later an app — like a person on desktop + phone. The team server routes messages to wherever members are present; offline members get a durable **Inbox**. Coordination outlives any single task or session.

## Quickstart

```bash
pnpm add -g @musterd/cli   # or: npx @musterd/cli <command>   (installs the `musterd` command)

# one command does everything — start the daemon, create a team,
# detect your agent harness, wire up the MCP adapter, and wait for
# your agent to join, live:
musterd init
```

`musterd init` is the magical path: it finds Claude Code / Cursor, asks if it can configure the musterd MCP server for you, then shows a live spinner that flips to `● Ada is online via claude-code` the instant your agent connects.

> Claude Code is registered at its **project-local scope** (keyed by the folder), so it works whether you use the **terminal** (`claude`) or the **editor extension** in VS Code / Cursor — just open that same folder and start a new chat (reload the window if it was already open; check with `/mcp`).

<details><summary>Prefer to do it by hand?</summary>

```bash
musterd serve                                   # start the local daemon (ws://localhost:4849)
musterd team create dawn --as nick --role lead  # create a team; you join as its first human member
musterd team add Ada --kind agent --role backend # add an agent; prints the MCP env for its harness
musterd inbox --watch                            # be present on the team and watch it work
musterd send --to Ada --act message "what's blocking you?"
```

Any MCP-capable harness joins by running the **`@musterd/mcp`** adapter with that env — its agent becomes a Member with six tools: `team_join`, `team_leave`, `team_send`, `team_inbox_check`, `team_status`, `team_members`. The adapter is dormant until it calls `team_join` (explicit activation), and acting (`team_send`/`team_inbox_check`) is gated on having joined. Harness-agnosticism for free.
</details>

## Collaboration acts

Messages carry a typed **Act**, grounded in the [Co-Gym](https://arxiv.org/abs/2412.15701) collaboration-act taxonomy — not ad-hoc text:

`message` · `status_update` · `request_help` · `handoff` · `accept` · `decline` · `wait`

Typed acts and durable inboxes are the point: [MAST](https://arxiv.org/abs/2503.13657) found ~**79% of multi-agent failures are coordination failures** — lost context in handoffs, misalignment — not capability failures. musterd is exactly that coordination layer: explicit identity, durable inboxes, typed acts instead of improvised handoffs.

## Principles

1. **Humans are members, not approvers.** Same envelope, same acts, same inbox as agents — no bolted-on "human-in-the-loop" mode.
2. **An agent is an identity, not a session.** Sessions come and go; the member persists. Presence is where you are, not who you are.
3. **Teams are persistent.** Coordination outlives any single task or session.
4. **Protocol over framework.** We don't run your agent — we connect it. Small core, adapters at the edge.
5. **One member does the work; the team does the coordination.** Multi-agent isn't magic — gains over a single strong agent are often marginal, and most failures are coordination failures. musterd never forces decomposition: a team of one agent (plus optionally a human) is first-class, even default. Add members for true parallelism, separate surfaces, or human collaboration — not to split tasks for its own sake.
6. **Local-first.** SQLite + a local daemon. No account, no cloud required to use it.
7. **Secure by default.** Identities are claimed, not assumed: occupying a seat takes an authorized, audited step, and the safe defaults (live approval, least-privilege credentials, dormant sessions) are the defaults — convenience is an explicit opt-in. _(In design — the seat/grant model: [`membership-model.md`](./docs/design/membership-model.md), [`security.md`](./docs/design/security.md).)_

## How it fits with MCP, A2A, Fleet, CrewAI

| | what it is | musterd's relation |
|---|---|---|
| **MCP** | agent ↔ tools | musterd *uses* MCP as its universal join adapter; it is not a tool server |
| **A2A** | agent ↔ agent, per-request | musterd adds the *persistent team*: identity, presence, durable inbox, humans as peers |
| **Fleet / orchestrators** | run & schedule agent fleets | musterd doesn't run agents; it's the coordination membrane they talk through |
| **CrewAI / frameworks** | build a multi-agent app in one framework | musterd is cross-framework: members join over MCP or the WS/HTTP protocol, whatever harness they live in |

## Packages

| package | what |
|---|---|
| [`@musterd/cli`](./packages/cli) | the CLI + daemon launcher (human surface); installs the `musterd` command |
| [`@musterd/server`](./packages/server) | the team server: SQLite store, WS + HTTP API, presence + inbox |
| [`@musterd/mcp`](./packages/mcp) | the universal harness adapter (one MCP server, six tools) |
| [`@musterd/protocol`](./packages/protocol) | shared types + zod schemas — the wire contract |

The protocol is the only thing imported across boundaries; the server is replaceable by anything that speaks `SPEC.md`.

## Glossary

**Team** — a named, persistent group of Members. **Member** — a durable identity (`agent`/`human`), not a session. **Presence** — where a Member is currently attached. **Surface** — a kind of place a Member can be present (`cli`, `claude-code`, `codex`, …). **Act** — the typed intent of a message. (Canonical definitions: [`docs/design/brand.md`](./docs/design/brand.md) §5.)

## Development

```bash
pnpm install
pnpm -r build
pnpm test            # unit + integration + scenarios
pnpm test:scenarios  # the flagship 3-pane scenario (Scenario C)
```

Contributors and implementing agents: start with [`AGENTS.md`](./AGENTS.md) and [`docs/architecture/00-overview.md`](./docs/architecture/00-overview.md). The docs are prescriptive and the deviation/ADR protocol is enforced — docs and code never disagree at the end of a commit.

## License

[MIT](./LICENSE).
