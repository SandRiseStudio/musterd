# 186 — Cross-harness session labels: capability, not one sweep

- Status: accepted
- Date: 2026-07-30
- Authored by dolly (lane `01KYSY7JNB`), at nick's direction — ship the Claude Code forever-loop
  fix **and** make labeling work across harnesses (Cursor / Codex / future musterd harness).
- Number **186** — renumbered from 185 after ryder's sparse-team-policy landed as 185 on `origin/main`
  (PR #537). Highest on `origin/main` at renumber time: 185.
- Builds on: [ADR 160](160-seat-session-labels.md) (grammar + terminal OSC + Claude peer sweep),
  [ADR 173](173-absent-is-not-unknown.md) (nudge due keys off evidence, not a proxy),
  [ADR 085](085-layered-guidance-surface.md) (per-harness guidance shells).

## Context

ADR 160 shipped two surfaces: (1) terminal OSC titles via the CLI (harness-neutral), (2) a Claude
Code Desktop **peer** sidebar sweep (`list_sessions` → `resolve-labels` → `set_session_title`). It
recorded Cursor/Codex as "no writable sidebar" and stopped there.

Two things changed:

1. **The Claude forever-loop (lane 01KYSY7JNB).** Live CCD on 2026-07-30: ~37 unlabeled seat rows,
   of which ~34 were `titleSource: user` (often already seat-form). `resolve-labels` proposed them;
   Desktop soft-refused every rename and reported success; the stamp-aged nudge re-armed every 4h;
   agents re-swept the same set forever. Chips that *did* stick were almost all `titleSource: auto`.
2. **Cursor is not fully closed.** The built-in MCP `cursor-app-control` exposes `rename_chat`
   `{ title }` for the **current** chat only — no peer list, no session id. Inverse of Claude
   (Claude renames peers, refuses current). Availability is uneven (often absent on seat worktrees).
   Writing Cursor/`state.vscdb` or Codex SQLite from outside the app remains unsafe (live lock).
   Codex now *stores* readable titles (`thread_name` / `threads.title`) but still has no agent rename
   API — ADR 160's "no title field" claim is stale; the "no write API" claim is not.

Nick's call: fix the Claude loop **and** pursue labeling for all harnesses, including a future
musterd-native one.

## Problem

A single `Harness.labelSessions()` that assumes Claude's peer sweep cannot exist: Cursor and Codex
fail facts 2–4 of ADR 160 in different ways. Pretending "no sidebar" for Cursor leaves a real
current-chat rename unused. Keying the Claude nudge on stamp age (not on whether anything
labelable remains) invents "work to do" from a clock — ADR 173's two-valued collapse.

## Decision

### Capability enum (per harness, declared in guidance)

| Capability | Meaning | Today |
| ---------- | ------- | ----- |
| `cross_rename` | List peers + rename by id | Claude Code Desktop (`sessionsSkillPath`) |
| `self_rename` | Rename current chat only | Cursor (`selfLabelSkillPath` → `rename_chat` when present) |
| `none` | No session-title write API | Codex; Cursor when MCP absent |

Terminal OSC (ADR 160 surface 1) stays the **only universal writer** — every harness that shells
`musterd` already gets a seat-labeled tab. Sidebar/chat titles are additive per capability.

### Claude Code forever-loop fix

1. **`resolve-labels` skips all `titleSource: user`**, including seat-form hand titles. The
   2026-07-27 "complete seat-form user titles" narrowing stays right in principle and **inert and
   harmful** on Desktop (soft-refuse + success reply). Other surfaces without that refuse can
   revisit.
2. **`label-nudge` due predicate keys off evidence**: run `resolveLabels` over CCD session rows;
   nudge only when `apply.length > 0`. Stamp age is the fallback when CCD is unreadable (absent ≠
   "nothing to do" — ADR 173). The nudge quiets once nothing labelable remains, even if hours pass.

### Cursor self-label (guidance unit)

A second guidance shell — `.cursor/rules/musterd-label-session.mdc` — instructs: if `rename_chat`
is in the tool list, label **this** chat once with the shared grammar; if the tool is missing, stay
silent (do not write SQLite). Not a peer sweep; not merged into the harness-neutral musterd skill.

### Codex / future musterd harness

- **Codex:** stay `none` for writes; optional future **read** of stored titles for observability.
- **Musterd-native harness:** implement `cross_rename` (or at least `self_rename`) in-process — the
  only place we can guarantee Claude-parity without vendor MCP quirks.

### Hard rules (unchanged and restated)

- Never have the musterd CLI mutate Cursor `state.vscdb` or Codex `state_5.sqlite`.
- Never invent a peer list where the harness has none.
- Shared grammar stays in `@musterd/protocol` `label.ts` — one chip, one timestamp shape.

## Consequences

- Claude Desktop stops the forever nudge once only hand-named / already-labeled rows remain.
- Cursor seats get an honest self-label path when `cursor-app-control` is present; doctor notes
  distinguish self-rename from terminal-only.
- ADR 160 fact 3 is superseded for Cursor ("current-only rename when MCP present") and partially
  for Codex (titles readable, still not writable). This ADR is the capability spine going forward.
- A future musterd harness has a clear slot: declare `sessionsSkillPath` / in-process rename and
  reuse the same grammar + resolve-labels engine.

## Observability & Evaluation

- **Traces.** No new spans. The nudge's due check is pure local FS + the existing resolve-labels
  counters (`hand-named`, `already-labeled`, `apply` length).
- **Eval.** Extend the resolve-labels fixture: (a) seat-form `titleSource:user` → `hand-named`,
  apply empty; (b) unlabeled `auto` → apply non-empty; (c) `labelSweepDue` true iff apply would be
  non-empty when CCD is present; (d) stamp-age fallback only when CCD dir missing. Baseline: live
  2026-07-30 CCD sample (37 unlabeled → 34 user / 3 auto) must yield apply ≤ auto count after the
  fix. Cursor self-label is guidance-only — no harness API to assert in CI until a seat worktree
  reliably exposes `rename_chat`.
- **Experiment.** None pre-registered. Open empirical: does proactive `rename_chat` survive Cursor
  product policy that sometimes says "only when the user explicitly asks"? If Desktop policy
  hardens against proactive rename, self-label becomes on-request only and terminal OSC remains
  the always-on path.
