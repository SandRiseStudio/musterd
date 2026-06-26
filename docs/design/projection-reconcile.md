# Projection & reconcile — implementing ADR 058

> **Status: implemented** (2026-06-25, commits 96902fd → 21ce328) — as-built design; the code is in
> `packages/server/src/projection/{load,reconcile,serialize,watcher}.ts`.

> Implementation design for [ADR 058](../decisions/058-durable-on-git-live-on-daemon.md). The ADR
> drew the line (durable seat roster → git-legible files; live state → daemon). This doc answers
> the four seams it left open — reconcile **trigger**, **delete** semantics, **secret rotation**,
> and **cross-network** replication — concretely against `db/open.ts`, `db/seed.ts`,
> `store/members.ts`, and the existing binding registry (`packages/cli/src/config.ts`).

## The identity problem (everything else falls out of this)

The durable files key a seat by **name** — the human-meaningful handle (`olive`). The database
keys a member by **`id`** (a ulid), and that id is the FK target of the coordination log:
`messages.from_member` / `messages.to_member` → `members(id)` (`db/schema.ts`). The token lives as
`token_hash` on the same row.

So a member row carries facts from **two tiers at once** (ADR 058 §1): `name/kind/role/lifecycle`
are durable (mirror the file), while `id` and `token_hash` are **daemon-private anchors that must
stay stable across reconciles**. Regenerating `id` on every reconcile would orphan the message
log; rotating `token_hash` on every reconcile would invalidate every live token on restart.

This forces the whole model: **reconcile is a match-by-name UPDATE, never a truncate-and-reload.**
Name is the durable public key; `id` + `token_hash` are private and preserved unless a specific
transition (deletion) says otherwise.

## File layout — split secret from durable inside `.musterd/`

`.musterd/` already exists per workspace and today holds `binding.json` (team+member+**token**,
0600, gitignored — `cli/src/config.ts saveBinding`). The durable tier moves in alongside it, and
the secret/durable split becomes a **gitignore line**, not a directory boundary:

```
.musterd/
  binding.json        # SECRET — claim token for THIS folder; 0600; gitignored (unchanged)
  team.toml           # DURABLE — slug, display, lifecycle; committed
  seats/
    olive.toml        # DURABLE — name, kind, role, lifecycle; committed (one file per seat, ADR 058 §2)
    david.toml
```

Concrete change to onboarding: `cli/src/onboard/init.ts` currently gitignores all of `.musterd/`;
it must instead gitignore **only the secret** (`/.musterd/binding.json`) so `team.toml` + `seats/`
are versioned. This is the physical realization of ADR 058's "the cut runs through the row": the
token is gitignored, the seat that owns it is committed.

## Root discovery — the binding registry is already the answer

The daemon is global (one LaunchAgent, one `~/.musterd/musterd.db`, hosts every team — see the
`countLivePresences` comment in `store/presence.ts`). So "where is `.musterd/`?" has no single
answer: there is one tree **per project folder**. The seam ADR 058 left open.

It is already solved by the **`bindings` registry** (ADR 020): `cli/src/config.ts` keeps
`config.bindings[absoluteFolderPath] = { team, member, surface }` in `~/.musterd/config.json`,
written by `recordBinding` on every `saveBinding`. That registry is precisely the set of folders
that participate in musterd on this machine.

**Decision:** the daemon's reconcile roots = the folder paths in `config.bindings`. On boot and on
each trigger it reconciles the **union** of `<folder>/.musterd/` trees into the one global
projection. A new project joins the reconcile set the moment its first `claim`/`init` records a
binding — no new registry, no daemon config. (Tests and the in-memory path can pass an explicit
root list, bypassing the registry.)

## The reconcile algorithm

`reconcileTeam(db, spec)` where `spec` is a parsed `team.toml` + its `seats/*.toml`. Let **D** =
desired seats (from files, keyed by name) and **C** = current projection
(`members WHERE team_id = ? AND left_at IS NULL`, keyed by name):

