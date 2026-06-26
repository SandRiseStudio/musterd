# Seat lifecycle as file operations — the agent-facing verbs for ADR 058

> **Status: implemented** (2026-06-25, commits f3d6a42 + 21ce328) — `team add`/`claim` write seat
> files; `unbind` + the `bound_at` held/unheld bit shipped. The one variance from this design: the
> `POST /members` inversion is **additive/per-team** (project-and-return for file-backed teams, the
> legacy originate path for db-only teams) rather than a hard cutover, so un-migrated teams are
> untouched — matching migration-bootstrap.md's per-team rollout.

> Third layer of the ADR 058 stack. [058](../decisions/058-durable-on-git-live-on-daemon.md) drew
> the durable/live line; [projection-reconcile.md](./projection-reconcile.md) built the
> file→daemon projection. This doc redesigns the seat lifecycle **verbs** — `team add`, `claim`,
> `team remove`, plus a new unbind — so that "the file is the single writer" (ADR 058 §5) holds at
> the command surface, and an agent never falls off-turf the way the
> [seat-claim disaster](../decisions/) did. Grounded in `cli/src/commands/{team,claim,reclaim}.ts`
> and `cli/src/config.ts`.

## The problem this layer must solve: secret handback

Today the create path is synchronous and the daemon **originates** the member: `team add olive`
calls `POST /members` (`http.addMember`), the daemon inserts the row and **returns the freshly
minted token** in the same response, which `teamAdd` prints as the adoption code (`team.ts:72-99`).
`claim` does the same to mint-or-reuse (`claim.ts:179`).

ADR 058 §5 forbids that: the daemon must not originate a durable write at runtime — the **file** is
the source of truth. But the token is a **daemon-held secret** (ADR 058 §1) that must never land in
the committed file. So writing `seats/olive.toml` can't, by itself, hand anyone a token. The
create flow has a request/response asymmetry: the durable fact is born as a file (client-side,
fire-and-forget), but the secret it needs is born on the daemon. **How does the writer get the
secret back without the daemon originating the durable fact?**

## Resolution: invert the endpoint — project-and-return, never originate

Keep one synchronous daemon call, but flip its meaning. `POST /members` stops being "create a
member." It becomes **"reconcile this seat from its file and return its token"**:

1. The client writes `seats/olive.toml` (the durable fact — committed, source of truth).
2. The client calls the daemon, naming the seat.
3. The daemon **reads the now-committed file as the authority**, projects it (the same
   `reconcileTeam` from the projection layer), mints `token_hash`, and **returns the plaintext
   token** — exactly once, as today.

The daemon never invents the seat; it refuses to mint for a name that isn't in a file. It is a
**projector that hands back secrets**, not an originator. The token is returned to the caller and
(for a teammate hand-off) printed — it is **never** written into the committed `team.toml`/`seats/`,
only into the gitignored `binding.json` of whichever folder ends up holding it.

This also degrades cleanly for the **no-call path** (a `git pull` brings in a teammate's
`seats/olive.toml`): the watch-triggered reconcile projects it and mints a token that simply waits
daemon-side. The eventual claimer gets a token via the rotation rule below — no lost-token dead end.

## Held vs. unheld: the one new server bit (`bound_at`)

A minted-but-undelivered token (from the `git pull` path) has no holder; rotating it disrupts
nobody. A token a teammate actively holds must **not** be rotated out from under them by a stray
`claim`. So the daemon must distinguish **held** from **unheld** — and it cannot use presence to do
it: ADR 057's whole point is that a real holder reads `offline` between bursty one-shot commands, so
liveness is not a safe "is this seat held?" signal.

**Decision:** add one nullable column, `members.bound_at INTEGER` (additive migration, same shape as
the ADR 014/021 presence columns). It is set on the **first authenticated touch** of a seat's
token and cleared only by rotation or operator `reclaim`. A seat is **held** iff `bound_at IS NOT
NULL`. This is durable across the holder going offline, which presence is not.

The seat state machine:

| State | Meaning | Who can take it |
|---|---|---|
| **declared** | file exists, projected, `token_hash` set, `bound_at` null | any `claim` mints/rotates + returns the token |
| **held** | `bound_at` set (someone authenticated) | only `claim --token` (adopt, ADR 055) or operator `reclaim` (clears `bound_at`) |
| **tombstoned** | file deleted, `left_at` set | re-adding the file revives the same `id`, re-mints (rotation), back to *declared* |

Plain `claim olive` against a **held** seat hits the existing conflict path (`claim.ts conflictError`)
— "already a seat and this folder doesn't hold its token → adopt with `--token`, or take a pool
seat." That logic survives almost verbatim; only its trigger moves from a `UNIQUE(team_id,name)` DB
violation to `bound_at IS NOT NULL`.

## Every lifecycle act is a git diff (the governance payoff)

Because the durable fact is a committed file, each seat operation is a reviewable diff — which is
the Fortune-20 change-management story Sierra stressed, now native to musterd's Release tier:

