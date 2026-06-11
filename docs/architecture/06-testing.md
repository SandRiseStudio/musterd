# 06 — Testing

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

Test runner: **vitest** (one config per package, plus a root `pnpm test` that runs all). No test is allowed to hit the network or a real `~/.musterd` — server tests inject an in-memory DB; client tests run against a server started in-process on an ephemeral port (`port: 0`).

## Test pyramid

1. **Unit** (fast, no I/O): `@musterd/protocol` schema/act-meta rules; CLI renderers (`render/rows.ts`); server store functions against a `:memory:` DB.
2. **Integration** (in-process): start `createServer({ db: inMemory })` on `port:0`; exercise HTTP + real WS clients. Covers routing, presence, inbox, auth.
3. **Scenario** (end-to-end, automated): the three acceptance scenarios below, driven through the real HTTP/WS/MCP surfaces against an in-process server. These are the executable form of "does the product work".

## The three acceptance scenarios (automated)

All three are automated and use `seedDawn`-style setup. By placement: **Scenario C** is the dedicated end-to-end test in [`tests/scenarios/flagship.test.ts`](../../tests/scenarios/flagship.test.ts) (run via `pnpm test:scenarios`). **Scenario A** is realized as the CLI end-to-end test [`packages/cli/src/cli.e2e.test.ts`](../../packages/cli/src/cli.e2e.test.ts), and **Scenario B**'s behavior (agent + human `request_help`→`accept` across MCP + CLI) is covered by [`packages/mcp/src/mcp.test.ts`](../../packages/mcp/src/mcp.test.ts) — they live next to the package they exercise rather than under `tests/scenarios/`. All run under the root `pnpm test`.

### Scenario A — two humans on one team
1. `POST /teams {dawn, creator: nick}` → token_nick.
2. `team add bo --kind human` → token_bo.
3. nick (WS) and bo (WS) both `hello`/subscribe.
4. nick `send --to bo --act message "hi"` → bo receives a `deliver`; nick gets `ack`.
5. bo offline (close WS); nick `send --to bo` again; bo `GET /inbox` shows 1 unread, then cursor advance → 0.
**Pass:** message delivered live AND durably; unread counts correct.

### Scenario B — agent + human
1. team `dawn`, members nick (human) + Ada (agent).
2. Boot the **MCP adapter** with Ada's env/token → Ada presence online (surface claude-code).
3. Ada `team_send {act:status_update, body:"scaffolded auth", meta:{progress:0.4}}`.
4. nick `inbox` shows Ada's status_update.
5. nick `send --to Ada --act request_help "tests failing on token hash"`; Ada `team_inbox_check` returns it once; Ada `team_send {act:accept, reply_to:<id>, body:"on it"}`.
6. nick `inbox` shows the accept, threaded under the request_help.
**Pass:** full request_help → accept loop across CLI + MCP surfaces, threading intact, at-least-once dedupe holds.

### Scenario C — the flagship 3-pane scenario (also the README demo)
1. team `dawn`: nick (human), Ada (agent, backend), Lin (agent, frontend).
2. Boot two MCP adapters: Ada (surface claude-code), Lin (surface codex). nick runs `inbox --watch` (WS, present).
3. Ada and Lin each `status_update` as they "split work".
4. Lin `request_help --to Ada` (or to nick); the request surfaces in nick's `--watch` stream highlighted.
5. nick answers as a peer: `send --to Lin --act message "..."`; Ada `handoff` to Lin; Lin `accept`.
6. Assert the full transcript ordering and that all three surfaces saw the relevant messages.
**Pass:** three members across three surfaces coordinate end-to-end; transcript matches expected act sequence. This same script drives the recorded demo.

## Per-module acceptance (must pass before the next package in build order)

- **protocol**: every act's meta rule enforced (accept/decline require `in_reply_to`; unknown act rejected; unknown meta preserved); `Envelope` round-trips; version literal pinned.
- **server**: the bullet list in `03-server.md` "Acceptance tests".
- **cli**: the bullet list in `04-cli.md` "Acceptance tests"; snapshot tests of `status`/`inbox`/`send` output against the frozen `dawn` sample data (and visually against the Figma terminal frames).
- **mcp**: the bullet list in `05-mcp.md` "Acceptance tests".

## Snapshot tests vs Figma frames

CLI render snapshots use the exact `dawn` sample data from the terminal brief (Ada/Lin/nick). When a snapshot changes, diff it against the Figma `cmd/*` frame; if they diverge, either the code is wrong (fix it) or the frame is (ADR + update). The frames and snapshots are kept in lockstep.

## Coverage gates

- `@musterd/protocol`: ≥ 95% lines (it's small and pure).
- `@musterd/server`: ≥ 85% lines, with route/presence/inbox/auth paths covered by integration tests specifically.
- `musterd` (cli) + `@musterd/mcp`: ≥ 75% lines; the command/tool dispatch and error→exit mapping must be covered.
- Root `pnpm test` runs unit+integration+scenario and must be green for any milestone to be "done" (`07-conventions.md` definition of done). CI runs the same command.

## How to run

```
pnpm test            # everything (all packages + scenarios)
pnpm --filter @musterd/server test
pnpm --filter @musterd/server test -- --watch
pnpm test:scenarios  # just tests/scenarios (root script)
```
