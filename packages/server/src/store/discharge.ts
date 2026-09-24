/**
 * What discharges a directed act — named ONCE, as SQL, for every reader that asks (ADR 434).
 *
 * Four readers asked "is this act still owed?" and each spelled the answer itself: the inbox's
 * pinned set (ADR 429, `listInbox`), the open-loops gauge (`countOpenLoops`), the open directed
 * ledger that feeds the batched wake lane (`openDirectedLedger`), and the per-recipient ledger
 * (`answerBy`) whose `answered` state the wake derivation reads. Three of them knew two shapes —
 * an `accept`/`decline` naming the act, a `resolve` on its thread — and only the pinned set knew a
 * third, the recipient's own reply by `in_reply_to` on any act. None knew the fourth: the recipient
 * replying IN THE THREAD, which is how a seat answers a threaded steer.
 *
 * Measured 2026-09-21 (lane 01M32V416B): ryder answered stanley's steer 01M32R78FE in its thread at
 * 13:21:44, and the wake edge — reading a predicate that did not know that shape — leased her for
 * it again at 13:37:25. gptbot answered izzo's urgent steer 01M1T4GV18 by `message` with
 * `in_reply_to` at 13:19 and 13:43; the ledger's `answered` knew only accept/decline, so the act
 * was leased at 13:18, 13:37 and 13:42 and then declared exhausted.
 *
 * The four shapes, for an act `a` owed to recipient `r`:
 *   1. any seat's `accept`/`decline` with `meta.in_reply_to = a.id` (ADR 254: first answer wins);
 *   2. a `resolve` whose thread is `a`'s thread — `COALESCE(a.thread_id, a.id)` (ADR 025);
 *   3. `r`'s own act, whatever it is, with `meta.in_reply_to = a.id` (doorbell clause 7(iv));
 *   4. `r`'s own act, whatever it is, in `a`'s thread and newer than `a` — receipt order,
 *      `(created_at, id)`, the position every cursor here walks.
 *
 * Shapes 3 and 4 need a recipient; for a `@team` act (`to_member` NULL) they are simply never true,
 * which is right — an eligible-set act is discharged by 1 for everyone (ADR 254), not by one
 * seat's chatter. A read that has its recipient in hand passes a bound parameter (`?`); one that
 * reads the whole team passes the act's own `to_member` column.
 *
 * `messages.created_at` is compared, not `ts`: `ts` is the sender's clock and travels (ADR 335);
 * receipt order is the one every read cursor already agrees on.
 */

/** The `NOT EXISTS (...)` clauses that keep an undischarged act, to append to a `WHERE` whose
 *  act row is `alias` and whose recipient is the SQL expression `recipient` (a `?` or a column). */
export function undischargedSql(alias: string, recipient: string): string {
  return `
    AND NOT EXISTS (${answeredByAnyoneSql(alias)})
    AND NOT EXISTS (${resolvedThreadSql(alias)})
    AND NOT EXISTS (${repliedByRecipientSql(alias, recipient)})`;
}

/** Shape 1 — `SELECT 1` form. */
export function answeredByAnyoneSql(alias: string): string {
  return `SELECT 1 FROM messages dr
     WHERE dr.team_id = ${alias}.team_id
       AND dr.act IN ('accept','decline')
       AND dr.in_reply_to = ${alias}.id`;
}

/** Shape 2 — `SELECT 1` form. */
export function resolvedThreadSql(alias: string): string {
  return `SELECT 1 FROM messages dv
     WHERE dv.team_id = ${alias}.team_id
       AND dv.act = 'resolve'
       AND dv.thread_id = COALESCE(${alias}.thread_id, ${alias}.id)`;
}

/** Shapes 3 and 4 — `SELECT 1` form; the inner alias is `dy` so a caller can select from it. */
export function repliedByRecipientSql(alias: string, recipient: string): string {
  return `SELECT 1 FROM messages dy WHERE ${repliedByRecipientWhere(alias, recipient)}`;
}

/** The WHERE body of shapes 3 and 4 over a reply row aliased `dy`, for a caller that wants the
 *  reply itself (`answerBy`) rather than its existence. */
export function repliedByRecipientWhere(alias: string, recipient: string): string {
  return `dy.team_id = ${alias}.team_id
       AND dy.from_member = ${recipient}
       AND (
         dy.in_reply_to = ${alias}.id
         OR (
           dy.thread_id = COALESCE(${alias}.thread_id, ${alias}.id)
           AND (dy.created_at > ${alias}.created_at
                OR (dy.created_at = ${alias}.created_at AND dy.id > ${alias}.id))
         )
       )`;
}
