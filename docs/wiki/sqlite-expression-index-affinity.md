# SQLite expression-index affinity

Index a `TEXT` generated column, not the `json_extract` expression itself, when the comparison is against a `TEXT` column: the expression has no affinity, the column's affinity wins, and the planner then declines the expression index for that equality.

## The rule

SQLite uses an index on an expression only when the query's expression matches it exactly **and** no affinity conversion applies to the comparison. `json_extract(...)` returns a value with no affinity. Comparing it to a column declared `TEXT` applies TEXT affinity to the expression side (the column's affinity wins), so the planner treats the indexed expression as unusable for that equality and falls back to whatever index covers the remaining terms — here `messages(team_id, …)`, a per-row scan of the whole team.

A `VIRTUAL` generated column declared `TEXT` carries TEXT affinity, so an ordinary index on it is used. The column costs nothing at rest (virtual) and is the same expression by definition.

## The measured instance (2026-09-24; falsify: on a copy of a ~16k-row `messages` table, `CREATE INDEX i ON messages(team_id, json_extract(meta,'$.in_reply_to'))` and `EXPLAIN QUERY PLAN` the discharge `NOT EXISTS` from `discharge.ts` — the plan reads `USING INDEX i (team_id=?)`, one column, not two) <!-- claim: defect -->

The guardian raised `daemon_wedged` twice (11:52 and 12:00 local), each cleared in ~3 min, with 97% of samples in `sqlite3_step` under `Statement.all`. Per-statement timing of one `POST /residency/wake-leases` poll against a copy of the live DB:

| statement | calls | ms |
| --- | --- | --- |
| `openDirectedLedger` (three `NOT EXISTS` discharge clauses) | 2 | 7434 |
| `answerBy` (the recipient's own reply, `in_reply_to` OR thread) | 298 | 2079 |
| `resolve` on thread | 266 | 1727 |

Only the `answeredByAnyone` clause (`json_extract(dr.meta,'$.in_reply_to') = m.id`) carried the first number: 1.78 s alone, 0.01 s on a generated column. The poll runs every few seconds per host, so the event loop was blocked for most of every window while `/health` queued behind it.

Fixed by migration v71 (`packages/server/src/db/migrations.ts`): the column, four indexes, and an `ANALYZE messages`. Poll cost on the same copy: 12.6 s → 0.2 s.

## Two traps met on the way

- **`pragma_table_info` hides a VIRTUAL generated column.** A `cols.includes(...)` guard written against it re-adds the column on a migration replay and fails with `duplicate column name`. Use `pragma_table_xinfo` (2026-09-24; falsify: `SELECT name FROM pragma_table_info('messages')` after v71 — `in_reply_to` is absent; `pragma_table_xinfo` lists it). <!-- claim: other -->
- **Nothing in the daemon runs `ANALYZE`.** Without `sqlite_stat1` the planner kept choosing `idx_messages_team_ts` (it avoids the `ORDER BY` sort) over the new equality indexes, so two of the three hot statements stayed at ~5 ms per call until the migration analysed the table. `PRAGMA optimize` on close would keep the stats fresh; not wired as of 2026-09-24.

## Where else this shape lives

`json_extract(detail, '$.act') = ?` on `audit` (`residency.ts`, several sites) is the same pattern on a 228k-row table. It is bounded today by `idx_audit_team_action_ts` narrowing on `action` first, so it did not show in the profile, but it is the next candidate if `audit` grows.
