# Node enrollment

How a second machine gets admitted to a musterd team, and what the ceremony actually does when you run it.

Decisions live in [ADR 328](../decisions/328-machine-credential.md) (the credential) and
[ADR 331](../decisions/331-ordering-substrate.md) (the id it binds). This page is what running it
taught us.

## The ceremony, end to end

Measured 2026-08-27 on two real daemons (ports 4901/4902, separate scratch DBs, build `88d6d31e`),
team `acc`:

1. **Hub:** `musterd node invite --label "joiner laptop"` → `msinv_…`, single use, 15 minutes.
2. **Joiner:** `musterd node join http://127.0.0.1:4901 msinv_…` → `✓ this machine is enrolled`.
3. **Hub:** `musterd node list` shows the joiner `enrolled` and the hub's own row `local`.

The joiner's `~/.musterd/node.json` came out mode `-rw-------` holding `{hub_url, node_id,
credential, enrolled_at}` for that team. Falsify: `stat -f %Sp node.json` after a join; anything but
`-rw-------` breaks ADR 328 §2.

## The id is the joiner's, not the hub's

The joiner presented `01M12QH1KG0FQ9ZCH935M1K0NE` — minted by migration v47 on its own daemon,
before any credential existed — and the hub bound exactly that id. Rotation left it unchanged.

This is ADR 331 §Decision 1 working: the joiner allocates the identifier, the hub vouches for it. It
is why enrollment does not have to restamp history — every event the joiner already logged names the
same origin it will keep. Falsify: compare `SELECT node_id FROM local_node` on the joiner before the
join with `SELECT id FROM nodes WHERE credential_hash IS NOT NULL` on the hub after; if they differ,
the hub minted a fresh identity and the pre-enrollment log is orphaned.

## On the hub, adoption is an INSERT — not an UPDATE

ADR 331's Experiment predicted "write two fields onto an existing row". On the **hub** there is no
existing row: the hub's own row for that team has a different id, so the presented one is new there.
The bind is `INSERT … ON CONFLICT(id) DO UPDATE … WHERE credential_hash IS NULL`.

One statement, so the prediction holds in substance — but the wording was wrong, and 331
§Consequences now records that (2026-08-27). Falsify: on a hub that has never seen a joiner,
`SELECT COUNT(*) FROM nodes` is 1 before the join and 2 after; an UPDATE-shaped adoption would leave
it at 1.

## The trap: a bind guard that enumerates what it excludes

A hub never enrolls with itself, so its own `local_node` row is unbound **permanently**. A guard of
`WHERE credential_hash IS NULL` alone therefore lets a joiner bind its credential to the *hub's*
origin identity — after which it stamps events as the hub, and every `origin_node` in the log is
ambiguous between two machines.

The obvious patch — also exclude this team's `local_node` id — **is still wrong, and that is the
lesson** (miley review 2026-08-27, `01M12KQHT8`). On a hub hosting teams A and B, a joiner enrolling
into A presents the id of the hub's local row for **B**: A's exclusion does not name it, B's row is
unbound, and the upsert writes a foreign credential onto B's origin identity while leaving `team_id`
as B. It reports success, and the joiner can then authenticate as team B's node.

Neither is reachable by an outsider (the invite is admin-minted, single-use, 15 minutes) — both are
reachable by the *invitee*, which is the party a CAS exists to bound.

Both drafts are an instance of [the boundary-injection trap](boundary-injection.md)'s sibling failure:
the guard was written against the cases its author could enumerate, and each new case looked like the
last one patched. The shipped guard is `ON CONFLICT(id) DO NOTHING`: a legitimate joiner's id is fresh to the hub by
construction, so **any** id the hub already knows is a refusal. Falsify: on a hub hosting two teams,
`musterd node list` each, take either row shown `local`, and try to join presenting that id; a 409
means the guard holds, a 200 means it does not (`store/nodes.bind.test.ts` cases 3b and 3d — they
fail differently on the team-scoped guard, which is why both are kept).

## A refused bind must not spend the invite

better-sqlite3 **commits** a transaction whose function returns normally — only a throw rolls back.
Consume-then-bind returning `null` on refusal therefore left the code consumed and nobody enrolled
(2026-08-27, caught in test before merge; falsify: enroll onto a taken node id with a fresh code,
then retry that same code against a free id — a 409 means the invite survived, a second 409 means it
was burned). The refusal now throws a sentinel so the consumption rolls back with the bind.

This is the general shape, not a quirk of this route: **any `db.transaction` in this codebase that
signals failure by returning a value commits that failure.**

## What enrollment does not do

- **It does not sync anything.** Increment 3a mints and retires machine identities. Push, pull, and
  hub-arbitrated claims are 3b and 3c. Two enrolled machines still have two separate logs.
- **An `msnode_` is not a seat credential** (ADR 328 §3). Measured: a bearer token that authenticates
  as a node gets 401 on `POST /teams/:slug/messages` and on the inbox. Falsify: those routes
  returning anything but 401 for an `msnode_`.
- **Revocation keeps history.** After `musterd node revoke`, the node row stays, events it stamped
  stay, and the audit log holds `node.invited → node.enrolled → node.rotated → node.revoked`. Lanes
  its seats hold are **not** released — that stays a human act.

## Rough edges (2026-08-27, increment 3a as shipped)

- **`rotate` gives you a credential with no way to deliver it** (2026-08-27). Enrollment hands the
  joiner its secret over the wire; rotation prints the new one on the *hub* and leaves the operator
  to carry it to the machine by hand. Falsify: a `node rotate` path that updates the joiner's `node.json`
  without a human copying a string. Worth solving in 3b, when the joiner has a live channel to the
  hub.
- **The admin's `--label` is not what the node is called.** `node invite --label "joiner laptop"`
  records that label on the *invite*; the node row takes the joining daemon's `hostname()`. Both
  daemons in the acceptance run were the same machine, so both rows read `mac.lan`. Not wrong — a
  machine naming itself is the more trustworthy of the two — but the operator's label is silently
  dropped (2026-08-27), so `node list` cannot be matched against the invites you sent. Falsify:
  `musterd node invite --label X` then join, and read `label` on the resulting `nodes` row.

## When a push wedges

Since [ADR 360](../decisions/360-push-level-residence.md) (2026-09-02) the hub refuses a joiner's
whole push batch when any event in it speaks as a seat bound to another node — and every event
minted after it queues behind. The failure is loud in the daemon log (`sync_push_refused_residence`
at ERROR, every tick) and, since the same day, loud where the seat actually is:

- **The roster carries it.** `GET /teams/:slug/members` gains `sync.wedged` on the refused machine
  (`null` elsewhere), so `team_status`, `team_inbox_check` and `musterd status` print one line naming
  the seat, the node it is bound to, the event kind, how long, and the remedy. `musterd node list`
  prints the same line above the nodes.
- **The remedy is one of two acts.** From a session on the machine the seat lives on:
  `musterd node trust <wedged node id>` (ADR 358, human seats only). Or an admin:
  `musterd node unbind <seat>`, after which the next act as that seat binds it wherever it happens.
- **It clears itself.** The next accepted push nulls the record; nothing to reset by hand.

The first-seen clock survives repeats: a refusal every 60 s keeps the original `since`. Falsify:
`SELECT refused_json FROM sync_push_cursor` on the joiner after two refused ticks — `since` must
match the first, not the second (`sync/push.test.ts`, "keeps its first-seen clock"). And a wedge
on the HUB's own roster would be a defect — its loopback push is never refused (ADR 360 §2);
falsify: `sync.wedged` non-null on a daemon with no `node.json` entry for the team.

## Which machine is the hub (2026-09-03, ADR 376)

The one the team was created on — the daemon holding the creator's admin credential mints the
first invite, and every other machine joins it. Two doors enforce it: `musterd node invite` on an
enrolled joiner refuses and names the hub to run it from; `musterd node join` on a machine that
already has enrolled joiners refuses before any request leaves it.

Before the refusals a joiner could mint an invite and a third machine could join *it*. Everything
that third machine pushed was then folded by nobody (2026-09-03 at `17706ff9`; falsify:
`node-enroll-http.test.ts` "ADR 376") — it sat in the joiner's `sync_log`, and a joiner's pull
loop never reads its own staging.

Moving the hub (laptop → always-on VM) is not built; ADR 376 §4 names what it would take.
