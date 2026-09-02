# Presence Replication Implementation Plan

> **For agentic workers:** This repo uses musterd, not subagents (see `~/.claude/CLAUDE.md`). Execute
> inline in your own seat with superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `presence.*` transitions become the third replicated kind, so every machine's roster shows
every seat on every machine and the hub's displacement rule sees remote seats.

**Architecture:** Three audit verbs (`presence.attached|detached|reattested`) are appended inside
the transaction that changes a `presence` row, stamped from the node allocator like `lane.*`. They
ride the existing push/pull wire under a `kind: 'presence'` tag and the fold projects them into
`presence` with a new `node` column. A remote row is live while its node's `nodes.last_seen_at`
(stamped by the hub on every sync contact, handed back on the pull) is within one named TTL.

**Tech Stack:** TypeScript, better-sqlite3, zod, vitest. pnpm is at `/Users/nick/Library/pnpm/pnpm`
(not on the harness PATH).

**Spec:** `docs/superpowers/specs/2026-09-02-presence-replication-design.md`

## Global Constraints

- Migration number is **v60**; re-check `git log origin/main -- packages/server/src/db/migrations.ts`
  and open PRs before merge and renumber upward if anything landed (high-water-mark rule, #1174).
- Feature epoch becomes **18** (`packages/protocol/src/feature-epoch.ts`).
- ADR number **356**; `pnpm adr-numbers:check` must pass.
- `nodes.next_seq` is never read or written by the fold. Foreign node rows are upserted with
  `id, team_id, label, last_seen_at` only.
- A node emits `presence.*` rows only for rows with `node IS NULL`.
- `wake_lease` never travels; folded rows carry `wake_lease = NULL`.
- `REMOTE_PRESENCE_TTL_MS = PRESENCE_TIMEOUT_MS + 2 * SYNC_PUSH_INTERVAL_MS` (165 000).
- Run the full gate before the PR: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`.
- Commit messages end with the session trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016ayNzjnbBviSCXSa8etpJu
  ```

---

## File map

| File | Responsibility after this plan |
| --- | --- |
| `packages/server/src/db/migrations.ts` | v60: `presence.node` + index |
| `packages/server/src/store/audit.ts` | `appendReplicatedEvent` (generalised from `appendLaneEventRequired`), `presence.*` in `AuditAction` |
| `packages/server/src/store/presence.ts` | emits the three verbs; `node` on rows; one liveness predicate (`LIVE_PRESENCE_SQL`) used by every reader; reaper scoped to local rows plus stale-remote sweep |
| `packages/server/src/store/nodes.ts` | `touchNode`, `upsertForeignNode`, `listNodeLiveness` |
| `packages/server/src/config.ts` | `REMOTE_PRESENCE_TTL_MS` |
| `packages/protocol/src/sync.ts` | `SyncPresenceEventSchema`, three-way union, `nodes` on the pull response |
| `packages/protocol/src/member.ts` | `node`, `node_label` on `PresenceSchema` |
| `packages/protocol/src/feature-epoch.ts` | epoch 18 |
| `packages/server/src/sync/push.ts` | tags `presence.*` rows as `kind: 'presence'` |
| `packages/server/src/sync/fold.ts` | `projectPresenceEvent`, two new stops |
| `packages/server/src/sync/pull.ts` | folds the `nodes` summary; reports the new stops (and the two lane stops it never reported) |
| `packages/server/src/transport/http.ts` | `touchNode` on the three sync routes; pull response carries `nodes` |
| `packages/server/src/sync/claim.ts` | comment only |
| `packages/cli/src/render/rows.ts` | node label facet |
| `packages/web/src/live/RosterPanel.tsx` | node label in the posture chip title |
| `packages/server/src/sync/presence.test.ts` | the two-daemon falsifier |
| `docs/decisions/356-presence-replication.md`, `docs/design/deployment-topology.md`, `docs/decisions/325-multi-machine-federation.md` | the record |

---

### Task 1: Migration v60 and the `node` column

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (append after v58, ~line 1448)
- Modify: `packages/server/src/store/rows.ts:72-100` (`PresenceRow`)
- Test: `packages/server/src/db/migrations.test.ts` (find the existing "applies to the latest version" style case; add one)

**Interfaces:**
- Produces: `PresenceRow.node: string | null`; column `presence.node`.

- [ ] **Step 1: Write the failing test**

Append to the migrations test file's top-level `describe`:

```ts
it('v60 adds presence.node (null = local) with an index', () => {
  const db = openDb(':memory:');
  const cols = db.prepare<[], { name: string }>('PRAGMA table_info(presence)').all().map((c) => c.name);
  expect(cols).toContain('node');
  const idx = db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'presence'")
    .all()
    .map((i) => i.name);
  expect(idx).toContain('idx_presence_node');
});
```

- [ ] **Step 2: Run it**

Run: `/Users/nick/Library/pnpm/pnpm vitest run packages/server/src/db/migrations.test.ts -t v60`
Expected: FAIL, `node` not in columns.

- [ ] **Step 3: Add the migration**

After the v58 entry:

```ts
  {
    // Presence replication (spec 2026-09-02): a presence row folded from another machine carries
    // the `nodes.id` it lives on; NULL is a local row (a socket or an ambient touch animates it).
    // Every reader's liveness predicate branches on this column (store/presence.ts LIVE_PRESENCE_SQL),
    // and the reaper's heartbeat cutoff applies to local rows only.
    version: 60,
    up: (db) => {
      const cols = db
        .prepare<[], { name: string }>('PRAGMA table_info(presence)')
        .all()
        .map((c) => c.name);
      if (!cols.includes('node')) db.exec('ALTER TABLE presence ADD COLUMN node TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_presence_node ON presence(node)');
    },
  },
```

Add to `PresenceRow` in `rows.ts`, after `wake_lease`:

```ts
  /** The `nodes.id` this row was folded from (presence replication, 2026-09-02); NULL = local. */
  node: string | null;
```

Every literal `PresenceRow` construction (`attach` in `presence.ts`) must now set `node: null`; the
INSERT in `attach` adds the column. Do that in `attach` now:

```ts
    node: null,
```
and the SQL:
```sql
INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, held_until, provenance, workspace, driver, model, model_source, build, epoch, wake_lease, node, created_at)
VALUES (@id, @member_id, @surface, @status, @conn_id, @last_seen_at, @held_until, @provenance, @workspace, @driver, @model, @model_source, @build, @epoch, @wake_lease, @node, @created_at)
```

- [ ] **Step 4: Run migrations + store tests**

Run: `/Users/nick/Library/pnpm/pnpm vitest run packages/server/src/db packages/server/src/store/store.test.ts`
Expected: PASS. Also run `pnpm migrations:check`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/migrations.ts packages/server/src/db/migrations.test.ts packages/server/src/store/rows.ts packages/server/src/store/presence.ts
git commit -m "feat(server): migration v60 — presence.node, the machine a folded presence row lives on"
```

---

### Task 2: `appendReplicatedEvent` and the `presence.*` verbs in the audit vocabulary

**Files:**
- Modify: `packages/server/src/store/audit.ts:391-419` (`appendLaneEventRequired`) and the `AuditAction` union (~line 47)
- Test: `packages/server/src/store/audit.test.ts` (exists; add one case)

**Interfaces:**
- Produces: `appendReplicatedEvent(db, teamId, entry: AuditEntry): void` — identical body to
  `appendLaneEventRequired`. `appendLaneEventRequired` becomes `export const appendLaneEventRequired = appendReplicatedEvent;` so no caller moves.
- Produces: `AuditAction` gains `'presence.attached' | 'presence.detached' | 'presence.reattested'`.

- [ ] **Step 1: Failing test**

```ts
it('appendReplicatedEvent stamps a presence.* row from the node allocator, densely with lane rows', () => {
  const { db, team } = freshTeam(); // reuse the file's helper
  appendReplicatedEvent(db, team.id, { actor: 'ada', action: 'presence.attached', target: 'ada', result: 'allow', detail: { presence: 'p1' } });
  appendLaneEventRequired(db, team.id, { actor: 'ada', action: 'lane.opened', target: 'l1', result: 'allow', detail: { lane: 'l1' } });
  const seqs = db.prepare<[], { origin_seq: number; action: string }>('SELECT origin_seq, action FROM audit WHERE origin_seq > 0 ORDER BY origin_seq').all();
  expect(seqs.map((r) => r.origin_seq)).toEqual([1, 2]);
  expect(seqs[0]!.action).toBe('presence.attached');
});
```

- [ ] **Step 2: Run** — expected FAIL (`appendReplicatedEvent` is not exported).

- [ ] **Step 3: Implement**

Rename the function to `appendReplicatedEvent`, update its doc comment to say "any replicated kind:
`lane.*` and `presence.*`", and add below it:

```ts
/** `lane.*` writers keep their name; the allocator and the SAVEPOINT are the same. */
export const appendLaneEventRequired = appendReplicatedEvent;
```

Add to `AuditAction`, after `'occupancy.model_attested'`:

```ts
  // Presence replication (spec 2026-09-02): the three session transitions, stamped and replicated.
  // `detail.presence` is the presence row's ULID — the key every reader joins on. Heartbeats never
  // write here. A node emits these for rows it wrote (`presence.node IS NULL`) and for no other.
  | 'presence.attached'
  | 'presence.detached'
  | 'presence.reattested'
```

- [ ] **Step 4: Run** `pnpm vitest run packages/server/src/store/audit.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(server): appendReplicatedEvent — one stamped append for lane.* and presence.*`

---

### Task 3: Emit the three verbs from `store/presence.ts`

**Files:**
- Modify: `packages/server/src/store/presence.ts` (`attach`, `detach`, `reapStale`, `clearPresenceById`, `clearMemberPresence`, `clearOrphanPresence`, `touchAmbientPresence`, `reattestModel`, `reattestSurface`)
- Test: `packages/server/src/store/store.test.ts` (`describe('presence')`)

**Interfaces:**
- Consumes: `appendReplicatedEvent` (Task 2).
- Produces: audit rows per the spec §1 table. No signature changes.

- [ ] **Step 1: Failing tests** (add inside `describe('presence')`):

```ts
it('presence transitions are stamped audit rows: attach, reattest, detach — and a heartbeat is not', () => {
  const { db, team } = freshTeam();
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
  const row = attach(db, ada.row.id, 'claude-code', 'c1', { model: 'claude-opus-5', model_source: 'observed', workspace: '~/x', driver: 'nick' });
  heartbeat(db, row.id);
  reattestModel(db, row.id, 'claude-sonnet-5', 'observed');
  detach(db, row.id);
  const rows = db
    .prepare<[], { action: string; actor: string; detail: string; origin_seq: number }>(
      "SELECT action, actor, detail, origin_seq FROM audit WHERE action LIKE 'presence.%' ORDER BY origin_seq",
    )
    .all();
  expect(rows.map((r) => r.action)).toEqual(['presence.attached', 'presence.reattested', 'presence.detached']);
  expect(rows.every((r) => r.actor === 'Ada' && r.origin_seq > 0)).toBe(true);
  expect(JSON.parse(rows[0]!.detail)).toMatchObject({ presence: row.id, surface: 'claude-code', model: 'claude-opus-5', model_source: 'observed', workspace: '~/x', driver: 'nick' });
  expect(JSON.parse(rows[0]!.detail)).not.toHaveProperty('wake_lease');
  expect(JSON.parse(rows[1]!.detail)).toMatchObject({ presence: row.id, model: 'claude-sonnet-5', model_source: 'observed', surface: 'claude-code' });
  expect(JSON.parse(rows[2]!.detail)).toEqual({ presence: row.id, reason: 'goodbye' });
});

it('every removal path names its reason; release into grace is not a detach; reap of the grace is', () => {
  const { db, team } = freshTeam();
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
  const a = attach(db, ada.row.id, 'claude-code', 'c1');
  release(db, a.id, 0);
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.detached'").get()).toEqual({ n: 0 });
  reapStale(db, 45_000); // held_until already passed
  const b = attach(db, ada.row.id, 'claude-code', 'c2');
  clearPresenceById(db, b.id);
  const c = attach(db, ada.row.id, 'claude-code', 'c3');
  clearMemberPresence(db, ada.row.id);
  const reasons = db.prepare<[], { detail: string }>("SELECT detail FROM audit WHERE action = 'presence.detached' ORDER BY origin_seq").all().map((r) => JSON.parse(r.detail).reason);
  expect(reasons).toEqual(['reaped', 'displaced', 'cleared']);
});

it('an ambient touch emits attached when it creates a row and nothing when it refreshes one', () => {
  const { db, team } = freshTeam();
  const cy = addMember(db, team, { name: 'Cy', kind: 'agent' });
  touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
  touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.attached'").get()).toEqual({ n: 1 });
});

it('a remote row is never the subject of a locally emitted transition', () => {
  const { db, team } = freshTeam();
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
  db.prepare("INSERT INTO nodes (id, team_id, label, next_seq, last_seen_at) VALUES ('nB', ?, 'B', 1, 0)").run(team.id);
  db.prepare(
    "INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, created_at, node) VALUES ('rB', ?, 'codex', 'online', NULL, 1, 1, 'nB')",
  ).run(ada.row.id);
  clearMemberPresence(db, ada.row.id);
  reapStale(db, 45_000);
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.detached'").get()).toEqual({ n: 0 });
  // The stale-node sweep removed it silently.
  expect(db.prepare("SELECT COUNT(*) AS n FROM presence WHERE id = 'rB'").get()).toEqual({ n: 0 });
});
```

`heartbeat`, `release`, `detach`, `clearPresenceById`, `clearMemberPresence` need importing in the test file if not already.

- [ ] **Step 2: Run** `pnpm vitest run packages/server/src/store/store.test.ts -t "presence transitions|removal path|ambient touch emits|remote row is never"` — FAIL.

- [ ] **Step 3: Implement**

At the top of `presence.ts`:

```ts
import { appendReplicatedEvent } from './audit.js';
import { REMOTE_PRESENCE_TTL_MS } from '../config.js';
```

(`REMOTE_PRESENCE_TTL_MS` is added in Task 4; add the constant to `config.ts` now if you do this task first:
`export const REMOTE_PRESENCE_TTL_MS = PRESENCE_TIMEOUT_MS + 2 * 60_000;` with the comment from Task 4.)

Two private helpers:

```ts
/** The seat and team behind a member id — every transition names the seat, never the private id. */
function seatOf(db: Database, memberId: string): { team_id: string; name: string } | undefined {
  return db
    .prepare<[string], { team_id: string; name: string }>('SELECT team_id, name FROM members WHERE id = ?')
    .get(memberId);
}

type DetachReason = 'goodbye' | 'reaped' | 'displaced' | 'cleared';

/** Emit `presence.detached` for LOCAL rows only, then delete them. `where` selects the rows. */
function detachLocalRows(db: Database, where: string, params: unknown[], reason: DetachReason): void {
  const rows = db
    .prepare<unknown[], { id: string; member_id: string }>(
      `SELECT id, member_id FROM presence WHERE node IS NULL AND ${where}`,
    )
    .all(...params);
  for (const r of rows) {
    const seat = seatOf(db, r.member_id);
    if (seat) {
      appendReplicatedEvent(db, seat.team_id, {
        actor: seat.name,
        action: 'presence.detached',
        target: seat.name,
        result: 'allow',
        detail: { presence: r.id, reason },
      });
    }
    db.prepare('DELETE FROM presence WHERE id = ?').run(r.id);
  }
}
```

`attach`: after the INSERT, before `return row`:

```ts
  const seat = seatOf(db, memberId);
  if (seat) {
    appendReplicatedEvent(db, seat.team_id, {
      actor: seat.name,
      action: 'presence.attached',
      target: seat.name,
      result: 'allow',
      detail: {
        presence: row.id,
        surface,
        provenance: row.provenance,
        workspace: row.workspace,
        driver: row.driver,
        model: row.model,
        model_source: row.model_source,
        build: row.build,
        epoch: row.epoch,
      },
    });
  }
```

Wrap the whole body of `attach` in `db.transaction(() => { ... })()` so the row and its event are one unit.

`touchAmbientPresence`: the `else { attach(...) }` branch already goes through `attach`, so it emits; the `if (existing)` branch emits nothing. No change beyond confirming this.

Replace the bodies:

```ts
export function clearMemberPresence(db: Database, memberId: string): void {
  detachLocalRows(db, 'member_id = ?', [memberId], 'cleared');
}
export function clearPresenceById(db: Database, presenceId: string): void {
  detachLocalRows(db, 'id = ?', [presenceId], 'displaced');
}
export function clearOrphanPresence(db: Database, memberId: string): void {
  detachLocalRows(db, 'member_id = ? AND conn_id IS NULL', [memberId], 'cleared');
}
export function detach(db: Database, presenceId: string): void {
  detachLocalRows(db, 'id = ?', [presenceId], 'goodbye');
}
```

`reapStale`:

```ts
export function reapStale(db: Database, timeoutMs: number): PresenceRow[] {
  const now = Date.now();
  const cutoff = now - timeoutMs;
  return db.transaction(() => {
    const stale = db
      .prepare<[number, number], PresenceRow>(
        'SELECT * FROM presence WHERE node IS NULL AND (last_seen_at <= ? OR (held_until IS NOT NULL AND held_until <= ?))',
      )
      .all(cutoff, now);
    detachLocalRows(db, 'last_seen_at <= ? OR (held_until IS NOT NULL AND held_until <= ?)', [cutoff, now], 'reaped');
    // Remote rows whose node has gone quiet: removed silently — this machine did not end that
    // session and must not say it did (spec §1). The origin's own `detached`, if it ever arrives,
    // deletes nothing and advances the cursor.
    const remoteCutoff = now - REMOTE_PRESENCE_TTL_MS;
    db.prepare(
      `DELETE FROM presence WHERE node IS NOT NULL AND id IN (
         SELECT p.id FROM presence p LEFT JOIN nodes n ON n.id = p.node
          WHERE p.node IS NOT NULL AND (n.last_seen_at IS NULL OR n.last_seen_at <= ?))`,
    ).run(remoteCutoff);
    return stale;
  })();
}
```

`reattestModel` and `reattestSurface`: after their UPDATE, read the row again and emit:

```ts
  const after = presenceById(db, presenceId)!;
  if (after.node === null) {
    const seat = seatOf(db, after.member_id);
    if (seat) {
      appendReplicatedEvent(db, seat.team_id, {
        actor: seat.name,
        action: 'presence.reattested',
        target: seat.name,
        result: 'allow',
        detail: { presence: presenceId, model: after.model, model_source: after.model_source, surface: after.surface },
      });
    }
  }
```

Both functions already return early when nothing changed, so no duplicate rows.

- [ ] **Step 4: Run the whole store suite and the reaper/ws/http suites**

Run: `pnpm vitest run packages/server/src/store packages/server/src/presence packages/server/src/transport`
Expected: PASS. If a transport test counts audit rows by `SELECT COUNT(*) FROM audit`, scope it with `WHERE action NOT LIKE 'presence.%'` and note it in the commit.

- [ ] **Step 5: Commit** `feat(server): presence.attached/detached/reattested — the session transitions, stamped where the row changes`

---

### Task 4: One liveness predicate, node-aware, for every reader

**Files:**
- Modify: `packages/server/src/config.ts` (after `PRESENCE_TIMEOUT_MS`)
- Modify: `packages/server/src/store/presence.ts` (`hasLivePresence`, `listPresence`, `listLiveDrivers`, `countLivePresences`, `PresenceSummary`)
- Modify: `packages/server/src/store/nodes.ts` (add `touchNode`, `upsertForeignNode`, `listNodeLiveness`)
- Test: `packages/server/src/store/store.test.ts`, `packages/server/src/store/nodes.test.ts`

**Interfaces:**
- Produces: `REMOTE_PRESENCE_TTL_MS: number` in `config.ts`.
- Produces: `PresenceSummary.presences[i].node: string | null`, `.node_label: string | null`.
- Produces in `nodes.ts`:
  - `touchNode(db, nodeId: string, now: number): void` — `UPDATE nodes SET last_seen_at = ? WHERE id = ?`.
  - `upsertForeignNode(db, teamId: string, node: { id: string; label: string; last_seen_at: number | null }): void` — insert `id, team_id, label, next_seq=1, last_seen_at` or update `label, last_seen_at` only.
  - `listNodeLiveness(db, teamId: string): { id: string; label: string; last_seen_at: number | null }[]`.

- [ ] **Step 1: Failing tests**

In `store.test.ts` `describe('presence')`:

```ts
it('a remote row is live while its node is, and reads its node label (presence replication §3)', () => {
  const { db, team } = freshTeam();
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
  const now = Date.now();
  db.prepare('INSERT INTO nodes (id, team_id, label, next_seq, last_seen_at) VALUES (?, ?, ?, 1, ?)').run('nB', team.id, 'laptop-b', now);
  db.prepare(
    "INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, created_at, node, model, driver, workspace) VALUES ('rB', ?, 'codex', 'online', NULL, ?, ?, 'nB', 'gpt-5', 'nick', '~/b')",
  ).run(ada.row.id, now - 10 * 60_000, now - 10 * 60_000); // a stale heartbeat would be dead locally
  expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(true);
  const p = listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada')!;
  expect(p.status).toBe('online');
  expect(p.presences[0]).toMatchObject({ node: 'nB', node_label: 'laptop-b', model: 'gpt-5', driver: 'nick', workspace: '~/b' });
  expect(listLiveDrivers(db, team.id, 45_000).has('nick')).toBe(true);
  expect(countLivePresences(db, 45_000)).toBe(1);
  // The node goes quiet past the TTL: the same row is not live.
  db.prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(now - REMOTE_PRESENCE_TTL_MS - 1, 'nB');
  expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(false);
  expect(listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada')!.status).toBe('offline');
});
```

In `nodes.test.ts`:

```ts
it('touchNode stamps last_seen_at; upsertForeignNode never touches next_seq or credentials', () => {
  const { db, team } = freshTeam(); // or the file's own helper
  upsertForeignNode(db, team.id, { id: 'nX', label: 'x', last_seen_at: 5 });
  db.prepare('UPDATE nodes SET next_seq = 40, credential_hash = ? WHERE id = ?').run('h', 'nX');
  upsertForeignNode(db, team.id, { id: 'nX', label: 'x2', last_seen_at: 9 });
  touchNode(db, 'nX', 11);
  expect(db.prepare('SELECT label, next_seq, credential_hash, last_seen_at FROM nodes WHERE id = ?').get('nX')).toEqual({ label: 'x2', next_seq: 40, credential_hash: 'h', last_seen_at: 11 });
  expect(listNodeLiveness(db, team.id)).toContainEqual({ id: 'nX', label: 'x2', last_seen_at: 11 });
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**

`config.ts`, after `PRESENCE_TIMEOUT_MS`:

```ts
/**
 * How long a presence row folded from another machine stays live after its node's last sync
 * contact (presence replication, 2026-09-02): the origin's own reap window plus two chances to
 * push. This is the staleness ADR 325 §Consequences said the build must tolerate explicitly, not
 * rediscover — a seat on a machine that lost power is displaceable in under three minutes; a seat
 * on a machine between pushes is not. Named once; every reader of remote liveness uses it.
 */
export const REMOTE_PRESENCE_TTL_MS = PRESENCE_TIMEOUT_MS + 2 * 60_000;
```

(`60_000` rather than importing `SYNC_PUSH_INTERVAL_MS` from `sync/push.ts`, which would make config depend on sync. Add a comment on `SYNC_PUSH_INTERVAL_MS` in `push.ts`: "if this changes, change `REMOTE_PRESENCE_TTL_MS`".)

`presence.ts` — the predicate, exported for tests:

```ts
/**
 * The one definition of "live", node-aware (spec §3). Bind `[cutoffLocal, cutoffRemote]` in that
 * order. Requires `presence p LEFT JOIN nodes n ON n.id = p.node` in the FROM clause.
 */
export const LIVE_PRESENCE_SQL =
  "p.held_until IS NULL AND ((p.node IS NULL AND p.last_seen_at > ?) OR (p.node IS NOT NULL AND n.last_seen_at > ?))";

function liveCutoffs(timeoutMs: number, now = Date.now()): [number, number] {
  return [now - timeoutMs, now - REMOTE_PRESENCE_TTL_MS];
}
```

Rewrite:

```ts
export function hasLivePresence(db: Database, memberId: string, timeoutMs: number): boolean {
  const [l, r] = liveCutoffs(timeoutMs);
  const row = db
    .prepare<[string, number, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM presence p LEFT JOIN nodes n ON n.id = p.node WHERE p.member_id = ? AND ${LIVE_PRESENCE_SQL}`,
    )
    .get(memberId, l, r);
  return (row?.n ?? 0) > 0;
}

export function countLivePresences(db: Database, timeoutMs: number): number {
  const [l, r] = liveCutoffs(timeoutMs);
  const row = db
    .prepare<[number, number], { n: number }>(
      `SELECT COUNT(DISTINCT p.member_id) AS n FROM presence p JOIN members m ON m.id = p.member_id LEFT JOIN nodes n ON n.id = p.node WHERE m.observer = 0 AND ${LIVE_PRESENCE_SQL}`,
    )
    .get(l, r);
  return row?.n ?? 0;
}

export function listLiveDrivers(db: Database, teamId: string, timeoutMs: number): Set<string> {
  const [l, r] = liveCutoffs(timeoutMs);
  const rows = db
    .prepare<[string, number, number], { driver: string }>(
      `SELECT DISTINCT p.driver AS driver FROM presence p JOIN members m ON m.id = p.member_id LEFT JOIN nodes n ON n.id = p.node WHERE m.team_id = ? AND p.driver IS NOT NULL AND ${LIVE_PRESENCE_SQL}`,
    )
    .all(teamId, l, r);
  return new Set(rows.map((r) => r.driver));
}
```

`listPresence`: the inner query becomes

```ts
    const presences = db
      .prepare<[string, number, number], PresenceRow & { node_label: string | null }>(
        `SELECT p.*, n.label AS node_label FROM presence p LEFT JOIN nodes n ON n.id = p.node WHERE p.member_id = ? AND ${LIVE_PRESENCE_SQL} ORDER BY p.last_seen_at DESC`,
      )
      .all(member.id, l, r);
```

and each mapped presence gains `node: p.node ?? null, node_label: p.node_label ?? null`. Add both to
the `PresenceSummary.presences` element type.

`touchAmbientPresence` calls `hasLivePresence` for `wasLive` — unchanged and correct.

`nodes.ts`:

```ts
/** The hub's stamp on every authenticated sync contact (push, pull, claim): the node is alive now. */
export function touchNode(db: Database, nodeId: string, now: number): void {
  db.prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(now, nodeId);
}

/**
 * A node this daemon learned of from the hub's pull summary. Writes identity and liveness ONLY:
 * `next_seq` is an allocator this daemon must never mint from for a foreign node, and the
 * credential columns are the hub's business (ADR 328).
 */
export function upsertForeignNode(
  db: Database,
  teamId: string,
  node: { id: string; label: string; last_seen_at: number | null },
): void {
  db.prepare(
    `INSERT INTO nodes (id, team_id, label, next_seq, last_seen_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, last_seen_at = excluded.last_seen_at`,
  ).run(node.id, teamId, node.label, node.last_seen_at);
}

/** Every node of the team with its liveness stamp — the pull response's `nodes`. */
export function listNodeLiveness(
  db: Database,
  teamId: string,
): { id: string; label: string; last_seen_at: number | null }[] {
  return db
    .prepare<[string], { id: string; label: string; last_seen_at: number | null }>(
      'SELECT id, label, last_seen_at FROM nodes WHERE team_id = ? ORDER BY id',
    )
    .all(teamId);
}
```

- [ ] **Step 4: Run** `pnpm vitest run packages/server/src/store` — PASS.
- [ ] **Step 5: Commit** `feat(server): one node-aware liveness predicate; touchNode/upsertForeignNode/listNodeLiveness`

---

### Task 5: Protocol — the third kind, `nodes` on the pull, `node` on the roster, epoch 18

**Files:**
- Modify: `packages/protocol/src/sync.ts`
- Modify: `packages/protocol/src/member.ts:58-94` (`PresenceSchema`)
- Modify: `packages/protocol/src/feature-epoch.ts:90`
- Test: `packages/protocol/src/sync.test.ts` (exists; add cases)

**Interfaces:**
- Produces: `SyncPresenceEventSchema`, `SyncPresenceEvent`, `SyncPullPresenceEventSchema`; `SyncEventSchema` and `SyncPullEventSchema` are three-way unions; `syncEventId`/`syncEventTeam` handle `kind === 'presence'`.
- Produces: `SyncPullResponseSchema.nodes: z.array(z.object({ id, label, last_seen_at: z.number().int().nullable() })).default([])`.
- Produces: `PresenceSchema.node: z.string().nullish()`, `node_label: z.string().nullish()`.
- Produces: `FEATURE_EPOCH = 18`.

- [ ] **Step 1: Failing tests**

```ts
it('a presence event parses under its tag and keys on the audit row id', () => {
  const ev = SyncEventSchema.parse({
    kind: 'presence', team: 'bravo', origin_node: 'n1', origin_seq: 3,
    event: { id: 'a1', ts: 1, actor: 'ada', action: 'presence.attached', target: 'ada', result: 'allow', detail: { presence: 'p1' } },
  });
  expect(syncEventId(ev)).toBe('a1');
  expect(syncEventTeam(ev)).toBe('bravo');
});
it('the pull response carries node liveness, defaulting to none for an older hub', () => {
  expect(SyncPullResponseSchema.parse({ events: [], hub_seq_high: 0 }).nodes).toEqual([]);
  expect(SyncPullResponseSchema.parse({ events: [], hub_seq_high: 0, nodes: [{ id: 'n', label: 'l', last_seen_at: null }] }).nodes).toHaveLength(1);
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/protocol/src/sync.test.ts` — FAIL.

- [ ] **Step 3: Implement**

In `sync.ts`, after `SyncLaneEventSchema`:

```ts
/**
 * One replicated PRESENCE event (presence-replication spec 2026-09-02): a `presence.*` audit row —
 * attached, detached, reattested — the session transition, written where the presence row changed.
 * The lane event's shape under its own tag: same allocator, same composed `AuditEntrySchema`, and
 * the fold decides what it can project. Heartbeats never ride this wire.
 */
export const SyncPresenceEventSchema = SyncLaneEventSchema.extend({ kind: z.literal('presence') });
export type SyncPresenceEvent = z.infer<typeof SyncPresenceEventSchema>;
```

`SyncEventSchema = z.union([SyncLaneEventSchema, SyncPresenceEventSchema, SyncMessageEventSchema])`.
`syncEventId`: `event.kind === 'lane' || event.kind === 'presence' ? event.event.id : event.envelope.id`; same for `syncEventTeam`.
`SyncPullPresenceEventSchema = SyncPresenceEventSchema.extend({ hub_seq: z.number().int().positive() })`; add to `SyncPullEventSchema`'s union.

`SyncPullResponseSchema` gains:

```ts
  /**
   * Every node of the team with the hub's liveness stamp (presence replication §3). A remote
   * presence row is live while its node is; this is how a joiner learns that. Defaults to empty
   * so an older hub's page still parses — every remote row then reads not-live, the conservative
   * answer.
   */
  nodes: z
    .array(z.object({ id: z.string().min(1), label: z.string(), last_seen_at: z.number().int().nullable() }))
    .default([]),
```

`member.ts` `PresenceSchema`, after `wake_lease`:

```ts
  /** The machine this presence lives on (presence replication, 2026-09-02): a `nodes.id`, or
   *  null/absent for a row on this daemon. `node_label` is that node's human label. */
  node: z.string().nullish(),
  node_label: z.string().nullish(),
```

`feature-epoch.ts`: bump to 18 with the comment:

```ts
// Epoch 18 — presence replication (spec 2026-09-02): presence.* is the third replicated kind and
// `presence.node` exists (migration 59). An older hub refuses a `kind: 'presence'` push (422); an
// older joiner stops on the unknown kind. Hub before joiners, as every federation increment.
export const FEATURE_EPOCH = 18 as const;
```

Check for a feature-epoch test that pins the number and update it.

- [ ] **Step 4: Run** `pnpm vitest run packages/protocol` and `pnpm typecheck` — PASS. Typecheck will flag `toSyncEvent` in `push.ts` and the fold's `event.kind === 'lane'` narrowing; fix those in Tasks 6 and 7 (a temporary `as` cast is acceptable only until Task 7 lands in the same PR).
- [ ] **Step 5: Commit** `feat(protocol): kind 'presence' on the sync wire, nodes on the pull, node on the roster presence, epoch 18`

---

### Task 6: Push tags `presence.*` rows; hub stamps node contact and enforces residence at ingest; pull response carries `nodes`

**Files:**
- Modify: `packages/server/src/sync/push.ts:135-153` (`toSyncEvent`) and the `!res.ok` branch (~line 314)
- Modify: `packages/server/src/sync/log.ts` (`ingestBatch`, inside the per-event loop after the team check)
- Modify: `packages/server/src/transport/http.ts:3645-3770` (the three `/sync/*` routes)
- Test: `packages/server/src/sync/push.test.ts`

**Interfaces:**
- Consumes: `touchNode`, `listNodeLiveness` (Task 4); `bindSeatToNode` from `store/nodes.ts` (#1195, ADR 355 §5); `getMemberByName`.
- Produces: `SyncResidenceError extends Error { seat: string; boundTo: string; boundLabel: string }` in `log.ts`, mapped to `403 { error: { code: 'bound_elsewhere', message }, seat, node_id, node_label }` by the push route.

- [ ] **Step 0: Failing residence test** (push.test.ts):

```ts
it('the hub refuses a presence event for a seat bound to another node, and binds an unbound seat to the pusher (spec §2)', async () => {
  // nick claims locally on the hub: nick is bound to the hub's node (#1195).
  const laneId = (await post(hubBase, '/teams/bravo/lanes', { title: 'x' }, nickOnHub)).json.lane.id;
  await patch(hubBase, `/teams/bravo/lanes/${laneId}`, { owner_seat: 'nick' }, nickOnHub);
  // The joiner attaches nick anyway and pushes.
  const nickJ = joiner.db.prepare<[string], { id: string }>("SELECT id FROM members WHERE name = 'nick' AND team_id = ?").get(joinerTeam().id)!;
  attach(joiner.db, nickJ.id, 'codex', 'c1');
  const cursorBefore = joiner.db.prepare('SELECT last_seq FROM sync_push_cursor').get();
  await expect(pushTeam(joinerCtx, joinerTeam())).rejects.toThrow(/bound_elsewhere|403/);
  expect(joiner.db.prepare('SELECT last_seq FROM sync_push_cursor').get()).toEqual(cursorBefore);
  // An unbound seat binds to the joiner on its first attached.
  const adaJ = joiner.db.prepare<[string], { id: string }>("SELECT id FROM members WHERE name = 'ada' AND team_id = ?").get(joinerTeam().id)!;
  // (detach nick first so the batch is clean, or run this half in its own test)
});
```

Split into two tests if the batch ordering makes the second half awkward — the refused batch blocks the cursor by design.

In `ingestBatch`, after the team check and before the replay check, for `event.kind === 'presence'`:

```ts
      if (event.kind === 'presence') {
        const seat = getMemberByName(db, teamId, event.event.actor ?? '');
        // An unknown seat is the fold's problem (unresolved_seat); residence needs a member id.
        if (seat) {
          const bound = bindSeatToNode(db, teamId, seat.id, nodeId, now);
          if (!bound.bound) throw new SyncResidenceError(seat.name, bound.node_id, bound.label);
        }
      }
```

`ingestBatch` runs in one transaction, so a throw rolls back any binding minted earlier in the same batch — correct: a refused batch binds nothing.

In `push.ts`, before `if (!res.ok)`:

```ts
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { seat?: unknown; node_label?: unknown } | null;
    // ADR 335 §7: a refusal must be distinguishable from offline. The way out is an admin unbind.
    log.error({ msg: 'sync_push_refused_residence', team: team.slug, seat: body?.seat ?? null, bound_to: body?.node_label ?? null, detail: 'a presence event names a seat bound to another node; unbind it or attach from where it lives' });
    throw new Error(`hub refused the batch (403 bound_elsewhere)`);
  }
```

- [ ] **Step 1: Failing test** (push.test.ts, using its existing hub/joiner harness):

```ts
it('a presence.* row rides the push under kind presence, and the hub stamps the node as seen', async () => {
  // attach a seat on the joiner, then push
  const ada = joiner.db.prepare<[string], { id: string }>("SELECT id FROM members WHERE name = 'ada' AND team_id = ?").get(joinerTeam().id)!;
  attach(joiner.db, ada.id, 'codex', 'c1', { model: 'gpt-5' });
  const before = Date.now();
  await pushTeam(joinerCtx, joinerTeam(), before);
  const staged = hub.db.prepare<[], { payload: string }>('SELECT payload FROM sync_log ORDER BY hub_seq').all().map((r) => JSON.parse(r.payload));
  expect(staged.some((e) => e.kind === 'presence' && e.event.action === 'presence.attached')).toBe(true);
  const joinerNode = readNodeState().nodes['bravo']!.node_id;
  expect(hub.db.prepare<[string], { last_seen_at: number }>('SELECT last_seen_at FROM nodes WHERE id = ?').get(joinerNode)!.last_seen_at).toBeGreaterThanOrEqual(before);
});
```

- [ ] **Step 2: Run** — FAIL (kind is `lane`, `last_seen_at` null).

- [ ] **Step 3: Implement**

`push.ts` `toSyncEvent`, lane branch:

```ts
    return {
      // The action prefix decides the tag: one allocator, one query, three kinds.
      kind: row.action.startsWith('presence.') ? 'presence' : 'lane',
      ...
```

(TypeScript: build the object once with `kind` typed as `'lane' | 'presence'`.)

`http.ts`: in each of the three sync routes, immediately after the `if (!node) throw ...` block:

```ts
        touchNode(ctx.db, node.id, Date.now());
```

In the pull route's `sendJson(... SyncPullResponseSchema.parse({ events, hub_seq_high: head }))`, add
`nodes: listNodeLiveness(ctx.db, team.id).map((n) => n.id === localNodeForTeam(ctx.db, team.id).id ? { ...n, last_seen_at: Date.now() } : n)`
— the hub's own row reads "now": a hub answering a pull is alive by definition. Import
`localNodeForTeam` from `../store/messages.js` if not already imported in http.ts (it is used by the
claim route; check).

- [ ] **Step 4: Run** `pnpm vitest run packages/server/src/sync/push.test.ts packages/server/src/transport` — PASS.
- [ ] **Step 5: Commit** `feat(server): presence.* rows push under their own kind; the hub stamps node contact and hands liveness back on the pull`

---

### Task 7: The fold projects `presence.*`; the puller folds the `nodes` summary

**Files:**
- Modify: `packages/server/src/sync/fold.ts` (`FoldStop`, new `PRESENCE_VERBS`, `projectPresenceEvent`, the `event.kind` branch in `foldBatch`; `heldHead`/`heldPair` already cover audit)
- Modify: `packages/server/src/sync/pull.ts` (`fetchPage` returns `{events, nodes}`; `pullTeam` upserts nodes before folding; `reportStop` gains four cases)
- Test: `packages/server/src/sync/fold.test.ts`

**Interfaces:**
- Produces: `FoldStop` gains `{ kind: 'unknown_presence_event'; action: string; hub_seq: number }` and `{ kind: 'presence_unborn'; presence: string; action: string; hub_seq: number }`.
- Produces: `foldNodeLiveness(db, teamId, nodes)` exported from `fold.ts`.

- [ ] **Step 1: Failing tests** (fold.test.ts, using its through-DB harness; `mkPresenceEvent` is a local helper you write, mirroring the file's lane-event helper):

```ts
it('presence.attached inserts a remote row keyed on the origin node; reattested updates it; detached deletes it', () => {
  const { db, team } = freshTeamWithNode(); // the file's helper that seeds a local_node
  addMember(db, team, { name: 'ada', kind: 'agent' });
  const att = mkPresenceEvent({ origin_node: 'nB', origin_seq: 1, hub_seq: 1, action: 'presence.attached', detail: { presence: 'pB', surface: 'codex', model: 'gpt-5', model_source: 'observed', workspace: '~/b', driver: 'nick', provenance: 'session', build: null, epoch: 17 } });
  expect(foldBatch(db, team.id, [att]).stop).toBeNull();
  expect(db.prepare("SELECT node, surface, model, workspace, driver, conn_id, held_until, wake_lease FROM presence WHERE id = 'pB'").get()).toEqual({ node: 'nB', surface: 'codex', model: 'gpt-5', workspace: '~/b', driver: 'nick', conn_id: null, held_until: null, wake_lease: null });
  const re = mkPresenceEvent({ origin_node: 'nB', origin_seq: 2, hub_seq: 2, action: 'presence.reattested', detail: { presence: 'pB', model: 'gpt-5-mini', model_source: 'observed', surface: 'codex' } });
  expect(foldBatch(db, team.id, [re]).stop).toBeNull();
  expect(db.prepare("SELECT model FROM presence WHERE id = 'pB'").get()).toEqual({ model: 'gpt-5-mini' });
  const det = mkPresenceEvent({ origin_node: 'nB', origin_seq: 3, hub_seq: 3, action: 'presence.detached', detail: { presence: 'pB', reason: 'goodbye' } });
  expect(foldBatch(db, team.id, [det]).stop).toBeNull();
  expect(db.prepare("SELECT COUNT(*) AS n FROM presence WHERE id = 'pB'").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'presence.%' AND origin_node = 'nB'").get()).toEqual({ n: 3 });
});

it('a reattested for a session never seen attach stops as presence_unborn; a detached for one is a no-op that advances', () => {
  const { db, team } = freshTeamWithNode();
  addMember(db, team, { name: 'ada', kind: 'agent' });
  const det = mkPresenceEvent({ origin_node: 'nB', origin_seq: 1, hub_seq: 1, action: 'presence.detached', detail: { presence: 'ghost', reason: 'reaped' } });
  expect(foldBatch(db, team.id, [det])).toMatchObject({ stop: null, applied: 1, last_hub_seq: 1 });
  const re = mkPresenceEvent({ origin_node: 'nB', origin_seq: 2, hub_seq: 2, action: 'presence.reattested', detail: { presence: 'ghost', model: 'x', model_source: null, surface: 'codex' } });
  expect(foldBatch(db, team.id, [re]).stop).toMatchObject({ kind: 'presence_unborn', presence: 'ghost' });
  expect(readPullCursor(db, team.id)).toBe(1);
});

it('an unknown presence verb or a surface this build cannot store stops as unknown_presence_event', () => {
  const { db, team } = freshTeamWithNode();
  addMember(db, team, { name: 'ada', kind: 'agent' });
  const weird = mkPresenceEvent({ origin_node: 'nB', origin_seq: 1, hub_seq: 1, action: 'presence.attached', detail: { presence: 'p', surface: 'holodeck' } });
  expect(foldBatch(db, team.id, [weird]).stop).toMatchObject({ kind: 'unknown_presence_event' });
});

it('foldNodeLiveness upserts foreign nodes without touching the local allocator', () => {
  const { db, team, localNode } = freshTeamWithNode();
  db.prepare('UPDATE nodes SET next_seq = 7 WHERE id = ?').run(localNode);
  foldNodeLiveness(db, team.id, [{ id: localNode, label: 'me', last_seen_at: 1 }, { id: 'nB', label: 'b', last_seen_at: 2 }]);
  expect(db.prepare('SELECT next_seq FROM nodes WHERE id = ?').get(localNode)).toEqual({ next_seq: 7 });
  expect(db.prepare("SELECT label, last_seen_at FROM nodes WHERE id = 'nB'").get()).toEqual({ label: 'b', last_seen_at: 2 });
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/server/src/sync/fold.test.ts` — FAIL.

- [ ] **Step 3: Implement**

`fold.ts`:

```ts
const PRESENCE_VERBS = new Set(['presence.attached', 'presence.detached', 'presence.reattested']);

/** The surfaces this build's `presence` CHECK admits (migration 57). Keep in step with it. */
const STORABLE_SURFACES = new Set(['cli', 'claude-code', 'codex', 'opencode', 'grok', 'cursor', 'web', 'ios', 'slack', 'other', 'musterd']);

/**
 * Project one replicated presence transition into this daemon's `presence` (spec §2). `node` is the
 * origin, `conn_id`/`held_until`/`wake_lease` are NULL: nothing here heartbeats, holds, or verifies
 * a lease for a session on another machine. A detach for a row we no longer hold is the same fact
 * arriving after our stale-node sweep — applied as a no-op. A reattest for a row we never held is
 * a hole, and stops.
 */
function projectPresenceEvent(
  db: Database,
  teamId: string,
  originNode: string,
  event: SyncPullLaneEvent['event'],
): 'applied' | 'unborn' | 'unknown' {
  const d = (event.detail ?? {}) as Record<string, unknown>;
  const presenceId = typeof d['presence'] === 'string' ? d['presence'] : '';
  if (!presenceId) return 'unknown';
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
  switch (event.action) {
    case 'presence.attached': {
      const surface = str('surface');
      if (!surface || !STORABLE_SURFACES.has(surface)) return 'unknown';
      const member = getMemberByName(db, teamId, event.actor ?? '');
      if (!member) return 'unknown'; // caller already resolved the seat; defensive
      if (db.prepare('SELECT 1 FROM presence WHERE id = ?').get(presenceId)) return 'applied';
      db.prepare(
        `INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, held_until, provenance, workspace, driver, model, model_source, build, epoch, wake_lease, node, created_at)
         VALUES (?, ?, ?, 'online', NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(presenceId, member.id, surface, event.ts, str('provenance'), str('workspace'), str('driver'), str('model'), str('model') ? str('model_source') : null, str('build'), typeof d['epoch'] === 'number' ? d['epoch'] : null, originNode, event.ts);
      return 'applied';
    }
    case 'presence.detached':
      db.prepare('DELETE FROM presence WHERE id = ? AND node = ?').run(presenceId, originNode);
      return 'applied';
    case 'presence.reattested': {
      const surface = str('surface');
      if (surface && !STORABLE_SURFACES.has(surface)) return 'unknown';
      const r = db
        .prepare('UPDATE presence SET model = ?, model_source = ?, surface = COALESCE(?, surface) WHERE id = ? AND node = ?')
        .run(str('model'), str('model') ? str('model_source') : null, surface, presenceId, originNode);
      return r.changes === 0 ? 'unborn' : 'applied';
    }
    default:
      return 'unknown';
  }
}
```

In `foldBatch`, before the `if (event.kind === 'lane')` block:

```ts
      if (event.kind === 'presence') {
        const e = event.event;
        if (!PRESENCE_VERBS.has(e.action)) {
          stop = { kind: 'unknown_presence_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        // The seat must resolve here, the message rule: a presence for a seat this roster lacks
        // is git lag, not a fact to drop.
        if (!getMemberByName(db, teamId, e.actor ?? '')) {
          stop = { kind: 'unresolved_seat', seat: e.actor ?? '', hub_seq: event.hub_seq };
          return finish();
        }
        const outcome = projectPresenceEvent(db, teamId, event.origin_node, e);
        if (outcome === 'unknown') {
          stop = { kind: 'unknown_presence_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        if (outcome === 'unborn') {
          const presenceId = typeof e.detail?.['presence'] === 'string' ? (e.detail['presence'] as string) : '';
          stop = { kind: 'presence_unborn', presence: presenceId, action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        db.prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(e.id, teamId, e.ts, e.actor, e.action, e.target, e.result, e.detail ? JSON.stringify(e.detail) : null, now, event.origin_node, event.origin_seq);
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }
```

Add the two `FoldStop` members. Add and export:

```ts
/** The pull response's `nodes` summary, applied before the events it accompanies (spec §3). */
export function foldNodeLiveness(
  db: Database,
  teamId: string,
  nodes: { id: string; label: string; last_seen_at: number | null }[],
): void {
  for (const n of nodes) upsertForeignNode(db, teamId, n);
}
```

(`upsertForeignNode` is safe for the local node too: it only touches `label` and `last_seen_at`.)

`pull.ts`: `fetchPage` returns `SyncPullResponse` (parse the whole body). In `pullTeam`:

```ts
  const page = enrollment
    ? await fetchPage(enrollment.hub_url, enrollment.credential, team.slug, cursor)
    : { events: readStaged(ctx.db, team.id, cursor, SYNC_PULL_MAX_BATCH), nodes: [] as const };
  if (page.nodes.length > 0) foldNodeLiveness(ctx.db, team.id, page.nodes);
  if (page.events.length === 0) return 0;
  const result = foldBatch(ctx.db, team.id, page.events, now);
```

Node liveness is applied even when the page is empty: a quiet team still needs to know its machines
are alive.

`reportStop` gains:

```ts
    case 'unknown_lane_event':
    case 'unknown_presence_event':
      log.error({ msg: 'sync_fold_unknown_event', team, action: stop.action, hub_seq: stop.hub_seq, detail: 'a peer runs a newer build; upgrade this daemon — retrying each tick' });
      return;
    case 'lane_unborn':
      log.error({ msg: 'sync_fold_lane_unborn', team, lane: stop.lane, action: stop.action, hub_seq: stop.hub_seq, detail: 'a transition for a lane this daemon never saw born (pre-2026-09-02 lane, or a hole); retrying each tick' });
      return;
    case 'presence_unborn':
      log.error({ msg: 'sync_fold_presence_unborn', team, presence: stop.presence, action: stop.action, hub_seq: stop.hub_seq, detail: 'a re-attestation for a session this daemon never saw attach; retrying each tick' });
      return;
```

- [ ] **Step 4: Run** `pnpm vitest run packages/server/src/sync` and `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(server): the fold projects presence.* into presence; the puller folds node liveness`

---

### Task 8: The two-daemon falsifier

**Files:**
- Create: `packages/server/src/sync/presence.test.ts` (harness copied from `claim.test.ts:1-148`, verbatim, so the file stands alone)
- Modify: `packages/server/src/sync/claim.ts:104-106` (comment only)

- [ ] **Step 1: Write the eight cases** (spec §Falsifiers). Helpers on top of the copied harness:

```ts
const memberId = (db: Database, teamId: string, name: string) =>
  db.prepare<[string, string], { id: string }>('SELECT id FROM members WHERE team_id = ? AND name = ?').get(teamId, name)!.id;
/** joiner → hub → joiner: push, hub folds its staging, joiner pulls. */
async function roundTrip() {
  await pushTeam(joinerCtx, joinerTeam());
  await pullTeam(hubCtx(), hubTeam());
  await pushTeam(hubCtx(), hubTeam());
  await pullTeam(joinerCtx, joinerTeam());
}
const presenceOf = (db: Database, teamId: string, name: string) =>
  listPresence(db, teamId, 45_000).find((s) => s.member.name === name)!;
```

```ts
describe('presence replication — every machine sees every seat', () => {
  it('1. a seat attached on the joiner is live on the hub with its facets and its node', async () => {
    const row = attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1', { model: 'gpt-5', model_source: 'observed', driver: 'nick', workspace: '~/b' });
    await roundTrip();
    const joinerNode = readNodeState().nodes['bravo']!.node_id;
    const onHub = presenceOf(hub.db, hubTeam().id, 'ada');
    expect(onHub.status).toBe('online');
    expect(onHub.presences[0]).toMatchObject({ surface: 'codex', model: 'gpt-5', driver: 'nick', workspace: '~/b', node: joinerNode, node_label: 'joiner laptop' });
    expect(hasLivePresence(hub.db, memberId(hub.db, hubTeam().id, 'ada'), 45_000)).toBe(true);
    expect(row.node).toBeNull();
  });

  it("2. a claim against a lane held by a seat live on the joiner is refused naming the holder — ADR 355 §4's hole, closed", async () => {
    const laneId = await laneOnBoth();
    updateLane(hub.db, hubTeam().id, laneId, 'bravo', { owner_seat: 'ada' }, 5, undefined, { actor: 'ada' });
    attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1');
    await roundTrip();
    const res = await patch(joinerBase, `/teams/bravo/lanes/${laneId}`, { owner_seat: 'nick' }, nickOnJoiner);
    expect(res.status).toBe(409);
    expect(res.json.holder).toBe('ada');
    expect(res.json.error.message).toContain('live');
  });

  it('3. after the joiner goes quiet past the TTL the same claim succeeds, the row is gone, and nothing wrote a detached', async () => {
    const laneId = await laneOnBoth();
    updateLane(hub.db, hubTeam().id, laneId, 'bravo', { owner_seat: 'ada' }, 5, undefined, { actor: 'ada' });
    attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1');
    await roundTrip();
    const joinerNode = readNodeState().nodes['bravo']!.node_id;
    hub.db.prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(Date.now() - REMOTE_PRESENCE_TTL_MS - 1, joinerNode);
    reapStale(hub.db, 45_000);
    expect(presenceOf(hub.db, hubTeam().id, 'ada').status).toBe('offline');
    const res = await patch(joinerBase, `/teams/bravo/lanes/${laneId}`, { owner_seat: 'nick' }, nickOnJoiner);
    // The claim route itself touches the node; the rule ran against the swept table first.
    expect(res.status).toBe(200);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.detached'").get()).toEqual({ n: 0 });
  });

  it("4. a detach on the joiner removes the row on the hub; the hub holds the joiner's detached row and wrote none of its own", async () => {
    const row = attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1');
    await roundTrip();
    detach(joiner.db, row.id);
    await roundTrip();
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM presence WHERE id = ?').get(row.id)).toEqual({ n: 0 });
    const joinerNode = readNodeState().nodes['bravo']!.node_id;
    const det = hub.db.prepare<[], { origin_node: string }[]>("SELECT origin_node FROM audit WHERE action = 'presence.detached'").all();
    expect(det).toEqual([{ origin_node: joinerNode }]);
  });

  it('5. a reattest on the joiner changes model and surface on the hub', async () => {
    const row = attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1', { model: 'gpt-5', model_source: 'observed' });
    await roundTrip();
    reattestModel(joiner.db, row.id, 'gpt-5-mini', 'observed');
    reattestSurface(joiner.db, row.id, 'cli');
    await roundTrip();
    expect(hub.db.prepare('SELECT model, surface FROM presence WHERE id = ?').get(row.id)).toEqual({ model: 'gpt-5-mini', surface: 'cli' });
  });

  it('6. a reattested whose attach never folded stops the fold; a detached for one is a no-op that advances', async () => {
    // Stage a reattested for a ghost directly on the hub under the joiner's node, then let the hub fold it.
    const joinerNode = readNodeState().nodes['bravo']!.node_id;
    const { json } = await post(hubBase, '/teams/bravo/sync/push', { events: [{ kind: 'presence', team: 'bravo', origin_node: joinerNode, origin_seq: 2, event: { id: 'ghost-re', ts: 1, actor: 'ada', action: 'presence.reattested', target: 'ada', result: 'allow', detail: { presence: 'ghost', model: 'x', model_source: null, surface: 'cli' } } }] }, readNodeState().nodes['bravo']!.credential);
    // origin_seq 1 is the joiner's j-0 message, already pushed by enrollment? If not, push first so seq 2 is next.
    expect(json.accepted).toBe(1);
    const result = await pullTeam(hubCtx(), hubTeam());
    expect(result).toBe(0);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE id = 'ghost-re'").get()).toEqual({ n: 0 });
  });

  it("7. a fresh hello for a seat on the joiner clears its local rows with reason cleared and leaves the hub-origin row alone", async () => {
    const hubAda = attach(hub.db, memberId(hub.db, hubTeam().id, 'ada'), 'claude-code', 'h1');
    await roundTrip();
    expect(joiner.db.prepare('SELECT node FROM presence WHERE id = ?').get(hubAda.id)).toMatchObject({ node: expect.any(String) });
    const local = attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1');
    clearMemberPresence(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'));
    expect(joiner.db.prepare('SELECT COUNT(*) AS n FROM presence WHERE id = ?').get(local.id)).toEqual({ n: 0 });
    expect(joiner.db.prepare('SELECT COUNT(*) AS n FROM presence WHERE id = ?').get(hubAda.id)).toEqual({ n: 1 });
    expect(joiner.db.prepare<[], { detail: string }[]>("SELECT detail FROM audit WHERE action = 'presence.detached' AND origin_node = ?").all(readNodeState().nodes['bravo']!.node_id).map((r) => JSON.parse(r.detail))).toEqual([{ presence: local.id, reason: 'cleared' }]);
  });
});
```

Case 8 is Task 3's store tests (already green). For case 6, read `claim.test.ts`'s `beforeEach`: the
joiner's `j-0` message is seq 1 and is pushed on the first `pushTeam`; call `await pushTeam(joinerCtx, joinerTeam())` before staging seq 2 so the gap check passes. Adjust `origin_seq` if the harness minted more.

- [ ] **Step 2: Run** `pnpm vitest run packages/server/src/sync/presence.test.ts` — all seven PASS. If case 3's claim returns 409 because the route's `touchNode` ran before `arbitrateClaim` read presence: that is correct behaviour only if the reaper had not swept; the test sweeps first, so the row is gone and 200 is expected. If it still fails, the reap in Task 3 is not deleting stale-node rows — fix there, not here.

- [ ] **Step 3: Update the comment in `claim.ts:104-106`**

```ts
  // ADR 203's rule, evaluated where the deciding input lives: the hub's presence — which, since
  // presence replication (spec 2026-09-02), holds every machine's seats. A remote row is live while
  // its node is (REMOTE_PRESENCE_TTL_MS); that is the staleness ADR 325 §Consequences priced.
```

- [ ] **Step 4: Full gate** `pnpm lint && pnpm typecheck && pnpm test` — PASS.
- [ ] **Step 5: Commit** `test(server): presence replication falsifier — seven two-daemon cases; claim.ts comment closes ADR 355 §4`

---

### Task 9: Roster everywhere — CLI facet and web chip

**Files:**
- Modify: `packages/cli/src/render/rows.ts:352` (`memberFacets`)
- Modify: `packages/web/src/live/RosterPanel.tsx:186-189`
- Test: `packages/cli/src/render/rows.test.ts` (exists; add one)

- [ ] **Step 1: Failing test** (rows.test.ts, using its existing `MemberSummary` fixture builder):

```ts
it('a seat on another machine shows its node label after the surface', () => {
  const m = member({ name: 'ada', kind: 'agent', presence: 'online', presences: [{ surface: 'codex', status: 'online', last_seen_at: 1, node: 'nB', node_label: 'laptop-b' }] });
  expect(stripAnsi(memberLineForTest(m))).toContain('codex @ laptop-b');
});
```

(Use whatever the file's existing exported render entry is; `memberFacets` is private — render the row and match.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**

`rows.ts` line 352:

```ts
  if (group !== 'out' && m.presences[0]?.surface) {
    const p = m.presences[0]!;
    // A seat on another machine says so (presence replication): `codex @ laptop-b`. A local row is silent.
    parts.push(p.node_label ? `${p.surface} @ ${p.node_label}` : p.surface);
  }
```

`RosterPanel.tsx` line 187, the chip `title`:

```tsx
            title={
              (m.offline_reason ? `Offline reason: ${m.offline_reason}` : `Posture: ${chip.label}`) +
              (m.presences?.[0]?.node_label ? ` · on ${m.presences[0].node_label}` : '')
            }
```

and render a small dim suffix after the chip label:

```tsx
            {chip.label}
            {m.presences?.[0]?.node_label ? <span className="lc-stat__node"> @ {m.presences[0].node_label}</span> : null}
```

Add `.lc-stat__node { opacity: 0.7; font-weight: 400; }` to the panel's stylesheet (find where `.lc-stat` is defined and append).

- [ ] **Step 4: Run** `pnpm vitest run packages/cli/src/render packages/web` and `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(cli,web): the roster names the machine a remote seat lives on`

---

### Task 10: The record — ADR 356, ADR 325 amendment note, topology table

**Files:**
- Create: `docs/decisions/356-presence-replication.md`
- Modify: `docs/decisions/325-multi-machine-federation.md:91-93` (residence 3 bullet: add "Amended by ADR 356: presence *transitions* replicate (residence 2); heartbeats, grace and wake leases stay here.")
- Modify: `docs/design/deployment-topology.md:143` (3c row: replace the trailing "Presence summaries … are the next slice" with a link to the new row) and add row `3d | Presence replication — presence.* as the third replicated kind, node liveness on the pull, roster everywhere | landed <date> (ADR 356)`.
- Modify: `docs/decisions/355-hub-arbitrates-a-joiners-claim.md:89-96` (§4: append "Closed by ADR 356.")

- [ ] **Step 1: Write ADR 356** in the house shape (Status/Date/Builds on/Lane; Context; Problem; Decision §1-§7 lifted from the spec's Decision; Alternatives considered from the spec's rejected list; Consequences; Observability & Evaluation with the falsifier file, the pre-registered prediction "after a second machine enrolls, every seat live on either machine shows on both rosters within one push+pull interval, and no lane held by a live remote seat is ever displaced" and "What would overturn this"). Lane id `01M1HZRWBW63HRHNSC0KSQZQ9J`. Status `proposed`.
- [ ] **Step 2: Make the three edits above.**
- [ ] **Step 3: Run** `pnpm adr-numbers:check && pnpm format:check` — PASS (fix any prose checks it raises).
- [ ] **Step 4: Commit** `docs: ADR 356 presence replication; ADR 325 residence 3 amended; topology increment 3d`

---

### Task 11: PR and lane

- [ ] Rebase on `origin/main`; re-verify the migration number and epoch against anything that landed.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` — all PASS, paste the tail into the PR.
- [ ] `git push -u origin stanley/presence-replication`; open the PR with `gh pr create`, body: the spec's "Why" paragraph, the seven falsifier cases, the epoch/migration notes, "hub before joiners", and the ADR link; end with the session footer.
- [ ] `lane_update {branch}` if needed, then `lane_submit` on `01M1HZRWBW63HRHNSC0KSQZQ9J`; acceptance routes automatically — do not self-close.
- [ ] `team_send status_update` with the PR number; `team_memory_save` with where things stand.

---

## Self-review

- **Spec coverage.** §1 verbs → Task 3; §2 fold + `node` column → Tasks 1, 7; §3 liveness/TTL/node stamp/pull summary → Tasks 4, 6, 7; §4 → Task 8 step 3; §5 roster → Tasks 4, 5, 9; §6 history → Task 3 (rows exist and replicate; no reader, by spec); §7 residence table → Task 10; wire + epoch → Task 5; falsifiers 1-7 → Task 8, 8 → Task 3.
- **Placeholders.** None; case 6's seq note is an instruction, not a gap.
- **Type consistency.** `appendReplicatedEvent(db, teamId, entry)` (T2) used in T3; `touchNode/upsertForeignNode/listNodeLiveness` (T4) used in T6/T7; `REMOTE_PRESENCE_TTL_MS` (T4) used in T3, T8; `node`/`node_label` on `PresenceSummary` (T4) and `PresenceSchema` (T5) match; `foldNodeLiveness` (T7) used in `pull.ts` (T7); `FoldStop` kinds match `reportStop` cases.
