# 100 — Harness-hook reinforcement for seat memory: driving the pull, not composing it

- Status: proposed
- Date: 2026-07-06
- Builds on: ADR 093 (persistent seat memory — the two named follow-up seams), ADR 060
  (SessionStart verify-provisioning hook — the precedent for musterd-owned harness hooks), ADR 088
  (mid-loop nudge via a harness hook — the interrupt line), ADR 085 (layered guidance — primer stays
  the lean kernel, playbook lives in the skill)

## Context

ADR 093 shipped seat memory: a per-seat continuity blob delivered **envelope-on-occupy /
body-on-demand**, written by an explicit `team_memory_save`. It deliberately deferred two seams,
naming both in its Consequences: the SessionStart read behavior ("A/B the join one-liner on/off") and
the "harness-hook auto-save (SessionEnd/PreCompact) is the named follow-up seam if dogfood shows
agents forget to save."

Dogfood now shows exactly that. In a live session (seat `izzo`, reasoning about this very feature)
the occupy delivered its envelope one-liner — `team_join` appends the pointer from
`packages/mcp/src/tools/memory.ts` (`memoryLine`) — and the agent walked straight past it. The
pointer is real but passive: it is one conditional ~30-token line competing for attention against the
harness's own memory surface, which is not passive at all.

That competition is the thing this ADR addresses. Every musterd occupant runs inside a **harness**
(Claude Code, Cursor, Codex) that has its _own_ persistent memory — Claude Code's `MEMORY.md`, Cursor
rules, Codex memory. Seat memory does not replace it and must not try to. But the two stores sit at a
structural asymmetry:

|              | Harness memory (`MEMORY.md`)                                | Seat memory (ADR 093)                                            |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| **Read**     | auto-injected _in full_, every session — impossible to miss | pull-only, behind one conditional ~30-token pointer              |
| **Write**    | the harness prompts the agent to write it proactively       | manual `team_memory_save` only — a crashed session saves nothing |
| **Keyed on** | the runtime + user + project path — the _worker's notebook_ | the seat — the _chair's notes_, portable across occupants        |

On both ends the harness store is automatic and the seat store is manual, and the automatic system
wins a discipline contest. So continuity facts accrete into the harness notebook — which is private
to the runtime and **does not transfer when a different harness (or a different occupant) takes the
seat**. That is backwards: the store that survives a handoff is the one agents are least prompted to
use.

## Problem

Make seat memory and harness memory _reinforce_ rather than compete, without violating what ADR 093
established:

- **Two clocks stay intact.** musterd stores, never composes. No hook may author a memory body — only
  the occupant knows its working state. The seam here is a _prompt_, not an auto-compose.
- **No context tax.** The reinforcement rides the same envelope-only, conditional discipline; it must
  not put the body — or an unconditional nag — into every session.
- **musterd owns no memory abstraction it can't.** Harnesses differ. The bridge is each harness's own
  hook surface (which `musterd init` already writes), not a new cross-harness memory layer.

## Decision

Use the harness's own lifecycle hooks — surfaces musterd already owns via `init` (ADR 060) — to fire
the seat-memory reflexes at the two boundaries where they belong. Three parts, all
hook-content + guidance; no schema change.

### 1. SessionStart: an active read-nudge, symmetric with the inbox check

The SessionStart hook already emits the inbox nudge ("Run team_inbox_check now"). It gains a second,
**conditional** line, emitted only when a saved envelope exists:

> You have saved seat memory — "mid-refactor of ws.ts eviction, tests red" (2h ago). Run
> `team_memory_read` before you start if it looks relevant.

The hook learns whether to emit by shelling to the envelope-only status read that ADR 093 §5 already
exposes (`?envelope=1` — the read-back that carries `{headline, saved_at, size_bytes}`, never the
body). Cost stays ~30 tokens, body still travels only over an explicit `team_memory_read`. This turns
the passive join one-liner into a session-start reflex with the same standing as the inbox check —
the difference between "impossible to miss" and "easy to miss" is exactly that a hook says it every
time, which is why the harness's own memory never gets skipped.

