# Driver support matrix

Which features are observed to work per harness (Claude Code / Cursor / Codex) and per driver (desktop / terminal / IDE / headless) — observed environment facts, documented not modelled (ADR 296 reserved item).

## What this page is

ADR 296 §1 reserves per-driver feature differences as **observed environment facts**: "neither
capabilities nor configuration … documented in a support matrix and, if ever modeled, attested
through presence like the model is." This page is that matrix. It answers the ADR's own confusion
test — *"why does session labeling work on my laptop and not my server?"* — from the glossary plus
the rows below. Everything here is an observation with a date; putting any of it on the wire is a
new ADR, not an edit to this page.

A *driver* is how a harness session runs: desktop, terminal, IDE, headless (glossary). A *harness*
is the agent product hosting the session. The same harness under different drivers supports
different features — that is the whole reason this page exists.

## The matrix

Observed 2026-08-24 from the adapters (`packages/cli/src/onboard/harnesses/*`), ADR 160/186/265,
and the doctor's notes; falsify any cell: run the named feature under that harness+driver and watch
it behave otherwise, then invalidate-date the cell (wiki rule 4).

| Feature | Claude Code (desktop) | Claude Code (terminal) | Claude Code (headless) | Cursor (IDE) | Cursor (terminal, `cursor-agent`) | Codex (any driver) |
| --- | --- | --- | --- | --- | --- | --- |
| Session labeling (ADR 160/186) | **cross_rename** — peer sweep via the app's own `list_sessions`/`set_session_title` MCP tools | terminal OSC 0 tab title only — no sidebar write API | none — no controlling terminal, no MCP session tools | **self_rename** — `rename_chat` when the MCP tool is present; none when absent | terminal OSC 0 only | **none** — append-only JSONL, no session-title write API; terminal OSC 0 when terminal-hosted |
| Hook capture (tool-boundary) | full set: SessionStart/SessionEnd, PostToolUse interrupt (ADR 088), PreToolUse gate (ADR 150) + observer (ADR 167), Notification | same as desktop (hooks are harness-level, driver-independent) | same, where the harness runs at all | sessionStart (orientation, ADR 333), postToolUse (with interrupt, ADR 088/369), preToolUse (enforcement gate, ADR 150/369), sessionEnd | IDE set (with PreToolUse gate and PostToolUse interrupt, ADR 369) **plus** ADR 265's `afterShellExecution`/`afterMCPExecution` — added because older CLIs did not dispatch the ADR 198 set (2026-08-13) | SessionStart/SessionEnd/PostToolUse only (`.codex/hooks.json`); no gate, interrupt, or notification hooks |
| Skills / guidance discovery | `.claude/skills/musterd/SKILL.md` + `.claude/commands` + label-sessions and nudge-relay skills | same | same | `.cursor/rules/musterd.mdc` (description-gated) + `.cursor/commands` | same rules files | **none native** — no project-level skill/rule/slash-command mechanism; relies on harness-neutral `.musterd/skill/SKILL.md` |
| Startup hook (orientation) | SessionStart, global + self-gating | same | same | sessionStart | sessionStart | SessionStart |
| Persistent seat indicator (ADR 326 amendment) | `statusLine` command slot — `musterd session statusline` renders `🔶 seat · team · ⚑n waiting · lane: …` | same (harness-level setting, driver-independent) | **none** — no TUI to draw in, so the seat chip cannot exist here; the SessionStart orientation still reaches the agent | **none** — no persistent UI; `user_message`/`followup_message` are consumed once | same | **none for musterd** — Codex HAS a TUI status line, but its items are a closed enum (`StatusLineItem` derives `Copy`, so no variant can carry text) and its one free-text item is app-server-fed |
| Model attestation source (ADR 158/246) | `transcript_path` — highest-fidelity of the three | same | same | `model_id`/`model` from hook payload; transcripts ignored | same, but CLI model ids are a separate namespace (`cursor-grok-4.6-high` ≠ `grok-4.6`, 2026-08-13; no mapping invented) | only if PostToolUse carries `model` |
| Session capture / transcripts | per-session `.jsonl` (ADR 131 §5) | same | same | `.jsonl` in per-session subdir; attribution via `.workspace-trusted.workspacePath` — only 2 of ~35 projects carried it on the measured machine (2026-08-21), so enumeration returns "cannot tell", not `[]` | sibling `.txt` at the top of `agent-transcripts` — a different format than the IDE (2026-08-13) | append-only JSONL |
| Config entry scope | repo-shared (keys by repo root) | same | same | per-folder, secret inside the tree | same | per-folder; plus machine-global `~/.codex/config.toml` that no repair reaches (`registeredElsewhere`, measured 2026-08-05) |
| Hook drift detection (doctor) | markers checked, missing hooks named | same | same | not populated | not populated | the only harness that populates `hookDrift` today (2026-08-24; falsify: grep `hookDrift` in `harnesses/*`) |

### Grok CLI (added 2026-09-02, ADR 352)

