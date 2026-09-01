# Federation increment 3b-ii — pull, the fold into `messages`, read-side gap detection

- Date: 2026-09-01
- Lane: to be opened (musterd was unreachable while this was designed — see §Provenance)
- Branch: `stanley/federation-sync-fold`
- Author: stanley
- Status: design, awaiting nick's review

Build task under [ADR 325](../../decisions/325-multi-machine-federation.md), on the substrate
[ADR 331](../../decisions/331-ordering-substrate.md) laid, the credential
[ADR 328](../../decisions/328-machine-credential.md) minted (3a, `3b8415cf`), and the staging log
[ADR 335](../../decisions/335-sync-wire-format.md) defined (3b-i, `46707cb5`). The scope is the one
3b-i's own design fixed
([2026-08-28-sync-push-design.md](2026-08-28-sync-push-design.md) §"The slice"): *pull by cursor,
the fold into `messages`, gap detection on the read side — one path, run by hub and puller alike.*
No new ADR unless the build contradicts one.

## Why this is the next increment, not 3c

Lane `01M12FKHB0` (3c, hub claim CAS) declared one dependency, 3a, and it is the wrong one. A
hub-authoritative claim CAS needs the hub to *hold* lane state, and after 3b-i it holds none: pushed
events land in `sync_log` and stop (`deployment-topology.md` §"Not yet true"), and lanes carry no
origin stamp at all (ADR 331 §Decision 5 scoped it to `messages`). ADR 325 puts *opening* a lane in
the local-append set and only the *claim* in the hub-authoritative set, so lanes must reach the hub
before anything can arbitrate them. That is this increment plus a lane-replication slice. The other
half of 3c — the ADR 331 guarded-CAS refusal path — 3a already landed in `bindNode`
(`ON CONFLICT(id) DO NOTHING`, `changes === 0`).

## Two findings this design is shaped around

### 1. The hub's own traffic never reaches `sync_log`

`pushTeam` returns 0 unless the daemon is enrolled (`sync/push.ts`), and a hub never enrolls with
itself — 3a made the hub's `local_node` row permanently unbound precisely so a joiner could not bind
it. So `sync_log` holds every joiner's events and none of the hub's. `deployment-topology.md`
currently says a federated team has "one merged log on the hub — `sync_log`, in a single canonical
order across every origin"; that is true of joiner traffic only. It lands here because pull is the
first thing that depends on the log being complete: a puller walking `sync_log` by `hub_seq` would
replicate its peers and never see the hub.

The tempting fix — stage the hub's own message at `insertMessage` time when "this daemon is a hub"
— has a hole. That predicate flips when the first joiner enrolls, and every message written before
that moment was never staged; a puller would get the hub from enrollment onward and none of its
history. Fixing *that* needs a backfill at enrollment, a second mechanism doing what the push loop
already does. Rejected.

**Decided: the hub pushes to itself, in-process.** `pushTeam`, when this daemon is not enrolled
*but the team has enrolled joiners*, calls `ingestBatch(db, teamId, localNodeId, events)` directly
— the same function `POST /sync/push` calls, with no credential and no fetch. Everything else is
untouched: the push cursor starts at 0, so the hub's entire history streams into `sync_log` in
batches of `SYNC_PUSH_MAX_BATCH` over its first ticks — backfill for free, through the one path that
already does it gaplessly. `ingestBatch`'s origin check passes (v47 minted the hub's `nodes` row
with the right `team_id`); the 3a rule "a hub never enrolls with itself" is untouched (enrollment is
about credentials; this issues none); `insertMessage` does not change; single-machine installs pay
nothing because "has enrolled joiners" is false for them.

Consequence: a hub's `sync_log` now carries its own traffic. `containment.test.ts`'s claim — this
table never touches `messages` or `nodes.next_seq` — stays true. Any reading of "only foreign events
are staged" stops being true; nothing in 3b-i relies on it, and this sentence is where the change is
recorded.

### 2. `from_member` resolves by name at the fold, and the roster is on a different clock

`messages.from_member` is `NOT NULL REFERENCES members(id)`; the wire carries the seat **name**
(ADR 335 §1); the roster replicates through git (ADR 058), reconciled on pull. So the fold will
routinely meet an event from a seat this daemon's `members` does not know yet — every time a seat is
added on machine A and A pushes before B pulls git. Not an edge case.

**Decided: the fold blocks the cursor at the first event it cannot fully resolve.** Applied events
before it stay applied and the cursor stops exactly there; the next tick retries from that point.
Two alternatives rejected:

- *Skip and retry later.* Keeps the log flowing but applies out of `hub_seq` order, after which
  "everything up to N is applied" — the property the cursor exists to give — stops being answerable.
