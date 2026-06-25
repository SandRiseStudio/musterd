# Migration & bootstrap — moving a live team from db-authoritative to file-authoritative

> Fifth layer of the ADR 058 stack. The prior docs assume `.musterd/` files already exist and the
> daemon projects them. But there is a running world that predates all of this: a live daemon whose
> **SQLite is the source of truth**, with members holding live tokens. This doc specifies the
> one-time inversion — db → files — without rotating a single live token or a big-bang cutover.
> Grounded in `db/seed.ts`, `store/members.ts`, the `bindings` registry (`cli/src/config.ts`), and
> the [stale-daemon](../decisions/) reality.

## The shape of the problem

ADR 058 inverts source of truth: today the db is authoritative and no files exist; after migration
the **files** are authoritative and the db is their projection. Three properties make this delicate:

1. **It is a one-time, per-team inversion**, not an ongoing sync. After it, the steady-state
   reconcile (projection-reconcile.md) takes over forever.
2. **It runs on a live system.** The dogfood `alpha` team has connected agents holding valid tokens
   in their `binding.json`. The migration must be **token-preserving** — re-minting would break every
   live session.
3. **The global daemon hosts many teams** (the `countLivePresences` comment), but a team has **no
   inherent folder**. So "where do this team's files live?" has no automatic answer — migration must
   *designate* a roster home.

## `musterd team export <slug>` — the bootstrap command

