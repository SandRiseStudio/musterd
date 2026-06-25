# 058 — Durable coordination on git, live state on the daemon

- Status: proposed (sketch) — 2026-06-25
- Date: 2026-06-25
- Provocation: the Sierra/Max-Agency podcast — "coding agents are really good at file
  systems, git, grep; materialize everything into those structures so coding agents can cook"
  + "meet the models on their turf 80% of the time." Plus Sierra's Journeys: a declarative
  surface that compiles **isomorphically** (round-trips losslessly) to the executable layer.

## Context

Every coordination fact musterd knows lives in one SQLite file behind the daemon, reachable
only through authenticated HTTP/WS verbs and the MCP tool surface. `db/schema.ts` puts six
tables side by side: `teams`, `members`, `presence`, `messages`, `inbox_cursors`,
`schema_meta`. They are not the same _kind_ of fact:

- **Durable, declarative, low-churn** — `teams` (slug, display, lifecycle) and `members`
  (name, kind, role, lifecycle): the **seat roster**. Plus the folder→seat **binding** the CLI
  keeps (ADR 055). This is identity and structure. It changes a few times a day, it is the
  thing a human or agent _reasons about_, and it is exactly the shape — names, roles, a small
  declarative tree — that a coding agent reads, diffs, and edits fluently.
- **Live, ephemeral, high-churn** — `presence` (`last_seen_at`, `conn_id`, `held_until`):
  sub-second liveness, heartbeats every 15s, reaped at 45s. Meaningless the moment the daemon
  stops. Serializing it to git would be absurd.
- **A log** — `messages`: an append-only coordination event stream.

The agent-facing surface treats all three identically: a verb against the daemon. The
[seat-claim disaster](../../) (2026-06-25) is what that costs. A fresh agent told "claim the
Olive seat" burned ~5 min and **escalated to hand-editing the live SQLite DB** to get it done.
Read through Sierra's lens, the agent wasn't dumb — it fell off musterd's turf (a foreign verb
maze) back onto turf it _is_ fluent in (a file it can edit). It reached for the file system
because claiming a seat is a **durable, declarative act** that we had trapped behind a
**live-state transport**. ADR 055 patched the specific dead-end (`claim --token`,
no-dead-end conflict message); this ADR asks the structural question underneath it.

## Problem

Decide which coordination facts are **source-of-truth in git-legible files** and which stay
**daemon-owned live state**, and make the durable half **round-trip losslessly** (Sierra's
isomorphism property) so the daemon is a _projection_ of the files, not a rival source of
truth — **without** (a) putting auth secrets in git, (b) moving genuinely-live presence off
the daemon, or (c) forking into two stores that can silently disagree.

## Decision (sketch — the lines, not yet the migration)

### 1. Three tiers, drawn by churn × durability × secrecy

| Fact | Tier | Source of truth | In git? |
|---|---|---|---|
| team def, **seat roster** (name/kind/role/lifecycle), folder→seat binding | **Durable / declarative** | a `.musterd/` file tree | **yes** |
| `token_hash`, presence (`conn_id`, `last_seen_at`, `held_until`), the `working:` label clock | **Live / secret** | daemon SQLite | **no, never** |
| `messages` (the act stream), `inbox_cursors` | **Log** | daemon SQLite (authoritative) | optional export only |

The cut is not "tables vs. files" — it runs **through** the `members` row. The seat's
_identity_ (name, kind, role, lifecycle) is durable and goes to git; its _auth material_
(`token_hash`) is a secret and stays in the daemon. One row, two tiers. This is the crux the
naive "move members to git" framing misses.

### 2. `.musterd/` is the declarative surface — one file per seat

A team's durable state materializes as a small file tree a coding agent reads and diffs:
`team.toml` (slug, display, lifecycle) + a `seats/` directory with **one TOML file per
member** (`seats/<name>.toml`: name, kind, role, lifecycle). The daemon **loads this as a
projection** into the `teams` / `members` tables on start and on change; the files are source
of truth for the durable tier. Editing the seat roster is then editing a file — the agent's
native idiom — not discovering a verb. The `db/seed.ts` path generalizes from "seed once" to
"reconcile the projection."

One-file-per-seat over a single `team.toml` seats block or a `seats.md` table, for three
reasons that all serve the thesis: (a) **per-seat diffs** — a role change is a one-file,
one-line blame, PR-reviewable in isolation, which is what makes the durable tier a real
change-management surface (the Fortune-20 governance point Sierra stressed, and musterd's own
Release section); (b) **byte-equal round-trip** — a per-seat TOML file reserializes identically,
so the isomorphism check (Decision 3) stays strict with no normalization pass; a Markdown table
would force whitespace normalization and weaken the one invariant the ADR leans on; (c) it
mirrors the existing **ADR-per-file** convention. A 4-line TOML file is still fine to hand-edit.

### 3. Isomorphic round-trip is the invariant, enforced by a check

The durable tier must satisfy **file → daemon projection → file** as an identity — but on the
*parsed structure*, not the bytes (the files are hand-edited, so whitespace/key-order must not
count as drift). It splits into two guards, specified in
[seat-file-format.md](../design/seat-file-format.md): **correctness** = a semantic round-trip
(`parse → project → serialize → parse` deep-equals the original parse), which is what makes the
daemon a faithful _materialized view_ rather than a second opinion; and **tidiness** = a separate
`musterd fmt` / `format:check` canonicalization guard (gofmt-style, byte-level) so PR diffs stay
clean — the lineage of ADR 043's arch-tree drift check. This is Sierra's Journeys↔code isomorphism,
narrowed to the durable tier (you do **not** round-trip presence; it has no file form).

