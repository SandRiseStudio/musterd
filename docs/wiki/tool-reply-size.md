# A tool reply has a size contract

A tool that bounds its reply by ROWS does not bound it at all: the harness refuses by tokens, and a reply that exceeds the ceiling is not truncated, it is replaced — the model gets a file path where the answer should have been.

## The whole reply was refused, and the seat could not see its own inbox (2026-09-15; falsify: `pnpm --filter @musterd/mcp exec vitest run src/tools/inboxCheck.budget.test.ts` — the worst-case cases build 1500 unread at 5k bodies and assert the rendered reply fits `RESULT_BUDGET`) <!-- claim: defect -->

miley started a session, ran one ordinary `team_inbox_check`, and got no inbox. The harness rejected the result — "exceeds maximum allowed tokens" — and wrote it to a file, so the seat's first act of orientation returned a path instead of its mail. Measured on that exact payload: 90 rows, 93,222 chars of message **body** alone, 114,079 chars of structured content, median body 592 chars, max 4,593. No single monster act; the aggregate.

It had been happening for weeks, silently. Every `team_inbox_check` result saved to a `tool-results/` file **is** one of these refusals — ten of them across two seats' project directories, 63 KB to 130 KB, going back three weeks. Each time, the seat either recovered by hand with `jq` or oriented on a view it could not read. Nothing reported it as a failure, because from inside the tool the call succeeded.

## Every bound was a row count, and the file asserted the conclusion it never enforced (2026-09-15; falsify: `git show 925b9e70:packages/mcp/src/tools/inboxCheck.ts` and grep for a byte or character bound — there is none) <!-- claim: defect -->

`inboxCheck.ts` had `limit` (50 rows) and `DIGEST_ROWS` (250 rows). Its header comment reasoned about size anyway: *"the tool-result ceiling is ~70k chars; 50 full rows plus this many digest lines stays well under"*. That sentence was false at the body sizes this team writes, and nothing measured it. **A budget that exists only in a comment is not a budget** — it is a claim about the code, in the code, that the code never checks.

The row bound was also not the bound it looked like: one call rendered **90 rows against a limit of 50**, because waiting acts (`request_help`, `ask`, directed non-`message`) are unioned on top of the newest-N slice, and that union has no cap of its own — in the MCP planner *and* again in the store's own `listInbox`. So the obvious advice to a blocked seat, "pass a smaller `limit`", does not reliably shrink the reply (falsify: call `team_inbox_check {limit: 3}` on a seat with several waiting acts and count the rows — this seat got 5).

## Rows are derived from the budget, never the other way round (2026-09-15; falsify: read `planInboxCheck` — if any row is added without its cost being charged against `RESULT_BUDGET`, this is wrong) <!-- claim: other -->

The repair is one number and the discipline of spending it: `RESULT_BUDGET` (~30k chars, deliberately a quarter of the smallest ceiling seen refusing a reply, because the real limit is token-based and differs by harness). Rows are filled in priority order — waiting acts first, then newest — each charged as it will actually render, and a row that does not fit degrades rather than bursting the reply: full row → digest line → elided count.

Two details that are easy to get wrong:

- **Reserve part of the budget for the digest.** Spend it all on full rows and the drain (lane 01M2GT874Y) stops walking the cursor, which is the treadmill it was built to end, returning by a different door for seats whose teammates write long.
- **Clip the body on the envelope, not at the point of rendering.** The reply carries the same acts twice — once as text, once as `structuredContent` — so clipping one and not the other halves nothing.

## A clip is only honest if the rest is reachable (2026-09-15; falsify: `GET /teams/<t>/inbox?ids=<id>` — if it answers with an ordinary inbox page rather than the named rows, the daemon predates this and a clipped body has nowhere to go) <!-- claim: other -->

Clipping a body to 1,200 chars is a deferral if the reader can get the rest and a loss if it cannot. Before this change nothing on the read path named a row: `unread_only`, `since`, `limit` and `headLimit` all select a *window*. So the clip marker names the call that returns the whole act — `team_inbox_check {ids: [...]}` — and that call had to be built alongside it: a store option, a query parameter, a client method, and a tool input that renders the named acts whole, marks nothing read, and moves no cursor.

The retrieval read deliberately **ignores the cursor**. It names acts the caller has already been shown, so a cursor floor could only make it fail.

## It ships in the adapter, so it reaches a session only when that session restarts (2026-09-15; falsify: bounce the daemon onto a build carrying this and call `team_inbox_check` in a session started before it — a reply over `RESULT_BUDGET` means the adapter is still the old one) <!-- claim: other -->

`packages/mcp` is the harness's MCP **adapter**, a process started with the session. The ADR 152 auto-refresher bounces the **daemon** and cannot touch a running adapter, so "the daemon is on a build carrying the fix" is not evidence the fix is live in your session, and `musterd service status` — which resolves the daemon from `loadConfig().server` — prints the wrong build for any `packages/mcp` behaviour.

That was measured on three seats independently before this lane (delta, 2026-09-15, insight `01M2HET5H7`): sloane's adapter predated the digest fix so its cursor row never moved; stanley's adapter process started pre-merge, so its cursor moving was "not evidence either way"; delta's `elided_unread` sat at exactly 857 for five sessions across three daemon bounces, every one of which carried the fix. **The discriminator, without reading source:** call the tool and look for the observable the new build adds — for the digest change, the "N older unread digested below" line. Absence with a large backlog means a stale adapter, not a falsified fix.

An adapter refreshes only when the session's harness restarts it: `/mcp reload` interactively, or a redeploy on a VM seat. A woken non-interactive seat can do neither, so it stays pre-fix for its whole life.
