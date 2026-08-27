# Federation increment 3a — the node credential

- Date: 2026-08-27
- Lane: `01M12B79XGFSGAFQC0966F437V`
- Branch: `stanley/federation-node-credential`
- Author: stanley
- Status: design, awaiting nick's review

Build task under [ADR 325](../../decisions/325-multi-machine-federation.md),
[ADR 328](../../decisions/328-machine-credential.md), and
[ADR 331](../../decisions/331-ordering-substrate.md). No new ADR: 328 already decided the
credential, the enrollment ceremony, rotation, revocation, and the residence rule; 331 already
decided adoption-at-enrollment. If the build turns out to contradict either, that is the trigger to
write one — the same test that produced 331.

## What this slice is

ADR 325 named "increment 3" as one thing. It is three, and this is the first:

| Slice | Contents | Depends on |
| --- | --- | --- |
| **3a — this document** | `local_node` marker, `msnode_` identity, `msinv_` enrollment, rotation, revocation | v47's `nodes` row |
| 3b | sync wire format, push/pull routes, cursors | 3a |
| 3c | hub claim CAS, seat→node residence binding | 3a + 3b |

The hub storage engine needs no decision. ADR 325 already settled it: the hub is defined by the
surface it speaks, "a promoted daemon on SQLite is a valid hub — it is one process and one writer,
which is all the CAS requires." The engine choice was deferred to "the build's own ADR *if the
choice proves contentious*", and nothing here makes it contentious.

## Problem

A second machine breaks both of today's trust predicates. Bearer seat tokens are per-seat, and
`isLocalPeer` is per-process. ADR 328 decided the shape of the fix — a fifth token kind naming a
machine-team principal — and ADR 331 built the ordering substrate that refers to it. Neither has
running code. This slice writes it.

## Decisions this design makes

The two ADRs leave three things genuinely open. Each is settled here rather than discovered in the
diff.

### 1. `node join` runs CLI → local daemon → hub

ADR 328 §2 says "the joining daemon runs `musterd node join <hub-url> <code>`" without saying which
process opens the socket. Two readings; we take the second.

The CLI cannot enroll unaided in any case — the id it must present belongs to the local daemon's
`nodes` row, so a CLI talking straight to the hub still makes two hops, and now two processes write
the same machine-local file. Routing through the local daemon leaves one process owning the node
row, the credential, and `~/.musterd/node.json`. The cost is one extra local route
(`POST /node/enroll`, `isLocalPeer`-gated); the alternative's cost is the daemon re-reading a file
the CLI wrote behind it, which is the drift ADR 131 already warns about in its three-stores table.

### 2. The hub INSERTs the presented id; the guard is on rebinding

This is ADR 331's owed refusal path, made concrete.

Under v47 every daemon already holds a `nodes` row per team it hosts, ULID id, `credential_hash`
NULL. At enrollment the joiner **presents that id**. On the hub the id names a row that does not
exist yet — the hub has its own row for that team, with a different id — so the hub's adoption is
an `INSERT`, not the `UPDATE` the word "adopt" suggests. The joiner's own row is untouched; it gains
only the credential, on disk, not in the row.

**Any id the hub already knows is refused, whatever state it is in:**

```sql
INSERT INTO nodes (id, team_id, label, next_seq, credential_hash, enrolled_at, enrolled_by)
VALUES (?, ?, ?, 1, ?, ?, ?)
ON CONFLICT(id) DO NOTHING
```

`changes === 0` is the refusal. A legitimate joiner's id is fresh to the hub *by construction* — it
is the ULID v47 minted on the joiner's own machine — so a conflict is never a case to reconcile. It
is one of three, and all three want the same answer: an already-enrolled node (the refusal ADR 331
left owed), the hub's own row for this team, or the hub's own row for a **different team it hosts**.

Rotation is unaffected: it is its own statement keyed by node id under admin authority. Enrollment
binds once; rotation re-binds deliberately.

