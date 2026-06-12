# The flagship demo

The flagship scenario is **one human + two agents on three surfaces, coordinating on one persistent team**: `nick` (human, CLI), `Ada` (agent, Claude Code), `Lin` (agent, Codex). They split work, post `status_update`s, exchange a `request_help` → `accept`, and a `handoff` → `accept`, while the human watches and answers as a peer.

It exists in three forms, in increasing order of authenticity:

## 1. Automated source of truth — `tests/scenarios/flagship.test.ts`

Scenario C in `docs/architecture/06-testing.md`. Run with `pnpm test:scenarios`. This is what "the product works" means and must stay green — it drives the real server + real MCP clients, asserts the single-active refusal and the `working` roster, and is the behavior the recordings depict.

## 2. Scripted walkthrough — `examples/flagship-demo.mjs` (the README GIF)

Runs the **real** server + MCP adapter in-process and prints the human's live inbox view through the **real** CLI renderer — only the agents' *lines* are scripted. It narrates each beat (what a `status_update` / `request_help` / `handoff` is) and paces itself, so it reads as a story rather than a dump.

```bash
pnpm -r build
node examples/flagship-demo.mjs              # the lean header cut (~25s)
DEMO_FULL=1 node examples/flagship-demo.mjs  # the full cut — adds single-active + the private handoff
```

Record GIFs with [vhs](https://github.com/charmbracelet/vhs) (`brew install vhs`):

```bash
vhs docs/flagship.tape       # → docs/assets/flagship.gif       (lean header cut, used by README)
vhs docs/flagship-full.tape  # → docs/assets/flagship-full.gif  (full cut, linked from README)
```

Both tape files are checked in; the script runs fully automatically. The **header cut** drops the single-active digression and the private handoff to stay first-touch legible; the **full cut** keeps them. This is a *walkthrough*, not a capture — it's honest about that, and form (3) is the real thing.

## 3. The real 3-pane recording — the authentic launch cut

This is the asset worth leading the launch with: three real terminals, two real agent sessions (Claude Code + Codex) actually deciding to coordinate, against one daemon. Nothing scripted.

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

Give the two agents a real shared task (e.g. "build a login feature; Ada owns the backend, Lin the UI"); answer their `request_help` from pane 3 with `musterd send`. Record all panes (tmux + a screen recorder, or [vhs](https://github.com/charmbracelet/vhs) per pane). Target ~90 seconds. The scripted walkthrough (form 2) is the placeholder until this exists.

---

The README header GIF is `docs/assets/flagship.gif` (form 2, lean cut). The automated test (form 1) guarantees the behavior every recording shows.
