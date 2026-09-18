# 420 — Waiting ledger empties on render, not on answer

- Status: proposed
- Date: 2026-09-18

## Context

Three pieces of machinery meet in the "what's waiting for me" banner:

1. `pendingActionSummary` (`packages/cli/src/commands/helpers.ts`) reads `{unread:true}` pages off the durable inbox and filters them through `openActionNeeded` (ADR 024/025, ADR 254 discharged set, doorbell clause 7). The waiting set is therefore **unread ∩ criteria** by construction.
2. An ordinary `musterd inbox` render advances the read cursor to the newest unread it displayed (`packages/cli/src/commands/inbox.ts` — never past an unshown unread, never when peeking or filtering). The cursor is a single `last_read_ts` watermark: crossing a row marks everything before it read.
3. `musterd inbox --waiting` is read-only by construction — it moves no cursor.

So rendering the inbox consumes the waiting set, and asking what waits never does.

## Problem

Measured 2026-09-18 (ryder, `01M2TNRDZ3145R0GQA9DW3ZHTM`): the waiting banner went 63 → 60 and its floor moved Sep 5 18:14 → Sep 6 06:40 across a workspace rebuild. Exactly one act was answered in that window. The four Sep-5 acts left the set because an ordinary non-peek render advanced the cursor past them — nothing was discharged, they were only looked at.

Verified in code (ghost, lane `01M2TRW6R8GMG1CB7GFBQ63SP9`): the summary reads unread pages, and the render path marks displayed unread read. The mechanism is confirmed, not inferred — with the standing caveat that the 63 → 60 episode itself is one seat's observation.

The consequence is the worse direction of the two possible failures: a set that never shrinks nags, but a set that shrinks on scroll **silently loses obligations for whoever looks**. Answering and scrolling are indistinguishable in the ledger, and the banner floor measures reading habits as much as backlog — ryder's own "floor has not moved in two weeks" read that way.

Out of scope here (recorded, not decided): the predicate also counts acts that carry no obligation — accepts/declines about closed lanes lead the remaining 60. The three-part predicate (addressed including `meta.eligible`, obligating kinds only, not discharged) is the next increment behind this one.

## Decision

The owed set is computed from the obligation ledger, independent of the read cursor:

1. A directed act is owed iff it is unanswered, undischarged, and unresolve-closed — evaluated **without reference to `last_read_ts`**. The delivery ledger (`packages/server/src/store/delivery.ts`: logged/seen/answered, plus the discharged shapes) already holds every input; `waitingOn` (`packages/server/src/store/insights.ts`) is report-level precedent for a cursor-free read.
2. The server exposes that set on the inbox read path, and every surface that reports "waiting" — the CLI banner, `--waiting`, `status` comeback, `team_inbox_check` — consumes it instead of deriving owed from unread pages.
3. The read cursor keeps exactly one job: drain duty. It walks rendered rows so a backlog clears in ordinary checks; no surface treats cursor passage as discharge ever again.
4. Skew: a surface against an older daemon without the set falls back to the current unread-derived behavior, degraded and documented at the call site — the same posture as the discharged-set fallback in `openActionNeeded`.

## Consequences

- Scrolling stops discharging. The banner floor moves only on answer, discharge, resolve-closure, or lane-close — the events that actually relieve the seat.
- One bounded ledger read per waiting computation, server-side, instead of deriving owed client-side from however many unread pages happen to be in view. The per-hook cost of `--waiting` stays flat as backlogs grow.
- The 63-act class of backlog becomes measurable as what it is (settled-but-undischarged) rather than shrinking whenever someone looks at it, which is the precondition for the discharge and predicate follow-ups.
- Follow-ups queued behind this ADR, in ryder's order: guardian raise-dedup (the `daemon_wedged` evidence key changes every tick, so the damper never bites), then the three-part predicate, then directed-only filters if they still earn it.

## Observability & Evaluation

- **Traces:** the banner count plus the ledger inputs it was computed from (owed ids, discharged ids) ride the existing inbox reply shapes — no new span, the same arrays `openActionNeeded` already takes.
- **Eval:** the falsifier is ryder's episode, runnable by hand — render the full inbox answering nothing, then re-read the banner. Fixed means the count and floor do not move; the current code moves both. Baseline: 63 → 60 on one render, floor +12h.
- **Experiment:** none yet beyond the hand falsifier; the discharge follow-up will need the ledger-level counts (answered vs discharged vs resolve-closed) as its dataset.