**Two holes found before this settled, and why the shape changed.** The first draft guarded only on
`credential_hash IS NULL`, which admits *any* unbound row — and a hub's own local v47 row is unbound
**permanently**, because a hub never enrolls with itself. A joiner presenting the hub's node id would
bind its credential onto the hub's origin and thereafter stamp events as the hub.

The patch for that was an exclusion subselect scoped to the enrolling team
(`nodes.id <> (SELECT node_id FROM local_node WHERE team_id = ?)`). **miley's review (2026-08-27,
`01M12KQHT8`) found that this still leaks across teams**: on a hub hosting A and B, a joiner
enrolling into A presents the id of the hub's local row for **B**. A's exclusion does not name it, B's
row is unbound, so the `DO UPDATE` wrote a foreign credential onto B's origin identity, left
`team_id` as B, and reported success — after which the joiner authenticates as team B's node. Both
holes are reachable only by an *invitee* (the invite is admin-minted, single-use, 15-minute-TTL),
which is exactly the party a CAS exists to bound.

`DO NOTHING` answers all of it with one clause and no subselect. The lesson is worth keeping: a guard
that has to *enumerate what it excludes* will keep missing cases, while "the hub has never seen this
id" is the property actually required. `local_node` stays load-bearing for `insertMessage`
(decision 3); it is simply no longer part of this guard. Test cases 3b and 3d below pin both holes —
they fail differently on the unpatched guard, so both are kept.

### 3. `local_node` — the marker increment 2 deferred, and why it is load-bearing now

`insertMessage` finds the row to stamp with (`store/messages.ts:37`):

```sql
SELECT id FROM nodes WHERE team_id = ? ORDER BY id LIMIT 1
```

Its own comment names the assumption: *"Before increment 3 lands enrollment there is exactly one row
per team; the ORDER BY makes the pick deterministic should that ever not hold."* Deterministic is
not correct. This slice is what makes it not hold — enrollment inserts a second row per team, and
from the first insert whose remote ULID happens to sort lower, **this daemon stamps its own messages
with another machine's `origin_node` and increments that machine's `next_seq`.** Two sequences
corrupt at once: ours acquires a permanent hole, theirs acquires numbers naming events it never
wrote. That is precisely the loss-versus-silence ambiguity ADR 331 exists to prevent, delivered by
331's own successor.

So 3a adds an explicit marker. Not a column on `nodes`: "is this row me" is machine-relative, and
`nodes` is hub-authoritative state that will eventually replicate (ADR 325 residence 1) — a boolean
meaning "me" is false on every receiver. A separate table is unambiguously ADR 325 residence 3,
local-only, never replicated:

```sql
CREATE TABLE IF NOT EXISTS local_node (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id)
);
```

v48 backfills it from the rows v47 minted, all of which are local by construction — there is no
enrollment yet, so every existing row is this daemon's own. `localNodeForTeam` then reads
`local_node` and its lazy-mint path writes both tables. This is a **correctness fix to increment 2's
substrate, not a feature**, and it must land before any route can insert a second node row.

### 4. The guarded-write helper ADR 328 asked for is declined, with reason

ADR 328 §Consequences: "This ADR makes the guarded-write pattern a third and fourth instance, after
the lane claim #1071 landed. Three was the threshold this ADR's own draft named for extracting a
shared helper, and the build should take it rather than hand-roll `changes === 0` twice more."

Checked against the code on 2026-08-27 at `5c1b35f0`. The premise does not hold. There are two
existing instances and they are different shapes:

- `packages/server/src/store/requests.ts:175` — `WHERE`-guarded `UPDATE`, `changes === 0` returns
  `null`. Failure is a value.
- `packages/server/src/store/lanes.ts:211` — read, compare, `throw LaneConflictError`, inside
  `db.transaction`. Failure is an exception carrying expected-vs-actual.

Both are correct. Neither is a special case of the other: they disagree on how a conflict is
*reported*, and that disagreement is deliberate — a lane conflict must tell a human what changed
under them, a request dedup must not throw on the ordinary racing-duplicate path. A helper spanning
them would force one call site to adopt the other's failure model.

