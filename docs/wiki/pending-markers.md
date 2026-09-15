# Pending markers

The `.musterd/pending/<code>.json` files an unclaimed adapter drops so `musterd claim` can ask "which waiting session is this?" — how they are written, why they used to accumulate forever, and how one blocks a claim.

## What they are

An MCP adapter that loads into an unclaimed folder is reachable but holds no seat (ADR 033). It writes one marker at `<workspace>/.musterd/pending/<code>.json` carrying `code`, `team`, `workspace`, `surface`, `driver?`, `connId`, `ts`. The file holds **no token** — a pending session has no seat yet — so it is not a secret. Delivery of a claimed identity is via the workspace binding (ADR 018) and the ADR 034 resolution sidecar, keyed by the same `code`.

`musterd claim` reads them to disambiguate. When **two or more** match the folder it refuses with `several unclaimed sessions are waiting here — re-run with --for <code>` and exits 2.

## `ts` is a boot stamp, not a heartbeat

`writePendingMarker` is called **once**, from `main()` in `packages/mcp/src/index.ts`, and never again — nothing refreshes the file while the session runs (2026-09-05; falsify: grep `writePendingMarker` across `packages/` and look for a second call site or an interval).

This is the fact that decides every design on top of these files. `ts` says when the adapter booted, not when it was last alive, so a marker's age does **not** distinguish a live session from a dead one — only a long-dead one from a possibly-live one. A session genuinely still waiting to be claimed can carry an old `ts`, and reaping its marker strands it, because the resolution sidecar it is waiting on is keyed by that marker's code.

## They accumulated forever

~~Nothing ever removes an unclaimed marker (2026-09-04; falsify: read `consumePending` / `clearPendingMarker` and find a caller that is not an adopting claim)~~ FIXED 2026-09-05 by #1310. `consumePending` and `clearPendingMarker` only fire when a claim actually **adopts** that code, so a session that exited without ever being claimed left its file behind permanently.

Measured on one machine, 2026-09-04: **189 marker files across 15 `.musterd/pending/` dirs; 176 older than seven days.** The oldest in `agents-dolly` was from Jul 31.

`listPendingForWorkspace` now reaps expired markers as it reads (`PENDING_MARKER_TTL_MS`, seven days). The read *is* the reaper — no timer, no new process, and it runs on exactly the path that suffers from the mess. Expiry is treated as a property of the marker, not of the query, so an expired file is deleted whatever team or workspace it names; scoping deletion to the caller's filter would leave the dir growing for every seat but the one that happened to read it.

### Why seven days and not one

The asymmetry decides it, not a feel. Offering a two-day-old marker costs one `--for` flag; deleting a live session's marker breaks its only path online (2026-09-05; falsify: delete a running unclaimed adapter's marker and see whether `claim --for <code>` can still bring it online). Since `ts` is a boot stamp (above), a short TTL cannot tell "stale" from "patient". Seven days sits outside any plausible waiting window and still cleared 176 of the 189 measured files.

## A stale marker is not inert — it blocks the claim

This is why the pile mattered. `musterd claim` is the documented repair for an expired session lease, and two matching markers make it refuse. On 2026-09-04, with the MCP adapter down and the CLI lease expired, `musterd claim` in `agents-dolly` refused and offered `B99V` (cursor, Jul 31) and `74FF` (codex, Aug 18) — both dead connIds from sessions gone for weeks. Deleting the two files unblocked it immediately.

**It bites intermittently, and the cause looks unrelated.** Markers are matched on the `workspace` **label**, which is branch-qualified (ADR 368). A folder on a detached HEAD collapses from `agents-dolly@branch` to bare `agents-dolly` — which then matches every old bare-label marker any harness left there. Five other markers in that same folder stayed invisible throughout, because they carry branch-qualified labels. So the same folder can claim fine all week and refuse the moment it detaches HEAD.

The refusal now prints each marker's age, so a two-month-old cursor session reads as junk rather than as a rival for the seat.

## Test fixtures must carry a live `ts`

Fixtures that stamped markers at the epoch (`ts: 1`, `ts: 2`) asserted on live-marker behaviour using markers the reaper correctly considers ancient; five such fixtures across `claim.test.ts` and `pending.test.ts` had to move to `Date.now()` when the TTL landed. If a pending-marker test starts failing with an empty listing, check the fixture's timestamp before the reader.

Related: [running the gates](running-the-gates.md).
