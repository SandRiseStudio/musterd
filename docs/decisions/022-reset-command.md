# 022 — `musterd reset`: an operator clean-slate command

- Status: accepted
- Date: 2026-06-17

## Context

Dogfooding repeatedly wants a clean slate — wipe every team, member, presence row (live or stale), and message and start fresh (2026-06-17 dogfood). The only ways to do it today are manual and error-prone: `rm ~/.musterd/musterd.db*` plus hand-editing `config.json` to drop the now-dangling identities. There is no `team remove`-style verb for "remove _everything_," and the per-folder `team remove` (ADR 019) is a soft-delete that keeps history by design — the opposite of what a reset wants.

The recurring dogfood failures (ADR 016 — a daemon silently serving the wrong db reads as "everyone offline"; orphaned adapters holding stale presence) say a reset must be _safe_: it must not wipe a db a running daemon still holds open, and it should be recoverable if run by mistake.

## Decision

Add a local, destructive **`musterd reset`** command that returns this machine to a clean slate:

- **What it wipes:** the daemon's SQLite database at the resolved db path (`MUSTERD_DB` → `~/.musterd/musterd.db`) — every team, member, presence, and message — by deleting the db file and its `-wal`/`-shm` siblings. A fresh `musterd serve` then re-creates an empty db at the current schema.
- **It also clears the local CLI state** in `config.json` — the `identities` and `bindings` maps and the `current` pointer — because after a db wipe those tokens authenticate against members that no longer exist (dead state, exactly the "everyone offline / wrong-db" confusion). The `server` URL is preserved. Per-folder `.musterd/binding.json` files are **not** hunted down (they live in project trees); `musterd init` repoints them.
- **Safety, three layers:**
  1. **Refuses while a daemon is live on the target db.** It probes the configured server's unauthenticated `/health` (which reports `db`, ADR 016); if a daemon is serving _this_ db path, it refuses and tells the user to stop it first — deleting an open SQLite file leaves the daemon writing to a ghost inode. A daemon serving a _different_ db, or none, does not block.
  2. **Backs up before destroying** (default). The db files + `config.json` are copied to `~/.musterd/backups/*.<ts>.bak` first; `--no-backup` opts out.
  3. **Confirms.** Interactive `y/N` when run on a TTY; on a non-TTY (scripts/CI) it refuses unless `--force`/`--yes` is passed.

Flags: `--force`/`--yes` (skip the prompt), `--no-backup`.

**Why a local file operation, not a server endpoint.** The alternative — a daemon `DELETE /everything` admin route — would add an unauthenticated, irreversible, destructive endpoint to the wire (a real security surface even on localhost-only v0.2) and a SPEC touch. The db is a local file; resetting it is an operator action, not a protocol one. So `reset` is pure filesystem + config, talks to the daemon only through the existing read-only `/health` probe, and adds nothing to the protocol.

**ADR 002 boundary preserved.** `commands/serve.ts` remains the _only_ place the CLI imports `@musterd/server`. `reset` deliberately **re-derives** the db-path default (`MUSTERD_DB ?? ~/.musterd/musterd.db`) rather than importing the server's `defaultDbPath`, and never opens the db (the CLI has no `better-sqlite3`) — so its confirmation names what it wipes generically rather than counting rows. The one-line duplication is cheap insurance against pulling the server runtime into a destructive client command.

## Consequences

- **No protocol/SPEC change.** No wire, schema, or act touched; `musterd/0.2` is unaffected. This ADR records a CLI-only operator verb (peer to ADR 019 `team remove` and the ADR 017 `reclaim` escape hatch).
- **Recoverable by default.** A mistaken reset is undone by restoring the timestamped backup; `--no-backup` is the explicit "I mean it" path. Backups accumulate in `~/.musterd/backups/` (the operator prunes them).
- **The db-path default is now duplicated** in the CLI (`reset`) and the server (`defaultDbPath`). If that default ever moves it must change in both; both are covered by tests, and the value is also pinned in docs.
- **Not a per-team wipe.** `reset` is all-or-nothing for the local db; selectively removing one team's members stays `team remove`. A scoped reset (`reset --team`) is a future addition if the need appears.