So: the two new CAS sites here follow the `requests.ts` shape (`changes === 0` → refusal value),
which brings that shape to three instances. **If a third *matching* instance appears in 3b or 3c,
extract then** — over three call sites that actually agree, which is the extraction ADR 328 was
reaching for. Recorded here so a later reader sees a decision rather than an oversight.

## Data

**Two migrations, deliberately split.** `nodes` already exists from v47 and is not altered by
either.

**v48 — `local_node`** (decision 3). This is a correctness fix to increment 2 and stands on its own:
it is right even if nothing else in this slice ever lands, and it must precede any code path that
can insert a second node row. Giving it its own version means it can be reasoned about, and if
necessary shipped, independently of the credential work.

**v49 — `node_invites`** (below). The enrollment object.

```sql
CREATE TABLE IF NOT EXISTS local_node (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id)
);
INSERT OR IGNORE INTO local_node (team_id, node_id)
  SELECT team_id, id FROM nodes;   -- every existing row is local: enrollment does not exist yet
```

`INSERT OR IGNORE` rather than a bare insert, for the same rewind-and-replay reason as below.

```sql
CREATE TABLE IF NOT EXISTS node_invites (
  id          TEXT PRIMARY KEY,           -- ULID
  team_id     TEXT NOT NULL,
  code_hash   TEXT NOT NULL,              -- sha256 of the msinv_ plaintext, never the plaintext
  label       TEXT,                       -- what this invite is for, for the admin's own reading
  created_by  TEXT NOT NULL,              -- member name
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,           -- created_at + 15 min (ADR 328 §2)
  consumed_at INTEGER,
  consumed_by TEXT                        -- the nodes.id that consumed it
);
CREATE INDEX IF NOT EXISTS idx_node_invites_team ON node_invites(team_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_invites_code ON node_invites(code_hash);
```

Guarded `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` because the migration tests
rewind `schema_version` and replay the tail — the same rewind-and-replay constraint v47 carried.
There is no backfill: an invite is a live object, and history has none.

**`~/.musterd/node.json`**, mode 0600, written by the daemon, one entry per enrolled team:

```jsonc
{
  "nodes": {
    "<team-slug>": {
      "hub_url": "https://hub.example:7777",
      "node_id": "01M...",              // the id the daemon presented and the hub bound
      "credential": "msnode_...",       // the durable secret
      "enrolled_at": 1787859019696
    }
  }
}
```

Reached through `machineStatePath('MUSTERD_NODE_STATE', 'node.json')`, so the ADR 190 vitest
isolation applies automatically and the suite cannot write the operator's real file.

## Surface

**Protocol** — `packages/protocol/src/nodes.ts`, zod schemas for each body and response;
`TOKEN_PREFIXES` in `credentials.ts` gains `node: 'msnode_'` and `node_invite: 'msinv_'`.

**Store** — `packages/server/src/store/nodes.ts`, all pure functions over `Database`:

| Function | Guard |
| --- | --- |
| `mintInvite(db, teamId, label, createdBy, now)` | — returns plaintext once |
| `consumeInvite(db, teamId, code, nodeId, now)` | `WHERE consumed_at IS NULL AND expires_at > ?` |
| `bindNode(db, teamId, nodeId, label, hash, by, now)` | `ON CONFLICT(id) DO NOTHING` — **any** id the hub already knows is refused (see decision 2) |
| `rotateNode(db, teamId, nodeId, hash, now)` | `WHERE revoked_at IS NULL` |
| `revokeNode(db, teamId, nodeId, now)` | `WHERE revoked_at IS NULL` |
| `authenticateNode(db, teamId, token)` | `credential_hash = ? AND revoked_at IS NULL` |
| `listNodes(db, teamId)` | — credentials never returned |

`consumeInvite` and `bindNode` run in **one transaction**. A consumed invite whose bind then fails
would burn the admin's invite and enroll nobody; SQLite's single writer makes the pair atomic for
free, and the shape is the one `insertMessage` established in increment 2.