The inversion is a single operator command run **in the folder that should own the team's roster**
(typically the team's own git repo):

1. Read the live roster from the daemon (`teams` + `members WHERE left_at IS NULL`).
2. Write `team.toml` (slug, display, lifecycle) + one `seats/<name>.toml` per member, via the
   canonical serializer (seat-file-format.md). Identity only — **no token touches a file.**
3. Record `rosterHome[slug] = <abs folder>` in global config (extends the existing ADR 020
   registry). This is the cutover signal (below).
4. Flip `.gitignore` from `.musterd/` to `/.musterd/binding.json`, and `git add` the new files —
   leaving the migration as a reviewable diff (`+ team.toml`, `+ seats/*.toml`).

`export` **refuses if `team.toml` already exists** (idempotency without clobber): a second run would
either be a no-op or risk overwriting hand-edits, so it stops and tells the operator the team is
already file-backed.

## The critical invariant: export must not rotate live tokens

This is where a naive migration breaks production. A live agent (say `alpha/cosmo`) holds a token
whose hash is in `members.token_hash`. Export writes `seats/cosmo.toml` (identity, no secret). The
**very next reconcile** then sees `cosmo` in both the files (D) and the db (C) → it is a
**match-by-name UPDATE in place** (projection-reconcile.md), which **preserves `id`, `token_hash`,
and `bound_at`**. So the round-trips to a no-op: files describe exactly what the db already holds,
reconcile changes nothing, and cosmo's live session never notices.

The ordering guarantee that makes this safe: **export derives the files *from* the db**, so by
construction D ≡ C at cutover. Migration is the one moment files and db are born identical; the
no-op reconcile is the proof. (The verification gate below asserts it before trusting it.)

## `bound_at` backfill — every legacy member is already held

The `bound_at` column (seat-lifecycle-as-files.md) is new; existing rows have it null. But under the
old model, **mint == delivery** — `team add` returned the token and the holder kept it. So every
pre-existing member is, in the new vocabulary, **already bound**. The migration that adds the column
backfills `bound_at = created_at` for all existing members.

Why this exact rule: a null `bound_at` would mark a legacy seat as *unheld*, and a stray
`claim cosmo` would then rotate cosmo's token out from under a live session. Backfilling all legacy
members to *held* closes that hole — a migrated seat can only be moved by `claim --token` adoption or
operator `reclaim`, never by an accidental plain claim. New seats minted after migration get
`bound_at` through the normal first-auth-touch path.

## Cutover is per-team and gradual, not big-bang

The daemon decides file-vs-db authority **per team**: a team is **file-backed iff it has a
`rosterHome`** (i.e. `export` has run for it). `reconcileAll` manages only the teams in
`rosterHome`; every un-exported team stays **db-only and completely untouched** — legacy `team add`
against it still works exactly as before.

This is the safety property that makes the rollout boring: migration is **one team at a time, on the
operator's schedule**. `alpha` can move to files while a dozen other teams keep running db-only on
the same daemon. There is no flag-day, no all-or-nothing.

## Verification gate — prove parity before trusting the files

`export` does not silently declare the files authoritative. After writing them it runs the
**semantic round-trip guard** (seat-file-format.md, guard 1) as a migration gate: parse the new
files → project into a scratch `:memory:` db → assert the projected roster **deep-equals the live
roster** it read in step 1 (same names, kinds, roles, lifecycles, `lifecycle_until`). Only on parity
does it write `rosterHome` and complete. A mismatch aborts the export with a diff — the files are
*not* yet authoritative, the db is untouched, and the operator fixes and retries.

So the dangerous step (handing authority to the files) is gated on a proof that the files reproduce
the live roster exactly.

## The stale-daemon reality (why this can't run today)

The live `alpha` daemon is the **published 0.2.0 binary** (global LaunchAgent) and predates the
projection/reconcile code — it cannot run any of this. The [stale-daemon
note](../decisions/) already flagged that the dogfood team is running an old binary that also lacks
the ADR 046/053/057 fixes. So:

- `team export` requires a daemon **built with the ADR 058 projection layer** — i.e. the release that
  ships this stack, not 0.2.0.
- For `alpha` specifically, the options are the same as that note's: (a) wait for the release and
  migrate then, or (b) stand up a **separate dev daemon** (own `MUSTERD_DB`) to dogfood the migration
  end-to-end before it ships. Bouncing the live daemon is still refused while Clyde/Cosmo are
  connected (ADR 047 service guard), so a dev daemon is the clean path to exercise migration now.

This doc is the plan; it lands behind the same release gate as the rest of the stack.

## Rollback

Migration is additive and reversible because **the db is never mutated by export** — it stays the
projection's backing store and the pre-migration source of truth simultaneously at the moment of
cutover. To roll a team back: delete its `.musterd/team.toml` + `seats/`, revert the `.gitignore`
flip, remove its `rosterHome` entry → the daemon treats it as db-only again, and the (untouched) db
rows carry on. No data is lost because nothing was deleted from the db to begin with.

## Per-team rollout order

1. A throwaway test team on a dev daemon — exercise `export` → parity gate → no-op reconcile →
   confirm a live token still authenticates across the cutover.
2. `alpha` on a dev daemon (or post-release), so the dogfood team becomes the first real file-backed
   roster and the seat-claim-disaster fix gets validated on the file surface.
3. Document `team export` in the agent primer so a fresh agent inherits the file-native model.

## Code seams

| Where | Change |
|---|---|
| `cli/src/commands/team.ts` | add `export` subcommand: read roster → write canonical files → parity gate → write `rosterHome` → gitignore flip + `git add`. |
| `cli/src/config.ts` | add `rosterHome: Record<slug, absFolder>` to global config (next to `bindings`). |
| `server` migration | add `members.bound_at INTEGER`; **backfill `bound_at = created_at` for all existing rows** in the same migration. |
| `server/src/projection/reconcile.ts` | `reconcileAll` iterates only `rosterHome` teams; db-only teams are skipped (legacy path intact). |
| `server` roster read endpoint | export reuses the existing roster read; no new read surface. |
| `cli/src/onboard/init.ts` | already gitignoring only `binding.json` post-058; `export` applies the same flip to pre-existing repos. |

## Deferred

- **A member that left (`left_at` set) before migration** — export only writes live members, so a
  tombstoned legacy member has no file; its history stays in the db (correct — files are the *current*
  roster, not the archive). Confirm no FK/report path expects a file for a departed member.
- **Multiple folders already bound to the same team** — only one becomes `rosterHome`; the others keep
  their `binding.json` (they *hold* seats, they don't *own* the roster). Spec the operator guidance for
  picking the home when several repos touch one team.
- **Concurrent live `team add` during an export** — the parity gate would catch the new member as a
  mismatch and abort; a brief advisory "roster is migrating" lock is cleaner. Build-time detail.