Observed against Grok 1.0.13 docs on this machine. Parity target is Claude Code where Grok exposes the seam.

| Feature | Grok CLI (terminal) | Grok CLI (headless `-p`) |
| --- | --- | --- |
| Session labeling | terminal OSC 0 only — no sidebar write API | none |
| Hook capture | Notification, PreToolUse gate, SessionStart/End. ~~PostToolUse interrupt (2026-09-02, ADR 352 assumed Claude-parity stdout injection)~~ MEASURED 2026-09-03 Grok 1.0.13: PostToolUse stdout and additionalContext JSON do not reach the model (falsify: a PostToolUse additionalContext canary appears in that session's `chat_history.jsonl`). Mid-loop injection is PreToolUse additionalContext; idle-at-turn-end is Stop `decision:block` (ADR 370; falsify: those canaries absent from `chat_history.jsonl` after `musterd init --refresh-hooks`). **No** ADR 167 observer (Grok has no peer-session tool). UserPromptSubmit additionalContext is discarded, so no repeating orient-nudge | same hook files if the harness runs them |
| Skills / guidance | `.grok/skills/musterd/` + `.grok/commands` + AGENTS.md (native) | same files |
| Persistent seat indicator | `[ui.status_line] type = "command"` — yes (falsify: that key gone from Grok status-line docs) | **none** — no TUI |
| Model attestation | `summary.json` `current_model_id` + hook `sessionId` | same files |
| Session capture | `$GROK_HOME/sessions/<encoded-cwd>/<id>/summary.json` | same |
| Config entry scope | per-folder `.grok/config.toml` | same |
| Hook drift detection | `inspectGrokHookDrift` populates `hookDrift` | same |

Where a Claude Code column says "same", the feature is harness-level and the driver does not change
it — the driver-sensitive rows are labeling (needs a sidebar or a tty) and capture (paths differ by
driver on Cursor). The doctor already narrates the labeling row per capability and deliberately
emits it as **notes, never drift**: capability gaps are environment facts, not misconfiguration
(`packages/cli/src/onboard/doctor.ts`).

### OpenCode (added 2026-09-03, ADR 321/362; live-doorbell eval `opencode-live-doorbell-eval.md`)

Observed against opencode 1.18.27 server docs, `@opencode-ai/plugin` 1.18.27 types, and one
headless live measurement (scratch port, isolated `XDG_DATA_HOME`).

| Feature | OpenCode (TUI, musterd-spawned on a known `--port`) | OpenCode (TUI, human-launched, random port) | OpenCode (headless `serve`) |
| --- | --- | --- | --- |
| Peer inject (doorbell in) | **yes** — `POST /session/:id/prompt_async` (measured: noReply persist + reply-mode wake both worked once); `abort` for the interrupt half (measured harmless on idle) | **unreachable** — no discovery API for the random port; a parallel `serve` starts a new server (docs) | same as spawned-TUI (measured here) |
| Tool-boundary → model | `tool.execute.after` output mutation, in place (community-measured); MCP-path mutation unconfirmed on 1.18.x — re-verify before building | same | same |
| Turn continuation | `session.idle` event + in-process `client.session.prompt` (shipped precedent: code-review plugin); `noReply`/`synthetic` transcript-only mode | same, if a plugin is installed | same |
| Idle-at-prompt | covered — `prompt_async` needs no turn-end (measured); TUI may not render injected messages (#8564) | n/a (unreachable) | covered |
| Hook drift detection | not populated | not populated | not populated |

## The wire is not this page

The glossary entry for *driver* says "Already the wire field (`presence.driver`)". Observed
2026-08-24: that wire field carries the **driver co-presence human's name** (ADR 021 — set from
`MUSTERD_DRIVER`, rendered as "driven by <name>"), not a desktop/terminal/ide/headless value; no
schema anywhere carries that enum (falsify: grep `desktop` in `packages/protocol/src/member.ts` —
`PresenceSchema.driver` is a free string documented as the steering human). The two meanings of
*driver* currently collide on one field name, which is an ADR 296 tier-question for whoever models
this — this page only records the fact. The nearest real enum on the wire is `SURFACES`
(`packages/protocol/src/acts.ts`), which names harnesses and surfaces, not drivers.

## Related

- [ADR 296 terminology eval](adr-296-terminology-eval.md) — Q2 half-passed until this page existed.
- [Cursor-agent live-doorbell eval](cursor-agent-live-doorbell-eval.md) — live measurement of peer inject, PostToolUse vs afterShellExecution stdout reach, Stop hook continuation, and idle-at-prompt coverage.
- [Model attestation](model-attestation.md) — per-harness observe behavior, measured; linked not duplicated.
- [Harness statusline seams](harness-statusline-seams.md) — why the `persistent seat indicator` row reads
  as it does: the per-harness survey behind those cells, each verdict dated with its own falsifier.
- `docs/design/harness-residency.md` — residency classes per harness×driver (the closest prior table).
- ADRs 160, 186 (labeling), 265 (Cursor CLI capture), 021 (driver co-presence).
