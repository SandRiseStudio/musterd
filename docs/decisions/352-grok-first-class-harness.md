# 352 — Grok CLI as a first-class harness

- Status: proposed — 2026-09-02
- Date: 2026-09-02
- Builds on: [ADR 321](321-opencode-first-class-harness.md) (the SURFACES + CHECK + adapter + enumerator + wake playbook this follows for the third time), [ADR 281](281-multi-harness-worktree-selection.md) (a novel harness uses surface `other` until a protocol ADR adds it), [ADR 251](251-native-backend-musterd-as-its-own-harness.md), [ADR 006](006-cursor-surface.md), [ADR 031](031-codex-adapter-scope.md) (project-local config, never the global file), [ADR 165](165-no-secrets-in-shared-mcp-entry.md) / [ADR 286](286-launch-surface-marker.md) (entry carries only `MUSTERD_LAUNCH_SURFACE`), [ADR 166](166-session-liveness-by-enumeration.md), [ADR 150](150-structural-inducement-pretooluse-gates.md), [ADR 326](326-session-orientation.md), [ADR 027](027-non-invasive-harness-coexistence.md), [ADR 135](135-build-provenance-every-runtime.md)
- Lane: `01M1HHH60ETQF5QPTV3PA2KDA8`
- Authored by wanderer, 2026-09-02. The lane was claimed from inside Grok CLI itself, which is both the subject and the evidence.

## Context

Grok CLI (`grok`) is in daily use on this team's machines. A seat can already *act* through it: Grok loads Cursor's `.cursor/mcp.json` via `[compat.cursor] mcps`, the adapter joins, inbox and send work. What it cannot be is **legible**. Occupancy attests surface `cursor` because the inherited entry bakes `MUSTERD_LAUNCH_SURFACE=cursor`. Roster rows read "cursor" where the member is in Grok. Liveness, if it ran, would scan Cursor transcripts. Residency cannot wake a Grok session. `musterd init` writes nothing Grok-native.

Each of those is the known cost of ADR 281's `other` escape hatch, paid until the harness earns its own protocol ADR. Grok has earned it the same way OpenCode did: it is the harness this seat runs in, and the integration facts below were verified against grok 1.0.13 on 2026-09-02 (this machine).

Facts verified 2026-09-02:

- **MCP**: project-local `.grok/config.toml` (`[mcp_servers.<name>]`, `command` / `args` / `env`) plus user `~/.grok/config.toml`. `grok mcp add --scope project` writes the project file. Merge priority is config.toml > Claude > Cursor > `.mcp.json`, so a native `musterd` entry **outRanks** an inherited Cursor one of the same name.
- **Compat hazard**: Grok also loads `.cursor/hooks.json`. If both fire, capture keeps writing `harness: cursor`. `[compat.cursor] hooks` and `mcps` are independent switches.
- **Hooks**: Claude-shaped JSON (SessionStart/End, PreToolUse, PostToolUse, …). Project path `.grok/hooks/*.json`. PreToolUse stdin is `{ toolName, toolInput, sessionId, cwd }` (camelCase), not Claude's `tool_name`/`tool_input`. `UserPromptSubmit` additionalContext on an allowing hook is discarded.
- **Sessions**: `~/.grok/sessions/<encoded-cwd>/<id>/summary.json` with `info.id`, `info.cwd`, `last_active_at` / `updated_at`, `current_model_id`. `grok sessions list` has no `--json`.
- **Resume / headless**: `grok -p <prompt>` fresh; `grok -r <id> -p <prompt>` resume; `--cwd` sets the workspace.
- **Statusline**: `[ui.status_line] type = "command"` pipes JSON to a script and paints stdout — the same class of slot Claude's `statusLine` is.
- **Guidance**: Grok reads AGENTS.md natively (`grok inspect` lists it) and scans `.grok/skills/` plus `.grok/commands/`, and Claude/Cursor skill trees by default.

## Problem

Without a Surface of its own, a Grok occupancy is either anonymous (`other`) or a lie (`cursor`). Liveness reads the wrong transcripts. Residency cannot host it. Provisioning cannot write it. Cursor-compat makes the lie the default path, not an accident.

## Decision

Grok CLI becomes a first-class harness across every seam, landed together — shipping the Surface without the backend would put a legible-looking row on the roster that residency still cannot wake and liveness still cannot judge.