- *Materialize a placeholder member.* Never stalls, keeps order, and puts a second writer on
  `members`, which git owns; a placeholder outliving its reconciliation is a phantom seat on the
  roster. Out of proportion for this slice.

The stall is **bounded**: it lasts until the roster reconciles, which autorefresh drives on a
cadence. It is logged so the operator can tell "not yet pulled" from "removed upstream" (§Errors).

**`to` blocks too.** `to_member` is nullable, so "unknown recipient → NULL" is the easy move, and it
silently turns a directed ask into a broadcast. One rule for both names: the fold applies an event
only when it can resolve every seat it names.

Both findings interact in one way worth stating: because the hub folds too (joiner events into its
own `messages`), the hub's roster lag blocks the hub's fold exactly as a joiner's does. Same rule on
both sides — which is what "one implementation run by hub and puller alike" means in practice.

## Architecture — one fold, two feeders

```
joiner                                    hub
  messages ── push (HTTP) ───────────▶ sync_log ◀── loopback push (in-process ingestBatch) ── messages
  messages ◀── fold ◀── pull (HTTP, hub_seq cursor)      sync_log ── fold ──▶ messages
```

Three units, one job each:

- **`sync/fold.ts`** — `foldBatch(db, teamId, events)`: the only code that writes a foreign-origin
  row into `messages`. Pure store logic, no I/O. Takes `SyncEvent`s each paired with its `hub_seq`;
  returns how far it got and why it stopped.
- **`sync/pull.ts`** — the joiner's loop, on the push loop's 60 s cadence: `GET
  /teams/:slug/sync/pull?after=<hub_seq>`, feeding `foldBatch`. Cursor is a local-only table,
  advanced *inside* the fold's transaction (ADR 325: "cursor advanced in the same transaction as the
  applied batch").
- **The hub's feeder is not a new unit**: the same loop reads its own `sync_log` instead of
  fetching, and `pushTeam` gains the loopback branch from §Finding 1.

### The wire, pull side

```ts
// GET /teams/:slug/sync/pull?after=<hub_seq>&limit=<n>   — authenticated by msnode_ (ADR 328 §3)
export const SyncPullResponseSchema = z.object({
  events: z.array(SyncEventSchema.extend({ hub_seq: z.number().int().positive() })),
  hub_seq_high: z.number().int().nonnegative(),
});
```

`SyncEvent` is reused verbatim; `hub_seq` rides beside it because the puller's cursor is a
`hub_seq`. `limit` is capped at `SYNC_PUSH_MAX_BATCH` for the reason push bounded its batch. The
route refuses `after > hubHead` with `409 { hub_seq_high }`, mirroring push's `expected_seq`, under
the same downward-only trust (ADR 335 §"expected_seq is refused above this node's own head"): a
puller believes a *lower* resume point and refuses one above its own last applied `hub_seq`.

### The fold's rule, per event, in `hub_seq` order, inside one transaction per batch

1. **`origin_node == local_node`** → skip. Already in `messages` via `insertMessage`; on the hub
   this is its own traffic coming back through loopback, on a joiner its own events reflected. Not
   an error.
2. **`(origin_node, origin_seq)` already in `messages`** → skip. A replay after a lost cursor write.
   This is the idempotence key, *not* `messages.id` — see rule 5.
3. **Resolve `envelope.from` and `envelope.to`** by name in `members` for this team. Either missing →
   **stop here**: commit everything applied so far, set the cursor to the last applied `hub_seq`,
   return the blocker.
