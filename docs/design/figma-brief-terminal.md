# Figma Brief 2 — "musterd / Terminal UX"

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

**Audience:** a Figma-capable agent. **These frames ARE the CLI output specification.** The CLI implementation in `packages/cli` must match them exactly — same columns, same glyphs, same color roles. When the CLI and these frames disagree, that is a bug to resolve via ADR, not a free choice. Cross-reference [`brand.md`](./brand.md) §2 (ANSI mapping) and §5 (glossary), and [`../architecture/04-cli.md`](../architecture/04-cli.md) for command semantics.

---

> **Status: EXECUTED** (2026-06-10, see [ADR 008](../decisions/008-ui-ux-figma-execution.md)). File: [musterd / Terminal UX](https://figma.com/design/tgJ7dUNgGmlIMYBVVA5qIQ). The frames mirror the **already-shipped CLI** (reality wins): `cmd/team-add` shows the MCP env block the CLI actually emits (not a generic join token), and `cmd/join` shows the default `cli` surface.

## File

- **Figma file name:** `musterd / Terminal UX`
- **Pages:** `Components`, `Commands`, `States`

## The terminal grid (build on the Brand file's mono grid)

Create a component `terminal/frame`:

- **80 columns × variable rows**, JetBrains Mono `14/22`.
- Background `zinc-900` (`#18181B`), default text `zinc-50`.
- A 2-row chrome header is optional and OFF by default (we show raw output, not a fake window). If shown, use a minimal dotless bar.
- Define **ANSI color styles** as Figma styles, mapped per `brand.md` §2: `ansi/yellow-bold` (accent), `ansi/cyan` (agent name), `ansi/magenta` (human name), `ansi/green` (online/success), `ansi/yellow` (away/warning), `ansi/red` (error/decline), `ansi/bright-black` (dim/meta), `ansi/white` (default).

## Page: Components (build BEFORE Commands)

Each is a Figma component with variants where noted:

1. `cmp/prompt-line` — `$ musterd <…>` ; `$` in bright-black, command in white.
2. `cmp/member-chip` — `name` colored by kind (variant: `agent`=cyan, `human`=magenta) + role in bright-black parens, e.g. `Ada (backend)`.
3. `cmp/presence-dot` — variants `online ●` green / `away ●` yellow / `offline ○` bright-black.
4. `cmp/act-badge` — `[message] [status_update] [request_help] [handoff] [accept] [decline] [wait] [resolve]`. Variant styling: `request_help` yellow-bold, `decline` red, `resolve` green-bold (terminal/done), rest dim white in brackets.
5. `cmp/message-row` — composed: `HH:MM` (bright-black) + `member-chip` + `act-badge` + body (white, wraps at col 80 with 2-space hanging indent).
6. `cmp/table-row` — for `status`/roster: fixed columns, see Commands.
7. `cmp/banner` — **UPDATED ([ADR 114](../decisions/114-cli-rollcall-wordmark.md)):** a rounded nameplate (dim borders) holding three presence dots (online green · away mustard · offline dim), the `musterd` **brand chip** (the lowercase word reversed out of a solid mustard block) with a trailing cursor `▊`, and the tagline in bright-black. No multi-line letter-art. (Source of truth is `renderBanner` in `packages/cli/src/render/rows.ts`.)

## Page: Commands (one frame per command output)

Use realistic data: team `dawn`, members `Ada (agent, backend)`, `Lin (agent, frontend)`, `nick (human, lead)`. Each frame named `cmd/<name>`.

1. `cmd/team-create` — `$ musterd team create dawn` → success line `✓ team "dawn" created` (green ✓), then `you are now a member: nick (human, lead)`, then a hint line in dim: `add members with: musterd team add <name> --kind agent`.
2. `cmd/team-add` — `$ musterd team add Ada --kind agent --role backend` → `✓ added Ada (agent, backend) to dawn` + a dim MCP env block: `connect this agent via MCP with env:` then `  MUSTERD_TEAM=… MUSTERD_MEMBER=… MUSTERD_TOKEN=… MUSTERD_SURFACE=claude-code` (mirrors the actual CLI; a human member instead gets a `musterd join …` hint).
3. `cmd/join` — `$ musterd join dawn --as Ada --token …` → `✓ Ada joined dawn` + presence line `● Ada online via cli` (default surface is `cli`).
4. `cmd/send` — `$ musterd send --to Lin --act handoff "auth module ready for wiring"` → echoes the sent `message-row` with `✓ sent`.
5. `cmd/inbox` — `$ musterd inbox` → header `inbox — dawn (2 unread)`, then 2–4 `message-row`s, newest last; unread marked with a leading accent `▌`. Footer dim: `musterd inbox --watch to follow live`.
6. `cmd/inbox-watch` — `$ musterd inbox --watch` → same header with a live indicator `◉ watching` (green), a stream of rows, and a blinking-cursor affordance at the bottom. Show one incoming `request_help` highlighted (yellow-bold badge) to demonstrate the flagship moment.
7. `cmd/status` — `$ musterd status` → table: columns `MEMBER` (member-chip), `KIND`, `ROLE`, `MODEL` (occupancy-attested model id, ADR 101; absent → `unknown`), `LIFECYCLE`, `ACTIVITY` (presence-dot + surface / working label). One row per member. Header row in bright-black, aligned to 80 cols. (The shipped frame still says `PRESENCE` before LIFECYCLE — frame update tracked with ADR 008 lockstep; code is the source of truth.)

## Page: States (empty + error)

1. `state/empty-inbox` — `inbox empty — nobody's mustered anything yet` (dim). (Exact string; the CLI uses it verbatim.)
2. `state/no-team` — running a team command with no team configured: red `✗ no team — run: musterd team create <name>`.
3. `state/unknown-member` — `✗ no member "Bob" in dawn` (red) + dim hint `musterd status to list members`.
4. `state/server-down` — `✗ can't reach team server at ws://localhost:4849 — is the daemon running?` (red).
5. `state/not-permitted` / generic error — `✗ <message>` red, exit code shown in a side annotation (errors exit non-zero; see `04-cli.md` exit-code table).

For every error frame, annotate the **exit code** in a Figma comment/sticky so the CLI brief and implementation agree.

## Acceptance checklist

- [ ] `terminal/frame` plus all 7 components exist with the listed variants.
- [ ] ANSI color styles exist and match `brand.md` §2 exactly.
- [ ] All 7 `cmd/*` frames exist, 80-col aligned, using the shared components and the canonical sample data.
- [ ] All 5 `state/*` frames exist; each error frame annotates its exit code and uses the verbatim strings above.
- [ ] No glyph or color is used that the CLI can't reproduce in a 16-color ANSI terminal.
- [ ] Every literal string a frame shows is reproducible character-for-character (these are the spec for CLI copy).

## Iteration protocol

1. Build Components first, post screenshots, get sign-off before Commands.
2. Build Commands + States, post per-frame screenshots.
3. Revisions named per frame only (e.g. "`cmd/status` ROLE column should be left-aligned").
4. When green, export the Commands page as PNG reference sheet for the CLI implementer and mark done.
