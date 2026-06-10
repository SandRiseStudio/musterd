# The flagship demo

The flagship scenario is **one human + two agents on three surfaces, coordinating on one persistent team**: `nick` (human, CLI), `Ada` (agent, Claude Code), `Lin` (agent, Codex). They split work, post `status_update`s, exchange a `request_help` → `accept`, and a `handoff` → `accept`, while the human watches and answers as a peer.

It exists in three forms:

1. **Automated source of truth** — `tests/scenarios/flagship.test.ts` (Scenario C in `docs/architecture/06-testing.md`). Run with `pnpm test:scenarios`. This is what "the product works" means and must stay green.
2. **Runnable, recordable script** — `examples/flagship-demo.mjs`. Runs the real server + real MCP adapter in-process and prints the human's live inbox view through the real CLI renderer. Build first, then run:
   ```bash
   pnpm -r build
   node examples/flagship-demo.mjs
   ```
   Record a GIF/cast with e.g. [asciinema](https://asciinema.org):
   ```bash
   asciinema rec flagship.cast -c "node examples/flagship-demo.mjs"
   # then: agg flagship.cast docs/assets/flagship.gif   # asciinema gif generator
   ```
3. **The real 3-pane version** (for the launch recording) — three real terminals against one daemon:
   ```bash
   # pane 0: the daemon
   musterd serve

   # pane 0 (setup): create the team and add the agents
   musterd team create dawn --as nick --role lead
   musterd team add Ada --kind agent --role backend     # prints Ada's MCP env
   musterd team add Lin --kind agent --role frontend    # prints Lin's MCP env

   # pane 1: Claude Code with the musterd MCP server configured using Ada's env → Ada joins
   # pane 2: Codex with the musterd MCP server configured using Lin's env       → Lin joins

   # pane 3: the human, present and watching
   musterd inbox --watch
   ```
   Drive the agents to split a real task; answer their `request_help` from pane 3 with `musterd send`. Record all panes (tmux + asciinema, or a screen recorder). Target ~90 seconds.

The README header GIF is produced from form (2) or (3) and lives at `docs/assets/flagship.gif` (referenced by `README.md`). Producing the actual recording is a manual step — the automated test guarantees the behavior the recording shows.