- **name ∈ D, ∉ C → ADD.** `createTeam` if the team is new, then `addMember` (mints `id` +
  `token`). This is the only path that originates a secret. The minted token is surfaced exactly
  as today (returned once) for `claim` to pick up.
- **name ∈ D ∩ C → UPDATE in place.** Diff `role/kind/lifecycle`; `UPDATE members … WHERE id =`
  the existing row. **`id` and `token_hash` are preserved** — message-log FKs and the live token
  stay valid. (A `kind` flip agent↔human is allowed but logged; it interacts with ADR 042
  kind-scoped single-active.)
- **name ∈ C, ∉ D → REMOVE.** Soft-delete (below).

The loop is **declarative and idempotent** — it computes desired-vs-actual and applies the delta,
k8s-style. Two payoffs: (a) it generalizes `db/seed.ts` (`seedDawn` becomes "a spec, reconciled");
(b) idempotence is what makes the flaky-`fs.watch` trigger safe (next section) — a missed or
duplicated event just means "reconcile again," which converges to the same state.

## Trigger — boot floor + watch primary + SIGHUP fallback; **not** lazy-per-command

- **Boot (always).** `createServer` calls `reconcileAll(db, roots)` after `openDb`, before
  `listen()` — the floor guarantee that the projection matches the files at startup. This replaces
  the implicit `seedDawn` call site for production.
- **File-watch (primary runtime trigger).** A debounced `fs.watch` over each `.musterd/` root,
  started in `listen()` next to `startReaper` and returning a `stop` fn, `unref`'d — same lifecycle
  shape as `presence/reaper.ts`. Debounce (~250ms) coalesces a multi-file `git checkout` into one
  pass. We never interpret individual events; **any** event triggers a full reconcile, because
  declarative reconcile is self-healing against `fs.watch`'s well-known cross-platform unreliability
  (missed/duplicated events, network-FS gaps).
- **SIGHUP (explicit fallback).** The daemon **bin** (not the server lib — tests must not grab
  process signals) registers `process.on('SIGHUP', reconcile)`, exposed as `musterd reload`, for
  environments where `fs.watch` is unreliable.

**Rejected: lazy-on-next-command.** It would put filesystem stat+TOML-parse on the authenticated
hot path — the *same* path ADR 057's ambient touch runs on — regressing the latency-sensitive live
tier (the exact split this whole effort is defending). And a roster change wouldn't reach live
`--watch` rosters until someone happened to issue a command. Durable reconcile must never run on the
request hot path.

## Delete semantics — soft tombstone (`left_at`), never hard-delete

A seat file removed from `.musterd/seats/` (name ∈ C, ∉ D) sets `members.left_at = now` via the
existing `leaveMember` path. **Never `DELETE`.** Three reasons:

1. **FK integrity.** `messages.from_member` is a plain `REFERENCES members(id)` (no `ON DELETE`).
   Hard-deleting a member with history would violate the FK or orphan the coordination log — the
   durable record that is also batond's substrate. The log must keep its referent.
2. **It already exists.** `leaveMember` + `listMembers`' `left_at IS NULL` filter are the
   established soft-delete; reconcile-remove reuses them rather than inventing a second deletion.
3. **Reversible** — required for rotation (next).

Note a latent constraint this surfaces: `idx_members_team_name` is `UNIQUE(team_id, name)`
regardless of `left_at`, so a tombstoned seat **blocks** a second row of the same name. Revival
must therefore *update the tombstone*, not insert — which is exactly what we want.

## Secret rotation — deletion is revocation; re-add is same identity, new secret

Seat `olive.toml` deleted then re-added:

**Decision:** re-adding **revives the tombstoned row** (clears `left_at`, preserves `id`) **and
re-mints `token_hash`.**

- Preserving `id` keeps the message log continuous — history still attributes to the same olive.
- Re-minting the token treats **file deletion as a revocation act.** A removed-then-recreated seat
  is a fresh grant; the old token (possibly leaked, or still held by the prior occupant) must not
  silently keep working. This is musterd exercising the revocation primitive it already claims as
  its domain ([Flue boundary](../decisions/) / ADR 017 `superseded`) — now expressed durably: the
  new occupant must `claim --token` with the freshly-minted token.