### 4. Claiming a seat becomes a file act + a secret mint (generalizes ADR 055)

The seat (identity) is declared in git; the **token is minted/held by the daemon and never
serialized**. So `claim` decomposes cleanly:
- **bind** — write the folder→seat binding (durable, git-legible), and
- **adopt** — daemon mints or rebinds the `token_hash` (secret, daemon-only).

`addMember` / `authMember` in `store/members.ts` keep owning the secret half; the roster half
moves to the projection. The agent reaches for a file because the durable act _is_ a file
act now — closing the disaster's escalation path by design instead of by guardrail. ADR 055's
`claim --token` is the special case this generalizes.

### 5. The file is the single writer of durable state — concurrency is a git merge

The daemon **never originates a durable-tier write at runtime.** A roster mutation is a file
edit: the `team add` / `claim` verbs become "write `seats/<name>.toml`, then reconcile,"
not "INSERT INTO members." Because the file is the sole writer, there is no two-writer race to
arbitrate — two agents changing the roster concurrently is an ordinary **git merge** on
distinct (per-seat) files, which is precisely why one-file-per-seat (Decision 2) was chosen:
independent seats touch independent files, so the common case doesn't even conflict. The daemon
is a strict follower: it observes a file change (watch / `SIGHUP` / next reconcile), diffs the
desired roster against its projection, and applies adds/role-changes/removes. The only thing it
_originates_ is the secret half (Decision 4) — `token_hash` is minted on reconcile, keyed by
seat identity, and never written back to the file. This collapses the earlier "who wins on a
concurrent edit" open question into git's existing answer, instead of inventing a lock.

### 6. Presence stays exactly where ADR 057 put it — daemon-only, no file form

Nothing in `store/presence.ts` moves. `attach`/`heartbeat`/`reapStale`/`touchAmbientPresence`
and the 45s `presenceTimeoutMs` clock are the live tier by definition. The "materialize to
git" instinct **stops at the durability line** — applying it to presence would be the
over-correction. Ambient presence (ADR 057) is the proof the live tier needs its own
fast-path: liveness from real actions, never a committed fact.

### 7. The message log stays daemon-authoritative; git export is a separate batond concern

`messages` is high-churn and already has a consumer story (cursors, watch, the
trace/eval/experiment flywheel, ADR 051). It stays daemon-owned. _Exporting_ it to a
git-legible JSONL for offline analysis is a batond/observability feature, not a source-of-truth
move — keep it out of this ADR so the durable/live line stays crisp.

## Consequences

- The seat-claim disaster's root cause is removed structurally: the durable act an agent kept
  falling back to the file system to perform _is_ a file act. Turf, not tourist destination.
- The daemon becomes a projection of git for the durable tier and the sole owner of the live
  tier — one honest line, enforced by an isomorphism check (ADR 043 lineage).
- No secret ever lands in git: the cut runs through the `members` row, not around it.
- Onboarding (the [onboarding gap](../../)) improves for free: a fresh agent can read
  `.musterd/` to learn the team instead of learning a verb vocabulary first.
- Cost: a projection/reconcile loop and a drift test to build; a real risk of file⇄db skew if
  the isomorphism check is weak — so the check is load-bearing, not optional.
- Settled here: **format** = one TOML file per seat under `.musterd/seats/` (Decision 2);
  **concurrency** = the file is the single writer, races resolve as git merges (Decision 5);
  **scope** = message-log git export is deferred to batond, not this ADR (Decision 7).
- Implementation design + the remaining seams are resolved in
  [projection-reconcile.md](../design/projection-reconcile.md): **trigger** = boot floor +
  debounced `fs.watch` + `SIGHUP` fallback (not lazy-per-command); **delete** = soft `left_at`
  tombstone (FK integrity + reuses `leaveMember`); **rotation** = deletion is revocation, re-add
  revives the same `id` but re-mints the token, steady-state preserves it; **cross-network** = git
  replicates the files, the projection + all secrets stay daemon-local; **root discovery** = the
  global daemon reconciles the union of `.musterd/` trees from the existing ADR 020 `bindings`
  registry.

## Alternatives considered

- **Move everything to git, kill the daemon.** Rejected: presence is sub-second live state with
  no file form; ADR 057 exists precisely because liveness ≠ a committed fact. Over-applies the
  podcast's lesson past its durability line.
- **Leave it all in SQLite, just teach the verbs harder (better primer/AGENTS.md).** This is the
  status quo + ADR 055. It treats the symptom (agent didn't know the verb) not the cause (the
  durable act was off-turf). Worth keeping as the live-tier story; insufficient for the durable
  tier.
- **Two independent stores, no isomorphism guard.** Rejected: that's the file⇄db skew failure
  mode with no backstop. The round-trip check (Decision 3) is the whole point.
- **`seats.md` Markdown table (human-warm, hand-edited).** Rejected as the primary format: a
  table can't reserialize byte-equal without a normalization pass, which weakens the isomorphism
  check (Decision 3) — the one invariant everything else leans on. A 4-line per-seat TOML is
  hand-editable enough; warmth isn't worth a lossy round-trip.
- **Daemon stays the durable writer, add a lock/CRDT for concurrent edits.** Rejected: reinvents
  what git already does for files. Making the file the single writer (Decision 5) gets merge
  semantics for free; a lock would be a second concurrency model bolted beside git's.
- **Put `token_hash` in git encrypted (SOPS/age).** Deferred: possible, but mixing secret
  management into the seat roster muddies the "agent reads/diffs it fluently" property. Keep
  secrets daemon-side for now.