### 2. PreCompact / SessionEnd: a save-nudge, not an auto-save

A crashed or compacted session currently saves nothing. The fix is **not** the hook snapshotting a
harness summary into the blob — that would compose a body musterd has no business authoring (a garbage
headline degrades every future occupy) and breaks two clocks. Instead the PreCompact and SessionEnd
hooks inject a _directive_, the same mechanism as the ADR 088 interrupt line:

> Before this session ends, if your working state moved since your last save, call `team_memory_save`
> so the next occupant of this seat starts warm.

The agent still authors; the hook only makes the SAVE reflex fire at the boundary where continuity is
about to be lost. Conditional to avoid nag fatigue: emit only when the session actually did seat work
(heuristic — any `team_send` / lane act this session; the daemon already sees these).

### 3. The boundary rule: what belongs in which store

Codify the anti-duplication split as a **skill** line (not the primer kernel — ADR 085/093 §5 keep the
primer lean):

- A fact keyed to the **occupant / runtime / user** — operating preferences, cross-team and
  cross-project knowledge — belongs in **harness memory**. It follows the worker everywhere and is
  useless to a successor who isn't that worker.
- A fact keyed to the **seat / role**, that the _next occupant_ needs — in-flight working state,
  mid-refactor decisions, where the work was left — belongs in **seat memory**. It is the only store
  that crosses a handoff.

Keep them non-overlapping by policy, not by syncing: two stores that mirror each other just drift.

### 4. Scope: Claude Code first, mechanism per-harness

SessionStart / PreCompact / SessionEnd are Claude Code hook events, and `musterd init` already writes
Claude Code hooks (ADR 060). Cursor and Codex adapters get the equivalent nudge at whatever lifecycle
points they expose; where a harness has no such hook, the envelope one-liner + skill remain the
fallback — **no regression**, the reinforcement is strictly additive over the ADR 093 baseline. musterd
does not build a memory layer it would have to own across harnesses; it reuses each harness's surface.

## Consequences

- The read-after-occupy rate (ADR 093's named eval signal) should rise — the pull is now prompted at
  the boundary instead of hoping the agent notices one line mid-join.
- Save-at-boundary becomes a measurable behavior: the fraction of sessions that ended or compacted
  with moved working state and actually saved. A crashed session with no boundary hook still saves
  nothing — accepted, as in 093 — but the compact/clean-exit paths are now covered.
- Two clocks preserved: no hook composes a body. If dogfood later shows agents want an auto-composed
  draft, that is a _further_ seam (a harness-provided summary the agent edits before saving), out of
  scope here.
- Nudge-fatigue risk: SessionStart now carries two conditional lines (inbox + memory) and session-exit
  carries one. Both memory nudges are gated (start: only when an envelope exists / is stale past a
  threshold; exit: only when the session did seat work) so a session with nothing to remember sees
  nothing.
- No schema change, no new runtime dependency, no protocol change — hook content + one skill line.
  Reversible in the ADR 010 spirit: revert the hook template and the baseline behavior is unchanged.

## Observability & Evaluation

- **Traces:** reuse the `memory.save` / `memory.read` spans (ADR 089). Add a `memory.nudge.source`
  attribute (`session_start` | `pre_compact` | `session_end` | `none`) on the resulting act so lift is
  attributable to the hook rather than to unprompted discipline.
- **Eval:** run the A/B the ADR 093 experiment already named — SessionStart memory-nudge on/off across
  dogfood sessions — scored on read-after-occupy rate and time-to-first-productive-act. Add the
  save-side counterpart: PreCompact/SessionEnd nudge on/off, scored on save-at-boundary rate and, one
  hop downstream, the successor session's read-after-occupy.
- **Live signal that motivated this:** a dogfood session (seat `izzo`, 2026-07-06) reasoned about seat
  memory _while its own occupy pointer sat unread in context_ — the passive-pointer failure mode, caught
  in the wild.
