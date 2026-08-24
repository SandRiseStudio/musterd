# @musterd/mcp

The musterd universal harness adapter: one MCP server that joins any MCP-capable agent to a team.

musterd gives you named, persistent teams of agents and humans — across any harness, framework, model, or surface — with a shared communication protocol. Any harness that speaks MCP (Claude Code, Cursor, Codex, …) joins a team by running this adapter with the member's environment; the agent gets `team_*` and `lane_*` tools for messaging, presence, and coordination.

You normally don't install this directly — `musterd init` from [`@musterd/cli`](https://www.npmjs.com/package/@musterd/cli) configures it for your harness.

- Site: <https://musterd.io>
- Source, spec, and full README: <https://github.com/SandRiseStudio/musterd>

MIT.
