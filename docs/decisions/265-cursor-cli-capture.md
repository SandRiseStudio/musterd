# 265 — Cursor CLI capture: enumerate the transcript, do not inherit a dead session's model

- Status: accepted
- Date: 2026-08-13
- Lane: `01KZYW7SCZCBYTRZR1H076M2C0`
- Builds on: [ADR 198](198-cursor-hooks-observe-model.md), [ADR 158](158-model-attestation-truth.md), [ADR 131](131-harness-residency-wake-ledger-host.md) §5, [ADR 166](166-session-liveness-by-enumeration.md)

## Context

ADR 198 wired Cursor **IDE** Agent hooks (`sessionStart`, `postToolUse`, `sessionEnd`) so
`musterd session observe --stdin` stamps `binding.session` with `harness: 'cursor'` and writes
`model_observed` from `model_id`. That path assumes the host dispatches those events.

On 2026-08-13 nick drove wanderer from `cursor-agent` (CLI 2026.01.23, `--model cursor-grok-4.6-high`)
in the same worktree. Dolly measured, then wanderer confirmed on the live specimen before any
session-slot write:

| Signal | Reading (before claim) |
| --- | --- |
| Process | `cursor-agent --model cursor-grok-4.6-high` |
| `binding.session.id` | `a3fb8a1c…` (the morning **desktop** session) |
| `model_observed` | `grok-4.6` / `cursor`, `observed_at` ~11:45 local |
| `musterd session show` | **resumable**, not live |
| Project `.cursor/hooks.json` | ADR 198 events present; `~/.cursor/hooks.json` absent |
| IDE `cursor.hooks.log` | none for this evening |
| Enumerable transcript | `~/.cursor/projects/Users-nick-agents-wanderer/agent-transcripts/365e3420-….txt` — this conversation, a `.txt` at the top of `agent-transcripts`, not a jsonl in a session folder |
| Attribution file | `.workspace-trusted` carries `"workspacePath": "/Users/nick/agents-wanderer"` |

Dolly's three consequences, worst last: the roster attested `grok-4.6` from a stopped observation;
the slot was a corpse with no `ended_at`; `session show` judged the workspace resumable **while a
session was working in it**, so a wake would actuate beside the live occupant (ADR 131 §5 failing
in the direction it exists to prevent).

Two unknowns she left as observation, not guess:

1. **Does cursor-agent dispatch lifecycle hooks at all?** This binary did not dispatch the ADR 198
   set — dozens of tool calls, including Shell and MCP, left `observed_at` unmoved. Cursor's own
   forum documents a smaller CLI event surface than the IDE (`afterShellExecution` on older CLIs;
   `postToolUse` / `sessionStart` on later ones). Plugin hooks merged into a worker executor; project
   `sessionStart`/`postToolUse`/`sessionEnd` still did not write the slot.
2. **Does it write an enumerable transcript?** Yes. Dolly looked for jsonl folders and saw none;
   the CLI writes a sibling `.txt`. Enumeration that only knows Claude/Codex trees cannot see it.
   Cursor liveness previously fell through to `enumerateClaudeSessions`.

CLI model ids are a different namespace (`cursor-grok-4.6-high` is rejected if passed as `grok-4.6`).
A coincidentally-correct stale string is still not evidence (Dolly: right the way a stopped clock is).

## Problem

The ADR 198 hook install is the only Cursor capture writer, and it listens to events `cursor-agent`
does not dispatch. Combined with no Cursor enumerator, the local-session guard is blind to a live
CLI occupant, and the roster keeps attesting the previous desktop observation.

Declaring the whole Cursor harness unattestable (ADR 158's original Cursor gap, or Codex's current
declaration-only state) would also silence the IDE path that already works. Wrapping every CLI
session with `musterd session start|end` makes every measurement a write to the specimen.

## Decision

1. **Enumerate Cursor sessions.** `enumerateCursorSessions` scans `~/.cursor/projects/*/agent-transcripts`
   for `.jsonl` (IDE, per-session subdirectory) and `.txt` (CLI, top-level). Attribution is Cursor's
   own `.workspace-trusted.workspacePath`, walked up with `findWorkspaceDir` — never the folder
   slug. A missing or unparseable `.workspace-trusted` leaves that project unattributed. `undefined`
   still means "cannot tell".
2. **`localSessionLiveness` selects that enumerator when the harness is `cursor`.** The host's
   local-session guard and `musterd session show` then judge a live CLI `.txt` as `live` even when
   the slot still names a desktop jsonl. ADR 166's flip already says enumeration outranks the slot.
3. **Install observe hooks on the CLI-supported events too.** Keep `sessionStart` / `postToolUse` /
   `sessionEnd` for the IDE. Also install `afterShellExecution` and `afterMCPExecution` with the
   same `musterd session observe --stdin` command. A payload that carries `conversation_id` +
   `model_id` captures and observes; a payload that omits them is a no-op (`session_id` required).
4. **A new `conversation_id` replaces the captured session.** When observe runs with a different
   id and a model, `model_observed` is the new one — CLI namespace included, unmapped. Do not
   invent `cursor-grok-4.6-high` → `grok-4.6`. Do not declare Cursor unattestable.
5. **Do not** scrape `cursor-agent` argv, `clientInfo`, or `state.vscdb` for the model. Do not
   decode `~/.cursor/projects/<slug>`. Do not make `session show` write the slot.

## Consequences

- A live `cursor-agent` session whose `.txt` is being written is visible to the local-session
  guard without any hook firing. That closes Dolly's consequence 3 immediately.
- Model attestation still needs a hook payload with `model_id`. The extra events are the bet that
  the CLI will dispatch *some* observe event; if it does not, the roster may keep a stale
  observation until an IDE session or a later CLI that fires `postToolUse` overwrites it. That is
  honest residual, not a mapping we do not have. A wrong observation remains worse than an absent
  one — this ADR does not clear `model_observed` on session-id change because `saveBinding`'s
  merge-guard treats omit as preserve (ADR 131). Clearing is a separate writer-intent change.
- `musterd init` / `refreshHooks` rewrites `.cursor/hooks.json` with the two extra events;
  `removeMusterdCursorHooks` drops them by the same markers.
- Codex's declaration-only lane (`01KZ4QH585`) is untouched. Overlap on `session.ts` is the new
  conversation_id test only.
- 2026-08-14: [ADR 268](268-clear-model-observed-on-session-change.md) is the writer-intent change
  the residual above named. Omit still preserves; an explicit drop clears `model_observed` when the
  captured session id changes and there is no new observation.

## Observability & Evaluation

**Traces.** n/a — local binding + filesystem scan; no new wire fields.

**Eval.** Falsifier, pre-registered by Dolly and kept: after the fix, on a `cursor-agent` session,
`musterd session show` reads `live` (judged by session files, newest id = the CLI `.txt`) while
the process is open. If a hook event with `model_id` fires, `model_observed.observed_at` moves
within one tool call. Baseline: this 2026-08-13 wanderer session (`resumable`, `observed_at` stale
by ~6h, newest file `365e3420-….txt`).

**Experiment.** n/a — closes a measured lie mode; no A/B.