**Parity target is Claude Code, not OpenCode.** ADR 321 is the playbook for *how* a Surface is added (enum, CHECK, adapter, enumerator, wake, together). The *feature* bar is Claude Code wherever Grok actually exposes the seam. OpenCode's thinner hook/statusline story is not a ceiling Grok has to share. Honest omissions are named in §8, not left as "follow OpenCode."

### 1. Protocol: `SURFACES += 'grok'`

`packages/protocol/src/acts.ts` gains `'grok'` between `'opencode'` and `'cursor'` (CLI family together; order is presentation-only). Additive enum widening, versioned per SPEC rules; `SPEC.md` §21's Surface sentence gains it in the same commit. `FEATURE_EPOCH` 16 → 17. The id is `grok` (the binary name), not `grok-cli`: `cli` is already the musterd CLI Surface (humans). Model family `grok` (from `grok-4.6`) is a different field.

### 2. Storage: migration v57 rebuilds the presence CHECK

SQLite cannot ALTER a CHECK. v57 follows the v39/v44 playbook: create-table-with-new-CHECK → copy → drop → rename, one transaction. The CHECK list is the **live** enum (including `opencode` and `musterd`) plus `grok`. Do not "fix" the stale v1 DDL in `schema.ts` as this change — migrations own the live CHECK. Pin in `db.test.ts`.

### 3. Provisioning adapter: project-local only

`harnesses/grok.ts` implements `Harness`: id `grok`, label "Grok CLI", surface `grok`, `entryScope: 'folder'`. Detection is a `grok` binary on PATH or a `.grok/` directory. Configuration writes **only** project-local `.grok/config.toml`:

- `[mcp_servers.musterd]` pointing at the same stdio command every other adapter writes, env **exactly** `{ MUSTERD_LAUNCH_SURFACE = "grok" }` (ADR 165/286). Prefer `grok mcp add --scope project` when the binary is present; otherwise upsert the `[mcp_servers.*]` tables with the existing Codex TOML helper (same shape; no new TOML dependency).
- `[compat.cursor] hooks = false` so inherited Cursor hooks do not steal capture. Leave `[compat.cursor] mcps` on so other Cursor-registered servers still load; the native `musterd` name wins.

Never write `~/.grok/config.toml`. A musterd entry found only there is `registeredElsewhere` (ADR 168): inspect, never prescribe `wire`. Unprovision removes the `musterd` server tables only; it leaves the hooks-compat key (removing it would re-enable the double-fire).

### 4. Guidance: AGENTS.md plus Grok's native skill/command dirs

Grok reads AGENTS.md natively, so the primer is already its team block. It also scans `.grok/skills/` and `.grok/commands/`. The adapter declares `HarnessGuidance` with `skillPath: '.grok/skills/musterd/SKILL.md'`, `frontmatter: 'claude-code'` (Grok loads Claude-flavored skills), and `commandsDir: '.grok/commands'`. Canonical `.musterd/skill/` remains the source; these are shells (ADR 085). Do not build orientation on SessionStart additionalContext — Grok discards allowing-hook stdout on UserPromptSubmit, and SessionStart is not a substitute.

### 5. Fragment reconciler slot

`REGISTRY_ORDER` becomes `['claude-code','cursor','codex','opencode','grok','musterd']`. A `HarnessAdapter` inspects/intents the project `.grok/config.toml` `mcp.musterd` fragment.

### 6. Session enumeration + liveness: documented files, not the TUI

`enumerateGrokSessions` reads `$GROK_HOME/sessions` (default `~/.grok/sessions`). Each session's `summary.json` is parsed at the boundary through a strict schema (`info.id`, `info.cwd`, `last_active_at`/`updated_at`). Attribution matches `cwd` against the workspace via `findWorkspaceDir` walk-up. Do not parse `grok sessions list` text. Do not read `session_search.sqlite`. I/O failure is `undefined` ("cannot tell"), never `[]`. Liveness gains a `grok` branch **before** the Claude fallback; unknown harnesses still fall through to Claude (ADR 321 §6).

### 7. Wake backend: fresh and resume

`host/backends/grok.ts`:

- fresh: `['-p', line, '--cwd', workspace]`
- resume: `['-p', line, '-r', sessionId, '--cwd', workspace]`

