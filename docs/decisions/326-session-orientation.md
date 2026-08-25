# 326 — Session orientation: the injected block, the orient ritual, and the scoped wake

- Status: accepted
- Date: 2026-08-25
- Builds on: [ADR 049](049-orientation-and-handoff.md) (the orientation brief),
  [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (composable-only injected context),
  [ADR 093](093-persistent-seat-memory.md) / [ADR 259](259-memory-git-truth-derived-indexes.md)
  (seat memory), [ADR 131](131-harness-residency-wake-ledger-host.md) (residency + wake),
  [ADR 209](209-portable-wake-context.md) (the wake-context packet this finally wires in),
  [ADR 212](212-standing-context-budget.md) (standing-context budget),
  [ADR 233](233-owed-reviews-in-the-brief.md) (owed reviews)
- Design: docs/superpowers/specs/2026-08-25-session-orientation-design.md
- Lane: 01M039T0RBBWAD85M6VQFKDRZC

## Context

The human has been the go-between: every new session in a seat workspace started blind until nick
typed "continue from last session"; the seat's own `team_memory_save` wrap-up note was rendered
only by `team_join`, which the primer discourages, so on the ordinary autojoin path the headline
was never shown. The SessionStart hook's "run team_inbox_check now" is an instruction the model
may skip — and the label-sweep episode measured exactly that: a one-shot SessionStart ask was
skipped under a busy first prompt for days, while a per-turn nudge that repeats until a stamp
lands is the variant that actually happens. Meanwhile `team_wake_context` (ADR 209) was built,
authorized, and named by no guidance surface at all.

## Problem

1. How does a human-opened seat session start *already oriented* — memory headline, waiting acts,
   incidents, owed reviews — with zero model compliance required?
2. How does it then *act* on the urgent subset unprompted, with the proven compliance pattern?
3. What does a *woken* session get, so its bounded errand is not drowned in a team-wide brief?

## Decision

1. **The orientation block (injected, human-opened sessions).** `musterd session start --stdin` —
   the project-local SessionStart capture hook's command — emits a bounded orientation block after
   capture; the hook one-liner stops redirecting stdout (capture itself still prints zero). The
   block obeys the ADR 088 composable-only bar: act enums, validated seat slugs, ULIDs, counts,
   ages. Message bodies and lane titles never appear; unrenderable fields are dropped, not
   escaped. The one free-text field is the seat's OWN memory headline, flattened, bounded
   (≤120 chars), and fenced as `<<headline-as-data: …>>`. Read-only (no cursor advance, no seat
   claim), ≤15 lines, silent on any failure, and suppressed under `MUSTERD_PROVENANCE=wake`.
2. **The orient ritual (acted, nudged until stamped).** A `musterd-orient` skill: inbox check
   (the autojoin moment), memory read, **handle tier 1 unprompted** — directed asks awaiting this
   seat's reply, open incident lanes — then **surface tier 2** (owed reviews, carried lanes,
   up-next) without acting, one status_update, then `musterd session orient-stamp`. The stamp is
   workspace-local and keyed by the captured session id — orientation is a property of the
   session, not the machine — and quiets a per-turn `musterd session orient-nudge` line carried by
   the machine-wide SessionStart and UserPromptSubmit hooks. Autonomous pickup of new work is
   deliberately excluded; a future policy flag owns moving that line (spec §E).
3. **Wakes stay scoped.** The daemon-composed wake lines now name `team_wake_context`
   first, and the tool joins `SKILL_MCP_TOOLS`. A woken session gets its errand (the ADR 209
   packet: wake kind, objective, lane/thread state, memory headline, explicit reads) — never the
   team-wide block, which its provenance suppresses.
4. **Distribution.** All emission logic is CLI-side; the capture-hook and machine-hook text
   changes ride the existing ADR 171 drift repair and ADR 168 equal-epoch overwrite — no
   feature-epoch bump. Claude Code first (it has the hook seams); Codex has no SessionStart
   injection point wired and opencode has no hook table (ADR 321 §8), so those seats keep the
   primer text and the improved wake line until an adapter grows the seam.

## Consequences

- A seat session opened by a human starts knowing its headline, what waits, and what it owes —
  and the repeating nudge drives it to answer directed asks and triage incidents unprompted.
- "Continue from last session" stops being a human ritual; the falsifier is nick typing nothing.
- The wake path and the open path stop sharing one blunt pointer: broad block for humans' sessions,
  scoped packet for wakes.
- A compromised predecessor session can still write a hostile memory headline for its successor;
  the fence, flattening, and length cap bound that residual, and it is this seat's own field —
  teammate-authored free text stays out of injected context by construction.

## Observability & Evaluation

**Traces.** The orientation block and nudges are hook-riding CLI output and add no daemon traffic
beyond three existing authenticated reads (inbox, next, memory envelope) per session start —
visible in the daemon's request log under the seat's identity. The orient stamp
(`.musterd/orient-stamp.json`) records `oriented_at`; stamp age minus capture `started_at` is the
time-to-orient measure.

**Eval.** Unit: composer rejects hostile headline/name/id inputs (planted-string assertions), caps
at 15 lines, returns null on empty; emission is silent under wake provenance, without a bound
seat, and on fetch failure; stamp keyed to the captured session id re-arms on a new capture; wake
lines name `team_wake_context` (server tests). Baseline: before this ADR, zero sessions
oriented without a human prompt, and `team_wake_context` had zero callers.

**Experiment.** The live falsifier (spec §Testing): open a session in a seat workspace and type
nothing — the agent must greet oriented, directed asks answered, incidents triaged, nudge quiet by
turn two. If the human still types "continue from last session", the design failed regardless of
test greenness.