| Verb | File op | Daemon op | Git artifact |
|---|---|---|---|
| `team add olive --kind agent` | write `seats/olive.toml` | project + mint, **print token** | `+ seats/olive.toml` |
| `claim olive --token <code>` | write `binding.json` (gitignored) | auth → set `bound_at` | *(no committed change — adoption is local)* |
| `claim --role backend` | write `seats/backend-3.toml` + own `binding.json` | project + mint + set `bound_at` | `+ seats/backend-3.toml` |
| `team remove olive` | **delete** `seats/olive.toml` | tombstone (`left_at`) + token dies (revocation) | `- seats/olive.toml` |
| `unbind` (new) | delete own `binding.json` | clear `bound_at` (seat stays *declared*) | *(none — you stop holding it; seat persists)* |
| operator `reclaim olive` | *(none)* | clear `bound_at` (force seat back to *unheld*) | *(none — force-free without deleting the seat)* |

The git history of `seats/` **is** the membership audit log. Adding a teammate is an added file in a
PR; removing one is a deletion in a PR; a role change is a one-line diff with clean blame — no
separate audit store, no DB archaeology.

Note the two distinct "I'm leaving" acts, which the file model finally separates cleanly:
- **`unbind`** — *I* stop occupying this seat, but the seat stays on the team for someone else
  (clear `binding.json` + `bound_at`; the committed `seats/olive.toml` is untouched).
- **`team remove olive`** — the seat should *no longer exist* (delete the file → tombstone +
  revocation). This is the durable, PR-reviewable act.

Today both collapse into `left_at` (`team.ts teamRemove`); files give them different shapes because
they *are* different durable facts.

## Verb-by-verb redesign

- **`team create <slug>`** — write `team.toml` + the creator's own `seats/<you>.toml`, then
  project-and-return the creator's token into `binding.json`. The current auto-bind behavior
  (`team.ts:36-44`) is unchanged; only its writes move file-first.
- **`team add <name>`** — write `seats/<name>.toml`, project-and-return, **print the token + the
  `claim <name> --token <code>` adoption hint** exactly as today (`team.ts:87-99`). The teammate
  hand-off UX is byte-for-byte the same; the difference is the seat is now a committed file the
  operator can see, diff, and PR before the teammate ever connects.
- **`claim <name>`** (mint path) — write `seats/<name>.toml` if absent, project-and-return, write
  own `binding.json`, set `bound_at`. Against a *held* seat, `conflictError` fires unchanged.
- **`claim <name> --token <code>`** (adopt, ADR 055) — unchanged on the wire: authenticate the token
  (which now also sets `bound_at`), refuse on holder mismatch, write `binding.json`. No file write —
  adoption is a local act on an already-declared seat. The `claim.ts:157-176` adopt block survives
  as-is.
- **`claim --role <role>`** — `nextRoleHandle` picks the open handle (unchanged), then write
  `seats/<handle>.toml` + project-and-return + bind. The race retry (`claim.ts:189-201`) still
  covers two folders grabbing the same handle — and because seats are separate files, the loser just
  retries the next handle; no merge conflict.
- **`team remove <name>`** — delete `seats/<name>.toml`. Reconcile tombstones (`left_at`) and the
  rotation rule kills the token. This *is* the revocation; commit the deletion for the audit trail.
- **`unbind`** (new, small) — delete this folder's `binding.json`, call the daemon to clear
  `bound_at`. The seat returns to *declared* and is freely re-claimable. Fills the gap between
  "reload my own seat" and "remove the seat entirely."

## Why this keeps the agent on-turf (the disaster, closed by construction)

The [seat-claim disaster](../decisions/) was an agent escalating to hand-edit the live SQLite DB
because claiming a seat — a durable, declarative act — was reachable only through an opaque verb
maze over a live transport. Under this design the durable act **is** a file the agent reads, writes,
and diffs in its native idiom: to add a seat, write a 4-line TOML file; to see the roster, read
`seats/`; to remove someone, delete a file and commit it. The daemon call shrinks to a single
secret-handback the agent doesn't have to understand to reason about the team. The verb maze that
sent it to the DB is gone because the durable surface is the file system it was already fluent in.

## Code seams

| Where | Change |
|---|---|
| `server` `POST /members` route | invert: read the seat's committed file, `reconcileTeam` it, return the minted token; refuse names not present in a file. Originates nothing. |
| `db/schema.ts` + a new migration | add `members.bound_at INTEGER` (nullable); set on first authenticated touch (`store/members.ts authMember`), clear on `reclaim`/rotation. |
| `store/members.ts` | `authMember` stamps `bound_at` on first success; `conflictError` trigger moves from `UNIQUE` violation to `bound_at IS NOT NULL`. |
| `cli/src/commands/team.ts` | `teamCreate`/`teamAdd`/`teamRemove` become file writers (write/delete `seats/*.toml`) reusing the shared serializer, then project-and-return. |
| `cli/src/commands/claim.ts` | `claimSeat` writes the seat file before the project-and-return call; adopt + role-pool paths keep their existing logic. |
| `cli/src/commands/unbind.ts` (new) | delete `binding.json` + clear `bound_at`. |
| `cli/src/commands/reclaim.ts` | already force-frees a seat (ADR 055); now also clears `bound_at` and leaves the file intact. |

## Deferred

- **Concurrent `team add` of the same name in two folders** — two writers create the same
  `seats/<name>.toml`; git surfaces the conflict on commit (the intended single-writer behavior), but
  the pre-commit local race (both call project-and-return) needs the `UNIQUE`/`bound_at` guard to pick
  a winner. Reuses the existing conflict path; detail at build time.
- **`bound_at` and ADR 042 human fan-out** — a human seat legitimately bound from several surfaces;
  `bound_at` is set-once and orthogonal to presence fan-out, but confirm it doesn't fight kind-scoped
  single-active when specced.
