# Claude Code live-doorbell eval

Clause 8 of the [daemon doorbell contract](../design/daemon-doorbell-contract.md) — *callable, not merely granted* — measured on `claude-code` from **inside the failure**, in dolly's session `8a006b8a`, 2026-09-14 (lane `01M2GYJX552WSXFN586WQACY2R`).

## Why this page exists

Codex, cursor and opencode each have a live-doorbell-eval page; claude-code had none, while being the harness most of the roster runs on. The contract's clause-8 row for claude-code reads **"defers & re-defers"**, which says the seat pays a `ToolSearch` round-trip and is callable again — a cost, not an outage. This session measured a **second mode on the same harness**: an MCP drop that the session never recovers from, which the table currently treats as Cursor-specific ("permanent mute until window reload").

The measurement is taken from the affected session's own transcript because it expires with the session: once the window closes, the state is gone and the next session starts healthy.

## Findings summary

| Check | Measured verdict | Recoverable in-conversation? |
| --- | --- | --- |
| 8a. Tools arrive deferred | **yes** — names only; a `ToolSearch` must fetch each schema before any `mcp__musterd__*` call | **yes**, one round-trip |
| 8b. Mid-session MCP drop | **mutes the seat** — every `mcp__musterd__*` reported "no longer available … ToolSearch will return no match" | **no** — never recovered in 65 min |
| 8c. `/mcp` reconnect | **fails** — `Failed to reconnect`, then `CONNECT_TIMEOUT after 30000ms` ×3 | **no** |
| 8d. Grant / daemon during the mute | **both healthy** — same machine, same seat, same credentials, CLI answering throughout | n/a |

The last row is what makes this clause 8 rather than clause 3: **nothing was revoked and nothing was down.** The seat held a live grant to a healthy daemon it could reach by another path, and was still mute on the tool rail.

## The timeline (session `8a006b8a`, all times UTC)

| Time | Event |
| --- | --- |
| 20:00:28 | session starts; `mcp__musterd__*` present **as names only** |
| 20:00:54 | harness reports `musterd` among servers that "failed to connect" — then recovers on its own |
| 20:01:55 | first `ToolSearch` for the musterd tools (87 s of session spent before the seat could act) |
| 20:01:57 | first successful `mcp__musterd__*` call — 2 s after the schema arrived |
| 20:46:41 | **last** successful `mcp__musterd__*` call (45 min of healthy operation) |
| 20:47:08 | every `mcp__musterd__*` reported **"no longer available … ToolSearch will return no match"** |
| 21:23:42 | operator runs `/mcp` → `Failed to reconnect to musterd` |
| 21:24:37 / 21:25:14 / 21:25:53 | `CONNECT_TIMEOUT: connection timed out after 30000ms` ×3 |
| 21:52:12 | still listed unavailable — **65 min after the drop, tools never returned** |

> A mid-session MCP drop mutes a claude-code seat for the rest of the session, and `/mcp` does not recover it (2026-09-14, session `8a006b8a`; falsify: from a session whose musterd tools have gone "no longer available", run `/mcp` and then successfully call any `mcp__musterd__*` tool without restarting the session).

## Deferral and mute are two different states, and only one is a cost

This matters because the contract's row collapses them.

- **Deferral (8a)** is a *tax*: the schema is fetchable, `ToolSearch` pays for it, and the seat is callable. Measured twice here — at session start, and (per ryder, 2026-09-14) again after a reconnect.
- **Mute (8b)** is an *outage*: the harness states positively that `ToolSearch` **will return no match**, so the recovery move that answers deferral is explicitly unavailable. There is no in-conversation action that restores the rail.

A row reading "defers & re-defers" tells a reader to budget a round-trip. It does not tell them the seat can go permanently mute, which is the state that actually costs work — and it reads as PASS on a seat that cannot answer at all.

## What was NOT established

**The cause of the drop.** `autorefresh` bounced the daemon repeatedly during this session (13:34 PT = 20:34Z, 14:12 PT = 21:12Z among others), and a bounce killing the stdio adapter process is the obvious hypothesis. But the nearest bounce is **13 minutes** before the drop at 20:47Z, which is not a coincidence you can bank. Recorded as a hypothesis, not a finding.

> A daemon bounce is NOT established as the cause of the adapter drop (2026-09-14; falsify: bounce the daemon under a live claude-code seat and observe whether `mcp__musterd__*` goes "no longer available" within one tool boundary — a reliable reproduction would promote this to a finding, and a clean bounce with tools intact would refute it).

Also unmeasured: whether a **new** session on the same workspace recovers (expected yes — the deaf state is per-session), and whether the adapter process is actually dead or merely unreachable. Both need a seat that is not the affected one.

## What the seat could still do, and why that is the sharp part

Throughout the mute, the **CLI channel kept working** against the same daemon: `musterd status`, `musterd inbox`, `musterd lanes`, `musterd send` all answered, and `musterd service status` reported `health: up` with the guardian ticking. The session completed two PRs over that channel.

So the failure is **not** loss of identity, credentials, presence, or daemon availability. It is the tool transport alone. A clause-3 lease check passes, a clause-1 probe lands, a clause-6 notice renders — and the seat still cannot `team_send`. That is exactly the gap clause 8 was added to name, in its more severe form:

> *the probe must reach the model **and** the tools it names must be callable when the model reads it.*

With one correction this session supplies: **a reconnect can revoke callability permanently, not merely deferrally** — and on claude-code, not only on Cursor.

## Proposed row for the contract

| harness | verdict | what was measured |
| --- | --- | --- |
| claude-code | **defers, re-defers, and can mute outright** | tools arrive deferred (`ToolSearch` per schema); a mid-session MCP drop reports every tool "no longer available … ToolSearch will return no match" and `/mcp` fails with `CONNECT_TIMEOUT` — no in-conversation recovery, 65 min observed. Grant, credentials, presence and daemon all healthy throughout; the CLI channel answered the whole time (dolly, session `8a006b8a`, 2026-09-14) |

Not applied here: the contract doc and the wake brief belong to stanley's lane `01M2GP25R3` (the fix). This page is the evidence that lane needs.

## Related

- [The daemon doorbell contract](../design/daemon-doorbell-contract.md) — clause 8, and the claude-code row this page proposes correcting.
- [OpenCode live-doorbell eval](opencode-live-doorbell-eval.md) — ghost's clause-8 reconnect half (#1415), the same shape on another harness: a mid-session drop mutes until `serve` restart.
- [Cursor-agent live-doorbell eval](cursor-agent-live-doorbell-eval.md) — check 5, where "permanent mute until window reload" was first measured and, until now, believed Cursor-specific.
