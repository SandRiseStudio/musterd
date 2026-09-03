# What is waiting for me — the four surfaces, and the two questions they answer

`inbox`, `nudge`, `status` and `next` are two questions wearing four commands: three of them answer "what is waiting for me" (one answer, two pointers to it) and `next` answers "what should I do next" — and on 2026-09-03 the pointers were measured lying about the answer in three separate ways.

## The mental model (2026-09-03)

| Command | Question it answers | What it prints | Reads the cursor? |
| --- | --- | --- | --- |
| `musterd inbox` | what is waiting for me — **the answer** | the acts, day-grouped, bounded recent window + every unread | advances it (unless `--peek`, or any lens) |
| `musterd nudge` | the same, at the approval prompt — **a pointer** | the banner, then the waiting acts one line each (bounded) | never |
| `musterd status` | who is on the team — the **roster**; leads with the same pointer | `⚑ N requests waiting for you since …` then the roster | never |
| `musterd next` | what should I do next — **the brief** | lanes you carry, owed reviews, what shipped, up-next | never |
| every other command | (ADR 046 side-car) — **the same pointer** on stderr | `⚑ N acts waiting for <me> — musterd inbox (since …)` | never |

So it is two surfaces, not four: **one answer** (`inbox`) and **one pointer** (the banner, printed by `nudge`, by `status`, and after every acting command), plus `next`, which is a different question. The pointer is fine as a pointer *if* it tells the truth about the answer and the answer can be read. Neither held.

## Three measured defects in the pointer (2026-09-03, nick's inbox, cursor 2954 unread behind)

Evidence: `~/.musterd/musterd.db` read with `sqlite3 -readonly`; nick's cursor was not moved. Reproduced on dolly's seat with `--peek`.

1. **The count was a prefix, reported as a total.** `pendingActionSummary` read one unread page; a pageless read is a bounded PREFIX of 200 (ADR 287) and the client never paged on `truncated`. The banner said `⚑ 8 acts waiting for nick (since 15:18)`. The 200th unread message for nick landed 2026-08-19 21:08; that page held 7–8 action-needed acts, oldest 15:18 that day — exactly the banner. Under the CLI's own predicate (`isActionNeeded` minus resolved threads) the true count was **120**. FIXED 2026-09-03: the summary walks every page the way `inbox` does. Falsifier: a seat with >200 unread and an action-needed act past the 200th; the banner's count must equal `inbox --peek --unread` filtered to action-needed.
2. **The answer could not be read through a pipe.** `bin.ts` called `process.exit()` right after the render; Node writes to pipes asynchronously, so everything past the pipe buffer was dropped. `musterd inbox --peek --limit 0` to a file: 42,652 lines. Through a pipe: 1,022 lines / 65,567 bytes, cut mid-word. Every harness tool call, `| less` and `| grep` is a pipe — which is why miley "could not answer nick's question with the commands" and read sqlite instead. FIXED 2026-09-03: `exitAfterFlush` (`packages/cli/src/exit.ts`) exits only after both streams drain; the same command through a pipe is now 42,682 lines / 2.83 MB. Falsifier: `musterd inbox --peek --limit 0 | wc -c` equals `> file; wc -c file`.
3. **`since 15:18` was a clock with no date.** Every reader takes a bare clock as today; the act was 15 days old. FIXED 2026-09-03: `sinceLabel` renders `15:18` today, `Yesterday 15:18`, `Monday · Aug 19 15:18`, `Aug 19 15:18` — the inbox's own day vocabulary.

And one drift restored: ADR 053 §1 decided the approval-prompt hook "prints any unread directed acts"; the implementation had drifted to the banner alone, while the help text still said "print directed acts waiting for this seat". `nudge` now prints the acts under the banner (oldest first, five lines, then `+N more`).

## Still open (2026-09-03)

- **`nudge` is silent on a stale session lease.** It resolves with `reclaimAgentLease: false` by design (a hook one-shot must never reclaim the seat), so when the seat's lease has lapsed the inbox read fails and the catch swallows it: zero output while acts wait. Observed on dolly's seat 2026-09-03 after a daemon bounce; `inbox --peek` on the same binding worked. Falsifier: run `musterd nudge` and `musterd inbox --peek --unread` back to back on a seat whose lease is stale — nudge prints nothing, inbox prints the acts. Not fixed here; the fix is a read that survives a lapsed lease without reclaiming it, and belongs with the lease design (ADR 337).
- **`ask` counts for everyone.** `isActionNeeded` flags every `ask`, including guardian's `daemon_down` broadcast to the team, so a human's count includes asks nobody routed to them (26 of nick's 120 were guardian). Whether a team-addressed ask should count for every human is an ADR 147 question, not a rendering one.

## Recommendation (half A of lane 01M1MB7WCW)

No rename, no merge of commands. Keep two surfaces and say so: `inbox` is the answer, the banner is the pointer, `next` is a different question. The smallest change that makes the model true is the three fixes above plus one sentence in each help summary — `nudge` "the banner and the acts behind it, read-only", `status` "the roster; leads with what is waiting for you". A human who reads the banner, runs `musterd inbox`, and sees what was counted needs nothing else.
