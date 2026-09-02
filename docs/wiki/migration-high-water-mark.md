# A reserved migration number is a promise to land first

The migration runner keeps a high-water mark, not a set, so a number reserved for an open branch that lands *after* a higher one is skipped on every database that already moved past it (2026-09-02; falsify: the v54 instance below — a database at 55 that has `sync_pull_cursor` without a later re-issue would disprove it).

## The mechanism

`runMigrations` in `packages/server/src/db/migrations.ts` reads one integer, `schema_version`,
and applies every migration whose number is greater, in order, then writes the highest applied.
The check is `if (m.version <= applied) continue;`. Nothing records *which* versions ran — only
the largest. A fresh database therefore runs every migration in the list; an existing database
runs only the ones numbered above where it already stands.

That is fine as long as numbers land on `main` in the order they were assigned. It breaks the
moment two branches hold adjacent numbers and the higher one merges first. The lower one is then
correct on `main`, correct on every new database, correct in every test that starts from
`:memory:`, and absent from every database that was live in between — which is exactly the set of
databases that matter.

## The instance (2026-09-02)

Federation 3b-ii ([#1155](https://github.com/SandRiseStudio/musterd/pull/1155)) held migration
**v54**: the `idx_messages_origin` unique index that is the fold's idempotence key, and the
`sync_pull_cursor` table. ADR 350 ([#1164](https://github.com/SandRiseStudio/musterd/pull/1164))
took **v55** with a comment that reads, in full: "v54 is reserved by the open federation 3b-ii
branch. Gaps are valid; using v55 avoids the collision that would make the second same-number
migration silently never run."

#1164 merged at 18:34 local on 2026-09-01; #1155 merged at 19:54. Every daemon bounced in between
wrote `schema_version = 55`. When #1155's build arrived, v54 was below the mark and never ran.

Verified read-only against this laptop's `~/.musterd/musterd.db` on 2026-09-02, with the daemon
running a dist built from `5380d34e` that contains v54: `schema_meta` says 55; `sqlite_master` has
no `sync_pull_cursor` and no `idx_messages_origin` (falsify: `sqlite3 ~/.musterd/musterd.db
"select value from schema_meta where key='schema_version'; select name from sqlite_master where
name in ('sync_pull_cursor','idx_messages_origin')"` prints 55 and nothing else — a database
where the fix has landed prints both names). The two-real-daemons acceptance on the PR passed
11/11 and could not have seen this: both daemons started from empty databases.

The comment on v55 is the interesting part. It named the failure it was avoiding — two migrations
sharing one number, of which the runner applies only the first — and chose the exact arrangement
that produces the same outcome by another route. Both are the same fact: the runner's cursor holds
one number, and "54 is still owed" is not a number. A gap is valid to the runner only because the
runner has no view of it.

Caught in acceptance of lane `01M1FAD24JM5ADVH7G774K2DQP`, by the "usable" arm: exercising the
landed schema on the daemon that would host the hub, rather than re-reading the diff. Sent back
with the fix shape: a v56 that re-issues v54's body (both statements are `IF NOT EXISTS`, so a
fresh database is unaffected), plus a test that a database at 55 without the table gets it.

## The habit

- **A reserved number is a promise to land first.** If the branch holding it will not merge before
  the next number is taken, it must renumber on rebase — the way ADR numbers are re-verified free
  against `origin/main` at branch time. "Verified free" for a migration means "nothing higher has
  landed", not "nothing equal has landed".
- **The reviewer's question is about `main`'s order, not the branch's.** "Is any migration on
  `origin/main` numbered above this one?" is answerable in one `grep` and is the whole check. A
  test suite cannot ask it: every fixture database starts from zero.
- **When it has already happened, re-issue under a fresh number** rather than editing the skipped
  one. Editing v54 in place changes nothing for a database at 55, and changes what a fresh
  database gets in a way nobody can tell apart from the original.
- **Whether the runner should track a set instead of a mark** is a separate decision. It would make
  this shape impossible and would change what `schema_version` means to every reader of it. Not
  made here; named so it is not folded into a fix by accident.

This is a [cannot-separate-two-causes](cannot-separate-two-causes.md) instance: `schema_version =
55` reads the same whether v54 ran or was skipped, and every test that would exercise the skipped
migration runs on a database that never had the chance to skip it.