No `--yolo` / skip-permissions (same as Claude/Codex). `grokBin.ts` PATH-resolves and preflights that `-p` and `-r` are advertised; an unresolved or incompatible install stays non-wakeable (ADR 221 defer). Registered as `'grok'` in `commands/host.ts`.

### 8. Capture, interrupt, gate, nudge — native Grok hooks at Claude parity

Grok has a Claude-shaped hook table. Use every event Claude uses that Grok fires. Project-local `.grok/hooks/musterd.json` (markers `# musterd-grok-*`):

- `Notification` → `musterd nudge` (ADR 053)
- `PostToolUse` (no matcher) → `musterd inbox --interrupt-check` (ADR 088)
- `PreToolUse` matcher `Edit|Write|MultiEdit|NotebookEdit|Bash|run_terminal_command|search_replace` → `musterd gate check --stdin` (ADR 150)
- `SessionStart` → `musterd session start --stdin` (stdout not discarded: if Grok injects it, orientation rides; if not, extra output is harmless)
- `SessionEnd` → `musterd session end --stdin` (silent)

`parseToolCall` accepts Grok's `{ toolName, toolInput }` as well as Claude's snake_case, and maps `run_terminal_command` → `Bash` and `search_replace` → `Edit`. Fail-open unchanged (ADR 150).

`refreshHooks` is declared, same contract as Claude (ADR 168).

Global self-gating SessionStart lives in `~/.grok/hooks/musterd-sessionstart.json` with the same AGENTS.md `musterd:start` gate Claude uses — so a fresh clone that has the primer but no project hooks still gets the "run musterd init" path. This is the one intentional write outside the project tree, and it is the same exception Claude's `~/.claude/settings.json` SessionStart already is.

Honest omissions (Grok does not expose the seam, so we do not fake it):

- ADR 167 session-to-session observer — Grok has no peer-session messaging tool analogous to Claude's.
- UserPromptSubmit repeating orient-nudge — Grok discards allowing-hook stdout / `additionalContext` on that event (verified in Grok 1.0.13 docs, 2026-09-02). Orient remains a catalogued skill.

### 8b. Permission floor

Grok's `[permission]` allow/ask/deny tables accept Claude-style `Bash(...)` rules. `provision` merges `STANDARD_FLOOR` additively into project `.grok/config.toml`, reversibly, same as Claude's `.claude/settings.local.json` (ADR 026/261). Never sets `[ui] permission_mode` — that is the user's interactive default.

### 9. Statusline chip

If project `.grok/config.toml` has no `[ui.status_line]`, write `type = "command"` / `command = "musterd session statusline --stdin"` (Grok pipes JSON, same as Claude). Never overwrite a user's builtin or custom row. Marker in the command so unprovision removes only ours.

`.gitignore` `.grok/config.toml` (machine launch paths). Commit the hooks file and guidance shells.

## Consequences

- **Every resumable seat rebuilds.** Epoch 17. Announce; do not `service refresh` to see a UI change.
- Presence rows may attest `grok`. The web viewer renders the friendly label without a fan-out release.
- Migration v57 rebuilds `presence` O(rows). Dogfood scale is trivial, as v44 was.
- A Grok session in a folder that still has Cursor MCP **and** a native Grok entry attests `grok` because config.toml wins on the `musterd` name. Cursor sessions in the same worktree still attest `cursor` (their own entry). Multi-harness worktrees stay legal (ADR 281).
- Stdio MCP does not respawn on a list refresh (measured 2026-09-02: PID started before the rebuild kept attesting the old stamp). Activation copy names disable+enable or a session restart.
- Architecture trees, SPEC, wiki matrix, and harness-residency table update in the same commits that land the files (`arch-trees:check`, hard rule 3).

## Observability & Evaluation

- **Traces:** occupancy `surface=grok` on claim/heartbeat; `MUSTERD_LAUNCH_SURFACE` is the launcher marker (already spanned). Wake reports `fresh | resumed` as today. Gate decisions stay shapes-only (ADR 150).
- **Eval:** a Grok CLI session in a provisioned worktree attests `grok` on the roster (not `cursor` / `other`); `team_inbox_check` and `team_send {act:'status_update'}` succeed. Falsify: `team_status` still prints `cursor` after `musterd harness configure` + MCP respawn.
- **Experiment:** dogfood on wanderer's worktree (this lane) before submit.
