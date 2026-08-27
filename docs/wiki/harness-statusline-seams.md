# Harness statusline seams

Which harnesses can host a musterd seat chip: Claude Code can, and as of 2026-08-26 Codex, Cursor and opencode cannot — surveyed against upstream source and docs, with a falsifier per verdict.

## Why this page exists

ADR 326 put the session orientation on Claude Code's `SessionStart` hook and promised it would greet the human on open. It doesn't: that event has no user-facing seam at exit 0. The [ADR 326 amendment](../decisions/326-session-orientation.md) added a `statusLine` seat chip as the user-facing half.

That raised the portability question. Most of the chip is harness-agnostic — `composeSessionStatusline` is a pure function, and `musterd session statusline --stdin` reads a JSON payload with a `cwd` and prints one line, which any harness that can run a command and render its stdout could use today. Only the settings slot, its installer and its drift check are Claude Code specific.

So the question is narrow: **does each harness expose a slot that runs a command and renders its stdout as persistent UI?** ADR 326 §Distribution already said Codex and opencode lack an *orientation* seam, but a statusline is a different surface and nobody had checked it.

## Verdicts (2026-08-26)

| Harness | Persistent UI slot | Command-driven | Seat chip possible |
| --- | --- | --- | --- |
| Claude Code (interactive) | `statusLine` | yes | **yes — shipped** |
| Claude Code (headless) | none — no TUI to draw in | n/a | no |
| Codex CLI | status line (TUI) | no | no |
| Cursor | none | n/a | no |
| opencode | none | n/a | no (toast only) |

The Claude Code row splits by **driver**, not just harness: a statusline needs a TUI, and headless has none. The [driver support matrix](driver-support-matrix.md) carries the per-driver cells, including a `persistent seat indicator` row pointing back here.

### Claude Code — yes, and it is shipped

`statusLine: {type: "command", command: …}` in `.claude/settings.local.json` runs a shell command per render and draws its stdout. Wired by `installMusterdStatusline`.

### Codex CLI — has a status line, but it is a closed enum

Codex's TUI genuinely has a configurable status line (`codex-rs/tui/src/bottom_pane/status_line_setup.rs`), with an interactive picker for selecting and ordering items. It is **not** extensible by a shell command: the items are a Rust enum, and every variant is a built-in fact Codex already knows — `ModelName`, `CurrentDir`, `ProjectRoot`, `Hostname`, `GitBranch`, `Permissions`, `ApprovalMode`, `ContextRemaining`, `SessionId`, `CodexVersion`, and so on. There is no `Custom`/`Command` variant.

The one variant carrying arbitrary text, `WorkspaceHeadline`, is not a local seam either: it is fetched from the OpenAI app-server via `GetWorkspaceMessagesResponse` and gated behind `response.feature_enabled` (`codex-rs/tui/src/workspace_messages.rs`, refreshed every 5 minutes). A local coordination daemon cannot write it.

> Codex CLI's status line cannot render a locally-produced string (2026-08-26; falsify: check whether `StatusLineItem` still derives `Copy` at `status_line_setup.rs:54` — a variant carrying a `String` cannot be `Copy`, so operator-supplied text is impossible by the type, not merely absent from today's list. If that derive is dropped, re-read the variants: the enum can then hold text and the chip may have a seam here).

That falsifier is deliberately structural rather than enumerative (ryder's #1080 review): "scan ~30 variants and judge each" asks a reader to repeat a survey, and answers only "we looked and did not find one". The `Copy` bound answers "one cannot exist without a derive change", and re-checking it is a single grep.

### Cursor — rich hooks, no persistent UI

Cursor has the largest hook table of the four (`sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `beforeShellExecution`, `beforeSubmitPrompt`, `stop`, `workspaceOpen`, and more), and musterd already uses `sessionStart` for observation under ADR 198. None of them render persistent UI. The user-visible outputs are transient: `user_message` on a denial, and `followup_message` from `stop`, which auto-submits as the next user message rather than displaying a label.

> Cursor exposes no persistent user-visible surface a seat chip could occupy (2026-08-26; falsify: find a documented Cursor hook or setting whose output persists in the UI after the hook returns — the `user_message` and `followup_message` fields do not, they are consumed once).

### opencode — no statusline key; a toast is the nearest thing

The opencode config reference documents TUI keys (`scroll_speed`, `cursor`, `mouse`, `attention`, `theme`) and no statusline/statusbar key. Its plugin event bus is large — including `session.created`, `session.idle`, `session.status` — and carries exactly one UI-rendering call, `tui.toast.show`.

That is a real but different affordance: a toast is a one-shot notification, not a persistent chip. `session.created` + `tui.toast.show` would give an opencode seat a **greeting** — closer to what ADR 326 originally promised than to what the statusline delivers — but it would scroll away and could not answer "which seat is this terminal?" ten minutes later.

> opencode has no persistent statusline slot, only a transient toast (2026-08-26; falsify: find a config key or plugin API in opencode docs that renders text which survives past its triggering event).

## What follows from this

**No adapter work is justified today.** Three of four harnesses have no seam, and the one nearest miss (opencode's toast) delivers a different thing than the chip does. Seats on Codex, Cursor and opencode keep the ADR 326 status quo: the primer text and the wake line, no user-facing seat indicator.

The asymmetry is worth stating plainly, because it is a **product** fact and not only an engineering one: a musterd seat is meaningfully more legible to its human on Claude Code than on the other three, and that gap is imposed by the harnesses, not by musterd.

If it ever needs closing, the two candidates in order of cost are opencode's `session.created` → `tui.toast.show` greeting, and upstream feature requests for a custom status line item in Codex.

Related: [ADR 326](../decisions/326-session-orientation.md), [driver support matrix](driver-support-matrix.md).

## Sources

- Claude Code hooks reference — `https://code.claude.com/docs/en/hooks` (the `systemMessage` discard for `SessionStart`).
- Codex CLI — `openai/codex` at `codex-rs/tui/src/bottom_pane/status_line_setup.rs`, `codex-rs/tui/src/workspace_messages.rs` (read via the GitHub contents API, 2026-08-26).
- Cursor Agent hooks — `https://cursor.com/docs/agent/hooks`.
- opencode — `https://opencode.ai/docs/config/` and `https://opencode.ai/docs/plugins/`.

All four were read on 2026-08-26. These are moving targets; the falsifiers above are the cheap re-checks.
