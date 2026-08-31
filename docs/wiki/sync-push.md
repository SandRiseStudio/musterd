# Sync push

What actually happens when an enrolled machine pushes its events to a hub, measured on two real daemons.

The decisions are [ADR 325](../decisions/325-multi-machine-federation.md) (the sync model),
[ADR 328](../decisions/328-machine-credential.md) (the credential admitting the surface) and
[ADR 331](../decisions/331-ordering-substrate.md) (the ordering substrate). This page is what
running increment 3b-i taught us. Enrollment itself is [node enrollment](node-enrollment.md).

## The run, end to end

Measured 2026-08-28 on two real daemons (ports 4901/4902, separate scratch DBs, separate
`MUSTERD_NODE_STATE` files, build `238a5be9`), team `bravo`. Three messages sent on the joiner
*before* it enrolled, then the 60s loop left to fire on its own:

```
sync_log:  m-joiner-1  origin_seq 1  hub_seq 1
           m-joiner-2  origin_seq 2  hub_seq 2
           m-joiner-3  origin_seq 3  hub_seq 3
sync_meta: next_hub_seq 4
joiner log: {"msg":"sync_pushed","team":"bravo","pushed":3}
```

All three carried the joiner's `origin_node`, not the hub's. Falsify: compare `SELECT DISTINCT
origin_node FROM sync_log` on the hub with `SELECT node_id FROM local_node` on the joiner — if the
hub's own node id appears, the pusher stamped events it did not originate.

## Events sent before enrollment still push

The three messages above were logged while the joiner was un-enrolled and pushed after it joined,
because `origin_seq` is stamped at insert (v47) and the cursor starts at 0. Enrollment admits a
machine; it does not draw a line under its history.

## The wire carries the seat name, never `from_member`

The staged payload for `m-joiner-1` was `{"envelope":{…,"from":"nick",…},"origin_node":…,
"origin_seq":1,"from_provenance":"session"}`. No `from_member` anywhere in it.

`messages.from_member` is a daemon-private anchor: on the receiver it would dangle, or — worse —
resolve to a *different* seat that happens to hold that id there. `from_provenance` travels because
it is an attested fact about the event (ADR 131 §4); `created_at` does not, because it is local
receipt time and shipping the origin's would assert a falsehood about when this machine learned of
the event. Falsify: `SELECT payload FROM sync_log` on the hub and grep for `from_member`.

## A replayed batch burns no `hub_seq`

Rewinding the joiner's `sync_push_cursor` to 0 — which is exactly what a lost ack looks like on the
next tick — resent all three events. The hub stayed at 3 rows, `hub_seq` stayed `1,2,3`, and
**`next_hub_seq` stayed 4**. The cursor then recovered to 3 on its own.

`next_hub_seq` is the load-bearing observation, not the row count. Idempotence that dropped the
replay *after* allocating would leave the row count right and the order full of holes. The skip
happens before allocation, so every number handed out is a number stored, and that is what makes the
order dense rather than merely unique. Falsify: replay a batch and read `next_hub_seq` before and
after; if it moved, the allocator is running ahead of the log.

## One node cannot wedge another with a chosen envelope id

Re-measured 2026-08-28 on fresh scratch DBs at `f6bc359d`, after the constraint was rescoped. A peer
node pre-stages the envelope id the joiner will use next; the joiner then sends and pushes it:

```
sync_log:  m-joiner-4  origin_node <joiner>    origin_seq 4  hub_seq 4
           m-joiner-4  origin_node peer-node   origin_seq 1  hub_seq 99
cursor: 4        sync_push_failed / sync_push_rejected in the joiner's log: 0
```

Both rows coexist, distinguished by origin. Before the fix (`57c27e1b`, global `id` PRIMARY KEY) the
joiner's push died on `UNIQUE constraint failed: sync_log.id`, the cursor correctly refused to move,
and the next tick resent into the same constraint — permanently, behind a warn line that reads as
being offline. Falsify: run the two-row insert above and assert both land; if the second throws, the
uniqueness scope is wider than the origin again.

**These numbers were re-gathered on databases created after the fix.** The earlier run on this page
was measured against the original v50, which still had the global PK. `runMigrations` skips any
version at or below the stored one and the body is `CREATE TABLE IF NOT EXISTS`, so a database
already stamped at 50 never sees the rescope — and `migrations:check` only verifies that versions
ascend, so nothing in CI can tell you (dolly, 2026-08-28). Mutating an unlanded migration is right;
re-creating every scratch DB that ran the old one is the part that is easy to forget.

## Revocation stops push at the door

`musterd node revoke <id>` on the hub, then a fourth message on the joiner. The next pass logged
`{"msg":"sync_push_failed","team":"bravo","error":"Error: hub responded 401"}`, the hub stayed at 3
staged rows, and the joiner's cursor **held at 3** — so the queued event is still queued and would
go if the machine were re-admitted. Falsify: revoke, send, wait one interval, and check
`sync_push_cursor.last_seq` on the joiner; if it advanced past a refused batch, the cursor is moving
on send rather than on ack, and every unreachable hub is silent loss.

## Nothing applies to `messages` — and that is the point

Through all of the above the hub's `messages` table stayed at **0 rows** and every
`nodes.next_seq` stayed at **1**. 3b-i stages and stops.

The fold into `messages` is a *second insert path* — the one ADR 331 §Consequences warned would
break gaplessness — so it is built once in 3b-ii, run by hub and puller alike, and reviewed as its
own slice. `packages/server/src/sync/containment.test.ts` was written before any ingest existed so
it could not be retrofitted to whatever the code turned out to do. Falsify: after a push pass,
`SELECT COUNT(*) FROM messages` and `SELECT next_seq FROM nodes` on the hub; either moving means the
slice boundary leaked.

## The CLI needs a binding-free directory to drive a scratch hub

`musterd node invite` run inside `/Users/nick/agents-*` resolved team `revive` from the workspace
binding and ignored the scratch config's `current` (2026-08-28). Bindings win over
`MUSTERD_CONFIG`'s current team, which is right for daily use and surprising when driving a test
hub. Run from the scratch directory and pass `--as <name>`, since a binding-free folder has no
active identity either. Falsify: run `musterd node invite` from a bound worktree with
`MUSTERD_CONFIG` pointing at a config whose `current` is a different team, and read which team the
request goes to.