Critically, rotation is bound **only to the tombstone→revive transition**, not to any edit:
- a steady-state seat that simply persists across restarts → matched, everything preserved, **no
  rotation** (so a daemon restart never invalidates live tokens);
- a role/lifecycle edit on a live seat → UPDATE in place, `token_hash` preserved, **no rotation**.

This makes the rule teachable and exactly mirrors ADR 058 §4: **file presence = identity
continuity; file deletion = secret revocation.**

## Cross-network — git replicates the files; the projection never leaves its daemon

One team = one daemon ([cross-network topology](../decisions/), ADR 039/040; Topology B = remote
participants connect *to* the one authoritative daemon over an overlay).

**Decision:** the unit of replication is the **git tree** (`.musterd/`), not the SQLite projection.
Each machine's checkout is the same versioned source; the authoritative daemon reconciles its local
checkout into its local projection. The projection and every daemon-private anchor — `id`,
`token_hash`, all of `presence` — are **daemon-local and never cross the network** via this
mechanism. That preserves ADR 040's posture (refuse plaintext WAN; secrets stay local): git moves
the non-secret durable tier; no `token_hash` is ever serialized to a file or a wire frame.

## Isomorphism check — the load-bearing guard (ADR 058 §3)

Two guards, disentangled in [seat-file-format.md](./seat-file-format.md) (the upstream "byte-equal"
wording was too strong — the files are hand-edited). **Correctness** (load-bearing): load a
`.musterd/` fixture → `reconcileAll` into an `:memory:` db → serialize the durable projection back →
`parse` it → assert it **deep-equals the original parse** (structure, not bytes — tolerates
whitespace/key-order in hand edits). This is what proves the projection is a faithful *materialized
view*, not a second opinion. **Tidiness** (cosmetic): a separate `musterd fmt --check` asserts
committed files are canonical, gofmt-style, so PR diffs stay clean — that one is byte-level, but it
is a formatting check, not the correctness contract.

## Code seams (new + changed)

| Where | Change |
|---|---|
| `server/src/projection/load.ts` (new) | parse `.musterd/` tree → `TeamSpec[]` (TOML). |
| `server/src/projection/serialize.ts` (new) | `TeamSpec → files`, canonical key order; used by the isomorphism check. Shared with the CLI writer. |
| `server/src/projection/reconcile.ts` (new) | `reconcileTeam` / `reconcileAll`; the match-by-name delta loop; reuses `createTeam`, `addMember`, `leaveMember`. |
| `server/src/projection/watcher.ts` (new) | debounced `fs.watch` per root; `start → stop` fn, `unref`'d; modeled on `presence/reaper.ts`. |
| `server/src/index.ts` | call `reconcileAll` after `openDb`, before `listen()`; start the watcher in `listen()` alongside `startReaper`; stop it in `close()`. |
| `server/src/config.ts` | add reconcile roots (default: the `bindings` registry folders) + a `MUSTERD_TEAMS_DIR` override + a debounce constant. |
| daemon **bin** | register `SIGHUP → reconcile` (lib stays signal-free). |
| `cli/src/onboard/init.ts` | gitignore only `/.musterd/binding.json`, not all of `.musterd/`; scaffold `team.toml` + `seats/`. |
| `cli/src/.../team add`, `claim` | become file writers (write `seats/<name>.toml`; ADR 058 §5 — file is the single writer) reusing the shared serializer, then let reconcile project. |
| `db/seed.ts` | `seedDawn` stays as a direct-insert fixture for unit tests that don't want a filesystem; the file→reconcile path is production. |

## Deferred (genuinely out of scope here)

- **Message-log git export** — a batond concern, fenced out per ADR 058 §7.
- **`team.toml` schema versioning** — when the durable format itself evolves (parallel to
  `schema_meta`), TBD on first breaking change.
- **Concurrent file-edit vs. in-flight reconcile** — handled by debounce + idempotent re-run, but a
  formal "reconcile is single-flight per root" guard (skip/queue if one is mid-pass) is worth a
  small lock; noted, not yet specified.
