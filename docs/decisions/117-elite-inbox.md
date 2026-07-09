# 117 — An elite `musterd inbox`: bounded recent window, day-grouped smart dates, always-show-unread

- Status: accepted — 2026-07-08
- Date: 2026-07-08

## Context

`musterd inbox` (no flags) was unusable on a long-lived team. Three faults compounded:

- **Unbounded + oldest-first.** The default fetched *every* message the seat could see (all
  `@team`/`@broadcast` + everything directed to it) with **no limit**, ordered oldest→newest. On a
  standing team that is hundreds of rows, and the **newest — the ones you care about — printed at the
  very bottom**, so reading meant scrolling past the entire history every time.
- **Time, no date.** Every row rendered only `HH:MM` (`theme.clock`). A message from Monday showed
  `21:14` with nothing to distinguish it from today.
- **A latent server bug** blocked the fix: `listInbox(limit)` did `ORDER BY ts ASC … LIMIT`, so asking
  for N returned the **oldest** N, not the recent N — the same defect fixed for the firehose backfill.

Unread tracking itself was verified sound (a ts-based per-member read cursor; `markRead(id)` sets it to
that message's ts), but the unbounded default meant one glance consumed everything, so "what's unread"
was never usable in practice.

## Decision

A bounded, recency-first, day-grouped inbox — with a correctness invariant that keeps unread honest.

1. **Bounded recent window by default.** Show the newest `N` (default **15**), newest last (where the
   terminal cursor rests). `--limit <n>` resizes it; **`--limit 0`** shows the full history. `--all`
   stays the separate whole-team *firehose* scope (ADR 061), unchanged — the window is a count, not a
   scope.
2. **Always show every unread — the correctness invariant.** Reading advances the cursor past what was
   displayed, so a bounded view that *hid* an unread would silently mark it read. Rule: the default view
   **always includes every unread**. If the oldest row of a bounded window is itself unread (⇒ the
   unread backlog exceeds the window), the client refetches all unread and shows those. The cursor then
   advances only to the **newest unread actually displayed** — never past an unshown one.
3. **Day-grouped smart dates.** Messages group by calendar day under one header each — `Today` /
   `Yesterday` / `Monday · Jul 7` (within the week) / `Jul 1` (earlier this year) / `7/1/26` (a prior
   year) — so a date is stated once per day instead of never; rows keep a clean `HH:MM`. Fixed
   month/weekday names (not `toLocaleDateString`) keep output deterministic across locale + CI TZ.
4. **Honest footer.** The header shows `· <unread> unread` and, when the view is bounded, `· <shown> of
   <total>` with a `--limit 0 for all history` hint — a bounded default never pretends it showed
   everything (a `total` count added to the `/inbox` response via `countInbox`).
5. **Server: newest-N.** `listInbox` with a limit now takes the newest N (DESC + LIMIT, re-sorted
   ascending), mirroring `listTeamMessages`. The MCP `team_inbox_check` gets the same newest-N slice
   (it had the oldest-N bug too) — it was already unread-default + capped, so agents were less exposed.

## Consequences

- `musterd inbox` fits a screen and leads with what's recent + what's new; the full history is one flag
  away (`--limit 0`).
- **Unread is trustworthy**: the invariant guarantees a bounded view can't consume an unread it didn't
  show — tested directly (20 unread, window 15 → all 20 shown, then exactly those marked read).
- Dates are unambiguous at a glance without per-row clutter.
- **Back-compat:** `--json` still emits the (now-bounded) message array; `--peek`/`--unread`/`--from`/
  `--act`/`--watch`/`--wait` are unchanged; the header text shifted from `(N unread)` to `· N unread`
  (one e2e assertion updated). `--all` still means the firehose.

## Observability & Evaluation

**Traces** — no runtime span change; this is a client render + a read-shaped server query. The
`/inbox` HTTP request log already records the call; the added `total` is a COUNT on the same visibility
predicate. `n/a` for `@musterd/telemetry`.

**Eval** — the metric is **rows printed per `inbox` invocation** (the flood) and **unread-consumed-
without-display** events (the correctness failure a naive bound would introduce). *Dataset:* the CLI
render + the read cursor before/after. *Baseline:* this session — an unbounded dump (100s of rows,
newest last) and `HH:MM`-only timestamps. *Target:* ≤ window+unread rows by default; **zero**
unread-consumed-without-display (enforced by the invariant + its test).

**Experiment** — before/after is the same command on the same inbox: *before* = every message oldest-
first, time-only; *after* = a day-grouped recent window, all unread included, `N of TOTAL` footer. The
invariant is the falsifiable claim — the `inbox.test.ts` "bounded view shows every unread and marks
exactly them read" case fails if a future change reintroduces the flood-then-consume behavior.