4. **Insert into `messages`** with the wire's `origin_node`/`origin_seq` verbatim, `from_provenance`
   from the wire, `created_at = now` (local receipt time — ADR 335 §1's reason it does not travel),
   `from_member`/`to_member` the ids resolved in 3. **`nodes.next_seq` is never read or written.**
   That is the ADR 331 §Consequences hazard in one sentence, and the first test in
   `fold.test.ts` is its falsifier.
5. **`messages.id` already present with a *different* `(origin_node, origin_seq)`** → stop,
   terminal. ADR 335 scoped `sync_log`'s envelope-id uniqueness to the origin and named this as
   3b-ii's call: two rows in one team may share an id, and `messages.id` is a primary key, so the
   fold cannot write both. Honest origins mint ULIDs (80 bits of entropy); a real collision is
   corruption or an attack, and dropping either row silently is loss. Same terminal class as
   `SyncDuplicateIdError`.

Rule 3's shape is the subtle one. "Block the cursor" means the cursor stops *at* the blocker, not that
the batch is all-or-nothing: all-or-nothing re-walks the same applied prefix every tick forever,
while stopping at the blocker makes the retry cheap and the stall precisely locatable.

### Schema, migration v52

```sql
-- The fold's idempotence key. v47 added the columns; nothing yet enforces the pair's uniqueness in
-- messages because insertMessage was the only writer and it allocates gaplessly. A second writer
-- needs the schema to hold the invariant, not the code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_origin ON messages(origin_node, origin_seq);

-- Local-only (ADR 325 residence 3), same reasoning as sync_push_cursor. One row per team: the
-- cursor is over the team's canonical order, and a daemon is a puller for a team or it is not.
CREATE TABLE IF NOT EXISTS sync_pull_cursor (
  team_id       TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  last_hub_seq  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

The hub uses the same cursor table for its own fold — its "source" is local `sync_log`, but the
cursor's meaning (last `hub_seq` applied to `messages`) is identical.

## Errors and refusals

Three distinct things stop the fold, and they must not share a log line — the push side learned
this the hard way (`sync_push_failed` was one line for "on a train" and for silent loss, ADR 335 §7).

| Stop | Level | Retry | Line names |
| --- | --- | --- | --- |
| Unresolvable seat (`from` or `to`) | **error**, once per distinct seat name, not per tick | every tick; clears when the roster reconciles | seat, `hub_seq`, hypothesis: "roster not yet reconciled from git, or seat removed upstream" |
| Read-side gap — an origin's events do not continue what this daemon holds (`MAX(origin_seq)` for that origin in local `messages`, +1) | **error** | none — terminal | origin, expected, got |
| Envelope-id collision across origins (rule 5) | **error** | none — terminal | id, both origins |
| Unknown act — `messages.act` CHECK fails because the origin runs a newer build | **error** | every tick; clears on upgrade | act, `hub_seq`, "upgrade this daemon" |

The read-side gap deserves its own sentence. It cannot happen if the hub ingests gaplessly and the
puller walks `hub_seq` in order — which is exactly why it is a check and not a recovery: it is the
falsifier for the hub's own invariant, seen from the other end. The cursor does not advance and no
retry can clear it; it is the same terminal class as `SyncDuplicateIdError`, and for the same reason
it must be *named* rather than surface as a bare constraint error the loop retries behind a warn.

Unknown act is not a bug in either daemon; it is the wire outrunning a reader. Blocking is the only
honest answer: skipping would drop an event a peer considers sent.

Offline (hub unreachable) stays what push made it: **warn**, expected, retry next tick.

## Testing

Following 3b-i's precedent that the containment test was written before the code it constrains:

- **`sync/fold.test.ts`** — the ADR 331 falsifier first: fold N foreign events and assert the local
  node's `nodes.next_seq` is **unchanged** and its own sequence has no hole. Then, one case each:
  skip own origin; idempotent replay on `(origin_node, origin_seq)`; block at an unresolvable `from`
  with the prefix applied and the cursor at the blocker; the same for `to`; cursor advances in the
  same transaction (force a throw after the insert, assert the cursor did not move); unknown act
  blocks; id collision across origins is terminal; read-side gap is terminal.
- **`sync/pull.test.ts`** — two-daemon through-DB test in `push.test.ts`'s shape: joiner A pushes,
  hub folds, joiner B pulls and folds; B's `messages` holds A's events with A's origin stamp
  verbatim and B-local `from_member`. Plus loopback: the hub's own history lands in `sync_log` with
  dense `hub_seq`, and B receives it. Plus the `409` above-head refusal and the puller's refusal of a
  resume point above its own cursor.
- **`sync/containment.test.ts` stays and passes.** Its assertion narrows from "nothing writes
  `messages` but `insertMessage`" to "nothing writes `messages` but `insertMessage` and `foldBatch`,
  and only `insertMessage` moves `next_seq`." That narrowing is the one line of the diff a reviewer
  should read most carefully.

**Acceptance: two real daemons.** Hub and joiner enrolled through 3a's ceremony; a message sent on
the joiner appears in the hub's `messages` with the joiner's origin stamp; a message sent on the hub
appears in the joiner's; a seat added on one side and not yet pulled on the other blocks the other's
fold with the named error line, and the fold resumes on its own after the git pull.

## Out of scope

Origin stamps on lanes, goals and audit (their own slices, ADR 331 §Decision 5), and everything 3c
(hub claim CAS, seat→node residence) — which this increment unblocks and does not start.
`inbox_cursors` and `tool_call_stats` (ADR 325's direct-merge exceptions) remain untouched.

## Provenance

Designed in conversation with nick, 2026-09-01, while the musterd MCP server was down (ryder on the
lease fix). Two decisions were taken and then re-examined at nick's prompting: self-staging at
`insertMessage` was replaced by the in-process loopback (§Finding 1), and block-the-cursor was kept
but extended to `to` (§Finding 2). Lane bookkeeping — releasing 3c, opening this increment's lane —
is owed the moment musterd is reachable again.