**Routes** — all new, on the ADR 040 secured bind. Per ADR 328 §6 nothing that is localhost-only
today becomes remote-reachable: these are routes `isLocalPeer` never guarded.

| Route | Auth |
| --- | --- |
| `POST /teams/:slug/nodes/invite` | admin (`isLocalPeer` or `mscr_` admin) |
| `POST /teams/:slug/nodes/join` | the `msinv_` code itself, and nothing else |
| `POST /teams/:slug/nodes/:id/rotate` | admin |
| `POST /teams/:slug/nodes/:id/revoke` | admin |
| `GET  /teams/:slug/nodes` | admin — `credential_hash` masked to prefix |
| `POST /node/enroll` | `isLocalPeer` — the local half of decision 1 |

`join` being gated only by the code is the ceremony, not a gap: the code is a short-TTL single-use
bearer secret, which is exactly ADR 328 §2's trust-on-first-use bounded by a short window.

**CLI** — `packages/cli/src/commands/node.ts`: `invite`, `join <hub-url> <code>`, `rotate`,
`revoke`, `list`. Secrets print once and are masked in `list`, matching `agent-key rotate`.

## Testing

TDD throughout; every row below is a test written before its code.

| # | Case | Falsifies |
| --- | --- | --- |
| 1 | Two concurrent joins on one invite — exactly one wins, the loser gets a refusal | the invite CAS |
| 2 | An expired invite is refused | the TTL |
| 3 | A second invite naming an already-bound node id is refused | **the ADR 331 debt** |
| 3b | A joiner presenting the *hub's own* node id is refused | the decision-2 hole |
| 3c | After a remote node row exists whose ULID sorts below ours, `insertMessage` still stamps OUR node and bumps OUR `next_seq` | **the decision-3 corruption** — fails on today's code |
| 3d | A joiner presenting the hub's node id **for a different team the hub hosts** is refused | miley's cross-team finding — 3b and 3d fail differently on the unpatched guard, so both stay |
| 4 | Rotation keeps `nodes.id`, so every `origin_node` stamp survives | ADR 328 §5 |
| 5 | A revoked node's credential is refused everywhere | ADR 328 §5 |
| 6 | Revocation leaves ingested events and held lanes alone | ADR 328 §5 |
| 7 | A `msnode_` cannot claim a seat, read as a member, or raise an act | ADR 328 §3 |
| 8 | The localhost-only routes still refuse a non-local peer | ADR 328 §6 |
| 9 | `node.json` is written 0600 and never lands in a workspace or the repo | ADR 328 §2 |
| 10 | Migration v48 is idempotent under rewind-and-replay | the v31 note |

Case 1 uses the interleaving harness `originStamp.test.ts` established for the same class of defect
— the 2026-08-01 double-claim shape, fourth instance.

**Acceptance: two real daemons.** Tests share a process; enrollment's whole point is that two do
not. A second daemon on a second port against a scratch DB, invited and joined for real, then
rotated and revoked. This is what settles **ADR 331's Experiment**, which predicts adoption is only
"write two fields onto an existing row" and names this increment as where the evidence arrives.
Decision 2 above already suggests the prediction was half wrong — on the hub it is an `INSERT`, not
an update of an existing row — and the run will say whether that counts as the "special-casing
beyond writing two fields" 331 named as its falsifier. The verdict gets recorded either way: in the
PR body, and as an amendment note on 331 if it went against the prediction.

## Documentation

- `docs/design/deployment-topology.md` §8 — ADR 325 §Consequences says its "what this is explicitly
  NOT" freeze unfreezes into a federation section "when the build starts". It has started.
- A wiki page on the enrollment ceremony once the two-daemon run has facts to report — a fact the
  team learned, per the repo's own rule, rather than a restatement of the ADRs.

## Out of scope

Sync wire format and push/pull routes (3b). Hub claim CAS and seat→node residence binding (3c).
Origin stamps on lanes, goals, and the audit log (their own slices, per ADR 331 §Decision 5). The
hub storage engine, which needs no decision.
