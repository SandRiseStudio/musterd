# 025 — `resolve`: the terminal thread-close act (open-vs-done axis)

- Status: accepted
- Date: 2026-06-22

## Context

The seven Co-Gym-grounded acts (`message`, `status_update`, `request_help`, `handoff`, `accept`,
`decline`, `wait`) have **no terminal state**. `accept` means "I'll take it," not "it's finished" —
so nothing closes a thread. A thread is already a proto-work-item (a `request_help`/`handoff` root
plus its replies, joined by `thread`/`reply_to`), but with no close act there is no computable
**open-vs-done** axis over those items.

This blocks two things the plan names:
- **Progress-awareness (Co-Gym C.3)** — the team can't tell what is still outstanding vs handled.
- **The board / insights layer (§4.E)** — it needs threads to carry a "done" transition to be
  countable as work items.

It also leaves a gap in the human-reachability nudge (ADR 024): that ADR's "N requests waiting for
you" summary clears only when the human *reads* (the inbox cursor advances), not when a request is
actually **resolved**. A read-but-unhandled ask stops nagging; a handled-but-unread one keeps
nagging. ADR 024 deliberately tracked read-vs-unread, not open-vs-done — this ADR adds the missing
axis.

This is a deliberate protocol change, not a CLI tweak: a new act is a spec-versioned change
(`SPEC.md` §6) touching the wire contract, the server, the MCP tool surface, and CLI rendering.

## Problem

Settle, as protocol decisions (not code-first):

1. **Name** of the terminal act.
2. **Granularity** — a thread-terminal marker vs a per-act state.
3. **Authority** — who may close.
4. **Lifecycle** — how it composes with `request_help`/`handoff`/`accept`.
5. **Interaction with ADR 024's `isActionNeeded`** — a resolved request must stop flagging.

## Decision

Add an eighth act, **`resolve`**, and bump the protocol to **`musterd/0.3`** (a new act is a
MINOR per SPEC §6).

1. **Name — `resolve`.** It pairs with the dominant opener (`request_help`); "open vs resolved" is
   the standard board/insights vocabulary; and it reads as a speech-act alongside `accept`/`decline`,
   implying the work was completed. (Considered `close`/`done`/`complete`; `resolve` chosen — see
   Consequences.)

2. **Granularity — thread-terminal, not a per-act state.** `resolve` closes a **thread** (the
   proto-work-item), not a single message. It MUST carry a non-empty `thread` naming the thread it
   closes; a no-thread root is closed by passing its own `id`. Enforced in `actMetaRules`
   (`@musterd/protocol`), mirroring how `accept`/`decline` require `meta.in_reply_to`. No new
   message state/column — "resolved" is derived from the presence of a `resolve` in the thread, so
   the append-only log stays append-only (no edits/mutations).

3. **Authority — any Member may resolve; not enforced in v0.3.** Consistent with `accept`/`decline`
   (the server gates none of them by sender) and with the "stored, not enforced" posture of
   lifecycle/availability. The SPEC documents the **norm** (the opener or the assignee closes); the
   v0.3 governance/seat-claim model (still designed, not built) is where enforcement will live once
   the daemon leaves localhost. Over-restricting now would add authorization machinery v0.3
   deliberately defers.

4. **Lifecycle — permissive.** `resolve` MAY follow an `accept` (`request_help → accept → … →
   resolve`) **or** close a thread directly with no prior `accept` (someone just answers and closes).
   The only requirement is that it name a thread.

5. **ADR 024 interaction — two precise changes:**
   - `isActionNeeded(env, me)` returns **false** for a `resolve` envelope, even when addressed to
     me: a thread-close is good news, never an action. (The live watch-stream salience therefore
     never flags a `resolve`.)
   - A new pure helper `openActionNeeded(messages, me)` filters action-needed messages to those whose
     thread carries **no** `resolve`. `pendingActionSummary` (the `status` comeback summary) uses it,
     so a resolved request stops counting as waiting **even while still unread** — the open-vs-done
     axis ADR 024's read-cursor alone couldn't give. A read-but-unresolved request still doesn't
     count (it's read), preserving ADR 024's self-clear-on-read behavior; the two axes compose.

### Mechanics

- **`@musterd/protocol`:** `ACTS` gains `'resolve'` (appended; order stable); `PROTOCOL_VERSION` →
  `musterd/0.3`; `actMetaRules` requires `thread` for `resolve`.
- **`@musterd/server`:** schema **v5** rebuilds the `messages` table to widen the frozen `act` CHECK
  (`…,'resolve'`) — SQLite can't `ALTER` a CHECK in place; the rebuild copies the log and recreates
  indexes, safe under `foreign_keys = ON` (nothing references `messages`). The shared
  validate→persist→route path is otherwise unchanged (it never gated on the act list).
- **`@musterd/mcp`:** `team_send`'s `act` enum and description gain `resolve` (close a thread; set
  `thread`).
- **`@musterd/cli`:** `theme.actBadge` renders `[resolve]` bold-green (completion); `send` needs no
  change (it passes `--act`/`--thread` straight through). The agent primer teaches "close the loop
  when it's done."

## Consequences

- **SPEC/protocol bumped to `musterd/0.3`** (header, envelope `v`, §3 acts table + rules, §6). A
  server now declares `musterd/0.3` and rejects `musterd/0.2` clients with `version_mismatch` — fine
  for the localhost single-tree deploy where CLI/MCP/server move together; the published `0.2.0`
  packages are a prior generation. (Also corrected stale `musterd/0.1` strings in `02-protocol.md`.)
- **Threads are now computable work items** with an open/done transition — the keystone for the
  board/insights layer (§4.E) and progress-awareness (Co-Gym C.3), without building the board itself.
- **The notification summary now tracks open-vs-done, not just read-vs-unread** (ADR 024 completed
  along its missing axis): resolving an ask quiets the comeback summary immediately.
- **`resolve` is thread-terminal and additive** — no message mutation, no new column; "resolved" is
  a derived read over the append-only log, so any consumer (CLI today, board later) computes it the
  same way.
- **`close`/`done`/`complete` were considered.** `close` is neutral (allows won't-fix) but `decline`
  already covers refusal; `done`/`complete` read as status-flavored and less directed. `resolve`
  best matches the act register and the issue-tracker "open/resolved" framing the board will reuse.
- **Authority is unenforced** — any member can resolve another's thread. Acceptable on trusted
  localhost and consistent with the other acts; v0.3 governance will gate it when it gates seat
  claims. Until then the SPEC carries the norm, and history is preserved (a wrong close is just
  another appended act, reversible by convention — re-opening is a future affordance, not built).
