# When the daemon stops refreshing

What the auto-refresher does when a tick fails, which failures interrupt a human, and why a blocked refresh used to alarm every twelve minutes without ever escalating.

## Three markers, three lifecycles

`~/.musterd/autorefresh/` holds three independent files, deliberately not one:

| file | question it answers | cleared when |
| --- | --- | --- |
| `.attempted-sha` | did the build for THIS TIP already fail? | the daemon reaches the tip |
| `.outage` | is the daemon unreachable, and confirmed? (ADR 230) | any reachable tick |
| `.blocked` | is the refresh stuck on the SAME CAUSE, and for how long? | any landed refresh |

Conflating the first with tick liveness produced #587 and #600. Conflating it with the third produced the alarm storm below.

## The alarm storm, measured

`.attempted-sha` debounces on the **target tip**. That is right for a broken build — it would fail identically — and wrong for a blocker waiting on a person, because a dirty checkout does not care that main moved. On a busy afternoon every new commit looked like a fresh attempt.

From `~/.musterd/autorefresh/refresh.log`, 2026-09-17: 52 dirty-checkout refusals, 34 of which fired an OS notification. The refusals span **2026-08-05 → 2026-09-17, 42 days** (izzo's count over the refusal lines; only 41 carry resolvable timestamps, because the log's first ~10,300 lines predate timestamping). The episode table below is derived from the *notification* lines only, which are all timestamped, so it starts later than the true first refusal — it bounds the alarm behaviour, not the outage history.

| episode | span | notices | pinned on |
| --- | --- | --- | --- |
| 2026-08-19 | 3h12m | 16 | `b8a20c3` |
| 2026-08-26 | 2h45m | 6 | `4e46d72` |
| 2026-08-27 | 7h06m | 8 | `4e46d72` |
| 2026-09-01 | 20m | 2 | `ffa0831` |
| 2026-09-17 | 49m | 2 | `03baa24` |

The 2026-08-19 episode carried 16 **distinct target tips** and one unchanged `pinned b8a20c3`: one stuck file, an interruption every ~12 minutes for three hours, and the file still there at the end.

An episode here means *same blocker, gaps under 6h*, and the `pinned` value is what justifies the grouping rather than the clock: all 8 notices on 2026-08-27 report the same `4e46d72` across 7h06m, so the daemon demonstrably never moved, despite internal gaps of 72m, 85m and 179m. A tighter gap rule splits that into three and reports a shorter worst case — a reconciliation worth stating, since two independent re-derivations of this log (mine and izzo's) agreed on 52 refusals and disagreed on the longest episode purely through that threshold. ~~Alarms repeat identically for a human-blocked refresh (2026-08-19; falsify: count distinct `pinned` values in one episode's notices — more than one means the cause changed and the repeats were legitimate)~~ FIXED 2026-09-17 by lane 01M2RRQJDA: `blockedFailureNotice` debounces on the cause and escalates at 1h / 6h / 24h, so the same episode now fires 3 notices instead of 16, and each repeat names the elapsed time and the attempt count. <!-- claim: defect -->

## Two counting traps in the same log

Both reached a merged commit message before anyone re-derived them.

**`grep -c` double-counts here.** `grep -c "uncommitted changes" refresh.log` returns 86; the real refusal count is 52. The other 34 hits are the notification lines, which quote the refusal text back into the log. Any log whose summary lines embed what they summarise counts each event twice, and the error is invisible because both numbers look plausible.

**A span is not a sum of episodes.** The same refusals were described as "6 days". They span a month — 2026-08-19 to 2026-09-17 — in five episodes, the longest 7h06m, every one resolved the same day. No daemon was ever pinned for six days by a dirty checkout. Group by timestamp before claiming a duration.

## `NotifyItem.id` does not de-dupe

`id` is documented as a de-dupe key, and is one **only** on the inbox path, where `pollOnce` keeps a `seen` set keyed on it (ADR 035). `buildNotifyCommand` never passes it to `osascript` or `notify-send`, and neither notifier de-dupes on its own (2026-09-17; falsify: `grep -n 'n\.id' packages/cli/src/notify/os.ts` — a hit means a platform branch now reads it). So a caller outside `pollOnce` supplying a constant id gets no suppression at all while the source reads as though it were de-duped. Such callers debounce for themselves. <!-- claim: other -->

Related: [which seat the CLI acts as](which-seat-the-cli-acts-as.md).
