import type { Database } from 'better-sqlite3';
import type { MessageRow } from './rows.js';

/**
 * The unread rows `pendingInterrupts` can actually use — everything else in the window is inert.
 *
 * WHY A NARROWED READ RATHER THAN A FASTER FOLD. `/inbox/interrupt-check` is the most frequently
 * served route in the system: a PostToolUse hook calls it at every tool boundary of every live agent,
 * and it is documented sub-50ms. It used to read the seat's whole unread window. After #909 removed
 * the per-row member lookups, what was left was the query itself — `SELECT *` marshalling 6000 rows
 * into JS costs 10.7ms, against 0.7ms to hydrate them and 0.4ms to fold them. The fold was never the
 * problem; the row count was. Narrowed, the same read is 1.2ms and stops scaling with how far behind
 * the seat's cursor has fallen.
 *
 * THE PREDICATE IS THE FOLD'S OWN, READ OFF IT. `pendingInterrupts` returns an act only if it is
 * `meta.urgent`, a `steer`, or an obligation (`ask` carrying the daemon-set `meta.lane_review`). It
 * can SUPPRESS one only via `resolve` (which closes a thread) or `accept`/`decline` (which discharge
 * by `meta.in_reply_to`). It can REDIRECT one only via `meta.eligible`, which replaces the default
 * obligation rule. Nothing else it reads can change its answer, so admitting exactly these shapes
 * leaves the answer identical — which is what `interruptCandidates.test.ts` asserts against the
 * unnarrowed read, over a corpus built to contain every one of them.
 *
 * The `meta` predicates are `json_extract` and therefore unindexed: this still SCANS the window, it
 * just stops carrying it back. That is the whole win, and it is why the cost is now a function of the
 * window's size in SQLite rather than of its size in V8.
 *
 * Keep this in step with `pendingInterrupts`. A new shape admitted there and forgotten here would
 * narrow the fold's input below what it reads, and the answer would silently change.
 */
export function listInterruptCandidates(
  db: Database,
  member: { id: string; team_id: string },
  /** `cursorTs` is the cursor row's `created_at` (see `cursors.ts`) — the window is in receipt order. */
  opts: { cursorTs?: number } = {},
): MessageRow[] {
  return db
    .prepare<unknown[], MessageRow>(
      `SELECT * FROM messages
        WHERE team_id = ?
          AND (to_member = ? OR to_kind IN ('team','broadcast'))
          AND from_member != ?
          AND created_at > ?
          AND (
            act IN ('steer','resolve','accept','decline')
            OR json_extract(meta, '$.urgent') = 1
            OR json_extract(meta, '$.lane_review') IS NOT NULL
            OR json_extract(meta, '$.eligible') IS NOT NULL
          )
        ORDER BY created_at ASC, id ASC`,
    )
    .all(member.team_id, member.id, member.id, opts.cursorTs ?? 0);
}
