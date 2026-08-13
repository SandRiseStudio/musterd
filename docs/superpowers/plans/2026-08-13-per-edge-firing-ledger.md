# Per-edge firing ledger + spend-level breaker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (musterd note: no writing subagents — ADR 150 / AGENTS.md. Execute inline in the wanderer seat, lane `01KZY20ZRJ0SBH8WJ3CTFPKDP3`.)

**Goal:** Work-order wakes stop re-spending on the same `(lane, edge)` when the last reported failure is still true, or when that edge has failed 3 times.

**Architecture:** `wake_leases` is the ledger (no second table). Stamp `edge` at insert. Stamp `spawned_at` via `POST …/residency/wake-progress` (does not settle). `claimWakeLeases` reads that history before inserting another work-order. Inbox wakes unchanged.

**Tech Stack:** TypeScript monorepo (pnpm), better-sqlite3, zod in `@musterd/protocol`, vitest, existing host poll loop.

**Spec:** `docs/superpowers/specs/2026-08-13-per-edge-firing-ledger-design.md`

## Global Constraints

- Work-order edges only: `review` | `dispatch_handoff` | `dispatch_continuation`. Inbox `immediate`/`batched` stay `edge = NULL`.
- No `delivered_at`. `created_at` = poll transaction committed. `spawned_at` = host exec'd.
- Progress is a **new route**, not an extension of `wake-report` (ADR 247).
- `REVIEW_LOOP_BREAKER_N` in `review.ts` is untouched. New `WORK_ORDER_EDGE_BREAKER_N = 3` in `residency.ts`.
- Breaker counts **`residency.wake_failed` rows on that edge** (including reaper `lease_expired`), not `woke`, not `ready_for_review`. Three successful continuation wakes on one claimed lane must still derive (ADR 199 chaining). This is a spec correction vs the first draft's "3 leases" wording — already patched in the spec file.
- Still-true (skip): `enrolled_dead_workspace`, `not_enrolled`. Transient (retry): `enrolled_seat_busy`, `enrolled_host_stale`, bare `lease_expired`, missing `spawned_at`.
- Breaker trip writes `residency.wake_exhausted` with `detail.breaker: true` + `detail.edge`. No new audit verb. No human ask (ADR 253).
- Do not backfill `edge` on pre-migration rows. Do not bump `FEATURE_EPOCH` (progress is optional; old hosts still wake).
- Do not amend ADR 179 or ADR 250 `## Decision`.
- `pnpm adr:next` for the number — never invent one. Push a **draft PR with a stub at the ADR path** before writing the ADR body (ADR 223).
- Never Prettier `docs/`. Seat trailer on every commit: `Co-authored-by: wanderer <wanderer@revive.musterd>`
- Fast loop: the vitest file named in the task. Before push: `pnpm typecheck && pnpm format:check`.

### File map

| File | Role |
| ---- | ---- |
| `docs/decisions/NNN-per-edge-firing-ledger.md` | This increment's ADR |
| `packages/protocol/src/residency.ts` | `LOOP_EDGES`, `WakeProgressBodySchema` |
| `packages/protocol/src/residency.test.ts` | Schema tests |
| `packages/server/src/db/migrations.ts` | v40 (or next free): `edge`, `spawned_at` + index |
| `packages/server/src/store/residency.ts` | `WakeLeaseRow` columns; stamp `edge`; `markWakeSpawned`; skip predicates; `WORK_ORDER_EDGE_BREAKER_N` |
| `packages/server/src/store/residency.test.ts` | Stamp / skip / breaker / progress-helper tests |
| `packages/server/src/transport/http.ts` | `POST …/wake-progress`; `detail.edge` on report/exhaust |
| `packages/server/src/transport/residency-http.test.ts` | Progress HTTP: stamp, no settle, idempotent, 404 |
| `packages/server/src/presence/reaper.ts` | Put `edge` on expiry `wake_failed` detail |
| `packages/cli/src/client.ts` | `wakeProgress` |
| `packages/cli/src/host/loop.ts` | `WakeClient.wakeProgress`; POST after spawn (not on `deferred`) |
| `packages/cli/src/host/loop.test.ts` | Progress after exec; not on dead-workspace / defer; failure non-fatal |
| `docs/architecture/02-protocol.md` | New route + schema |
| `docs/architecture/03-server.md` | `residency.ts` tree line |
| `docs/architecture/04-cli.md` | `loop.ts` / `client.ts` lines |

`packages/server/src/store/review.ts` is **not** in the change set.

---

### Task 1: Reserve the ADR number (stub + draft PR)

**Files:**
- Create: `docs/decisions/NNN-per-edge-firing-ledger.md` (stub only)
- Modify: none else

**Interfaces:**
- Consumes: `pnpm adr:next` output
- Produces: integer `NNN` every later task cites. Substitute it everywhere this plan writes `NNN`.

- [ ] **Step 1: Allocate**

```bash
pnpm adr:next
```

Expected: a number printed with the next-free path. If it says the number is contested, stop and re-run.

- [ ] **Step 2: Write the stub (Decision empty on purpose — body is Task 8)**

```md
# NNN — Per-edge firing ledger + spend-level breaker

- Status: proposed
- Date: 2026-08-13
- Lane: `01KZY20ZRJ0SBH8WJ3CTFPKDP3`
- Builds on: [ADR 179](179-board-triggered-work-order-wakes.md), [ADR 250](250-loops-one-week-in-judgment-throughput.md) §4 item 1, [ADR 191](191-review-loop-wake.md), [ADR 199](199-dispatch-loop-wake.md), [ADR 131](131-harness-residency-wake-ledger-host.md)

## Context

Stub. Full text in the next commit on this branch. Reserves NNN per ADR 223.

## Problem

Work-order wakes re-fire with no per-edge record of the last firing.

## Decision

(reserved)

## Consequences

(reserved)

## Observability & Evaluation

**Traces.** (reserved)

**Eval.** (reserved)

**Experiment.** (reserved)
```

Do **not** run Prettier on `docs/`.

- [ ] **Step 3: Commit, push, open draft PR**

```bash
git add docs/decisions/NNN-per-edge-firing-ledger.md
git commit -m "$(cat <<'EOF'
docs: reserve ADR NNN for per-edge firing ledger

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
git push -u origin HEAD
gh pr create --draft --title "Per-edge firing ledger + spend-level breaker (ADR NNN)" --body "$(cat <<'EOF'
## Summary
- Board-loops increment 1 (ADR 250 §4.1): per-edge firing ledger + spend-level breaker.
- Stub reserves NNN (ADR 223). Implementation follows on this branch.

## Test plan
- [ ] Protocol schema tests
- [ ] Through-DB stamp / skip / breaker
- [ ] Progress HTTP (no settle)
- [ ] Host posts progress after spawn, not on defer
- [ ] `pnpm typecheck && pnpm format:check`
EOF
)"
```

Expected: draft PR URL. Do not `--auto` merge yet.

---

### Task 2: Protocol — `LOOP_EDGES` + `WakeProgressBodySchema`

**Files:**
- Modify: `packages/protocol/src/residency.ts` (after `WAKE_DERIVATIONS`, ~line 220)
- Modify: `packages/protocol/src/residency.test.ts` (append describes)
- Test: `packages/protocol/src/residency.test.ts`

**Interfaces:**
- Consumes: existing zod patterns in `residency.ts`.
- Produces:

```ts
export const LOOP_EDGES = ['review', 'dispatch_handoff', 'dispatch_continuation'] as const;
export type LoopEdge = (typeof LOOP_EDGES)[number];
export const LoopEdgeSchema = z.enum(LOOP_EDGES);

export const WakeProgressBodySchema = z.object({
  lease_id: z.string().min(1),
}).strict();
export type WakeProgressBody = z.infer<typeof WakeProgressBodySchema>;
```

Barrel `packages/protocol/src/index.ts` already `export * from './residency.js'` — no edit.

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/src/residency.test.ts`:

```ts
import {
  LOOP_EDGES,
  LoopEdgeSchema,
  WakeProgressBodySchema,
} from './residency.js';

describe('LOOP_EDGES (ADR NNN)', () => {
  it('is exactly the three work-order edges', () => {
    expect([...LOOP_EDGES]).toEqual(['review', 'dispatch_handoff', 'dispatch_continuation']);
  });

  it('rejects inbox derivations as edges', () => {
    expect(LoopEdgeSchema.safeParse('work_order').success).toBe(false);
    expect(LoopEdgeSchema.safeParse('batched').success).toBe(false);
    expect(LoopEdgeSchema.safeParse('immediate').success).toBe(false);
  });
});

describe('WakeProgressBodySchema (ADR NNN)', () => {
  it('accepts { lease_id } and nothing else', () => {
    expect(WakeProgressBodySchema.parse({ lease_id: '01KZY20ZRJ0SBH8WJ3CTFPKDP3' })).toEqual({
      lease_id: '01KZY20ZRJ0SBH8WJ3CTFPKDP3',
    });
  });

  it('rejects missing lease_id, empty, and extra keys', () => {
    expect(WakeProgressBodySchema.safeParse({}).success).toBe(false);
    expect(WakeProgressBodySchema.safeParse({ lease_id: '' }).success).toBe(false);
    expect(WakeProgressBodySchema.safeParse({ lease_id: 'L1', spawned: true }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @musterd/protocol exec vitest run src/residency.test.ts
```

Expected: FAIL — `LOOP_EDGES is not exported` / `WakeProgressBodySchema is not exported`.

- [ ] **Step 3: Minimal implementation**

In `packages/protocol/src/residency.ts`, immediately after `WakeDerivationSchema`:

```ts
/** Work-order board edges (ADR NNN). Inbox wakes are not edges — they keep edge NULL on the lease. */
export const LOOP_EDGES = ['review', 'dispatch_handoff', 'dispatch_continuation'] as const;
export type LoopEdge = (typeof LOOP_EDGES)[number];
export const LoopEdgeSchema = z.enum(LOOP_EDGES);

/** Body of `POST /teams/:slug/residency/wake-progress` — presence of the POST means spawned.
 *  Does not settle the lease. Extra keys rejected (this is not wake-report). */
export const WakeProgressBodySchema = z.object({ lease_id: z.string().min(1) }).strict();
export type WakeProgressBody = z.infer<typeof WakeProgressBodySchema>;
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter @musterd/protocol exec vitest run src/residency.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/residency.ts packages/protocol/src/residency.test.ts
git commit -m "$(cat <<'EOF'
protocol: LOOP_EDGES + WakeProgressBodySchema

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 3: Migration — `edge` + `spawned_at`

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (append after the current last version; tip on 2026-08-13 is **39**, so this is **40** unless `main` moved — use `max(version)+1`)
- Test: add a focused case in `packages/server/src/store/residency.test.ts` (or a migrations test if one already asserts `pragma_table_info('wake_leases')`; prefer residency.test.ts so later tasks share `seed()`)

**Interfaces:**
- Consumes: `WakeLeaseRow` will grow in Task 4. This task only adds columns.
- Produces: columns `edge TEXT` and `spawned_at INTEGER` on `wake_leases`, plus `CREATE INDEX IF NOT EXISTS idx_wake_leases_edge ON wake_leases(team_id, lane_id, edge)`.

- [ ] **Step 1: Write the failing test**

In `packages/server/src/store/residency.test.ts`, new describe:

```ts
describe('wake_leases edge + spawned_at (ADR NNN)', () => {
  it('migration adds nullable edge and spawned_at', () => {
    const { db } = seed();
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('wake_leases')")
      .pluck()
      .all() as string[];
    expect(cols).toContain('edge');
    expect(cols).toContain('spawned_at');
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @musterd/server exec vitest run src/store/residency.test.ts
```

Expected: FAIL — `edge` / `spawned_at` not in columns.

- [ ] **Step 3: Add the migration**

Append to `MIGRATIONS` in `packages/server/src/db/migrations.ts` (replace `40` if tip moved):

```ts
{
  // ADR NNN: per-edge firing ledger. `edge` is the work-order board edge (review /
  // dispatch_handoff / dispatch_continuation); NULL on inbox wakes. `spawned_at` is the host
  // exec ack (POST wake-progress). Do not backfill — inferring edge from act shape is the
  // ADR 250 measurement trap.
  version: 40,
  up: (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('wake_leases')").pluck().all();
    if (!cols.includes('edge')) db.exec('ALTER TABLE wake_leases ADD COLUMN edge TEXT');
    if (!cols.includes('spawned_at'))
      db.exec('ALTER TABLE wake_leases ADD COLUMN spawned_at INTEGER');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_wake_leases_edge ON wake_leases(team_id, lane_id, edge)',
    );
  },
},
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter @musterd/server exec vitest run src/store/residency.test.ts
```

Expected: PASS (existing claimWakeLeases tests still insert — SQLite ADD COLUMN is nullable, old INSERT lists columns explicitly so they keep working until Task 4 extends the INSERT).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/migrations.ts packages/server/src/store/residency.test.ts
git commit -m "$(cat <<'EOF'
server: wake_leases edge + spawned_at columns

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 4: Stamp `edge` at lease insert

**Files:**
- Modify: `packages/server/src/store/residency.ts` (`WakeLeaseRow`, `claimWakeLeases` INSERT, `residency.wake_leased` detail)
- Modify: `packages/server/src/store/residency.test.ts`
- Modify: `packages/server/src/presence/reaper.ts` (add `edge` to expiry detail)

**Interfaces:**
- Consumes: `LoopEdge` from `@musterd/protocol`; `candidate.work_order_kind` (`'review' | 'dispatch'`) already on `WakeCandidate`.
- Produces: `WakeLeaseRow.edge: string | null`, `WakeLeaseRow.spawned_at: number | null`. Mapping:

```
work_order_kind === 'review'                    → 'review'
work_order_kind === 'dispatch' && act_id set    → 'dispatch_handoff'
work_order_kind === 'dispatch' && act_id absent → 'dispatch_continuation'
else                                            → null
```

Helper (same file, next to `composeWorkOrderLine`):

```ts
function loopEdgeOf(candidate: WakeCandidate): LoopEdge | null {
  if (candidate.derivation !== 'work_order') return null;
  if (candidate.work_order_kind === 'review') return 'review';
  if (candidate.work_order_kind === 'dispatch') {
    return candidate.act_id ? 'dispatch_handoff' : 'dispatch_continuation';
  }
  return null;
}
```

- [ ] **Step 1: Write the failing tests**

Append in `residency.test.ts` after the existing ADR 191/199 work_order describes. Reuse `seed`, `enroll`, `msg`, `setPolicy`, `openLane`/`updateLane` exactly as those tests do.

```ts
describe('claimWakeLeases — stamps loop edge (ADR NNN)', () => {
  it('review work_order stamps edge=review on the lease and the audit', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'a change', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
    });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    const row = db
      .prepare('SELECT edge, spawned_at FROM wake_leases WHERE id = ?')
      .get(orders[0]!.lease_id) as { edge: string | null; spawned_at: number | null };
    expect(row.edge).toBe('review');
    expect(row.spawned_at).toBeNull();
    const leased = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_leased');
    expect(JSON.parse(leased[0]!.detail as string)).toMatchObject({
      edge: 'review',
      lane_id: lane.id,
    });
  });

  it('dispatch handoff stamps dispatch_handoff; continuation stamps dispatch_continuation', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const handed = openLane(db, team.id, team.slug, nick.name, { title: 'h', claim: true });
    updateLane(db, team.id, handed.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: handed.id, branch: 'feat/x' } },
    });
    const handoffOrders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    const handoffRow = db
      .prepare('SELECT edge FROM wake_leases WHERE id = ?')
      .get(handoffOrders[0]!.lease_id) as { edge: string };
    expect(handoffRow.edge).toBe('dispatch_handoff');

    // settle so the next poll can lease continuation on a different lane
    db.prepare("UPDATE wake_leases SET status = 'reported' WHERE id = ?").run(
      handoffOrders[0]!.lease_id,
    );
    const cont = openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
    const contOrders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    const contLease = contOrders.find((o) => o.lane_id === cont.id);
    expect(contLease).toBeTruthy();
    const contRow = db
      .prepare('SELECT edge FROM wake_leases WHERE id = ?')
      .get(contLease!.lease_id) as { edge: string };
    expect(contRow.edge).toBe('dispatch_continuation');
  });

  it('inbox wakes leave edge NULL', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'request_help', 'r1', 1_000);
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.length).toBeGreaterThan(0);
    const row = db
      .prepare('SELECT edge FROM wake_leases WHERE id = ?')
      .get(orders[0]!.lease_id) as { edge: string | null };
    expect(row.edge).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @musterd/server exec vitest run src/store/residency.test.ts
```

Expected: FAIL — `edge` is null on work_order leases (INSERT does not set it).

- [ ] **Step 3: Stamp at insert**

1. Extend `WakeLeaseRow`:

```ts
export interface WakeLeaseRow {
  id: string;
  team_id: string;
  member_id: string;
  act_id: string | null;
  lane_id: string | null;
  host: string;
  lane: string;
  status: string;
  created_at: number;
  expires_at: number;
  edge: string | null;
  spawned_at: number | null;
}
```

2. Add `loopEdgeOf` as above.

3. In `claimWakeLeases`, when building `lease`, set `edge: loopEdgeOf(candidate)` and `spawned_at: null`. Extend the INSERT column list and `appendAudit` detail:

```ts
...(edge !== null ? { edge } : {}),
```

`SELECT *` already used by `liveLease` / `settleWakeLease` / `expireWakeLeases` will pick up the new columns once they exist.

4. In `packages/server/src/presence/reaper.ts`, spread `...(lease.edge ? { edge: lease.edge } : {})` into `detail` (both the deferred and failed branches).

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter @musterd/server exec vitest run src/store/residency.test.ts src/presence/reaper.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/residency.ts packages/server/src/store/residency.test.ts packages/server/src/presence/reaper.ts
git commit -m "$(cat <<'EOF'
server: stamp work-order edge on wake_leases

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 5: `markWakeSpawned` + `POST …/wake-progress`

**Files:**
- Modify: `packages/server/src/store/residency.ts` (new function)
- Modify: `packages/server/src/store/residency.test.ts`
- Modify: `packages/server/src/transport/http.ts` (new route next to `wake-report` / `wake-turn`)
- Modify: `packages/server/src/transport/residency-http.test.ts`

**Interfaces:**
- Consumes: `WakeProgressBodySchema` from `@musterd/protocol`.
- Produces:

```ts
/** Stamp spawned_at if null. Returns the lease row, or null if unknown id. Never settles. */
export function markWakeSpawned(
  db: Database,
  teamId: string,
  leaseId: string,
  now = Date.now(),
): WakeLeaseRow | null
```

HTTP: `POST /teams/:slug/residency/wake-progress`, `authAgentKeyOnly`, parse `WakeProgressBodySchema`, 404 if null, else `{ ok: true, lease_id, spawned_at }`.

- [ ] **Step 1: Write the failing store tests**

```ts
describe('markWakeSpawned (ADR NNN)', () => {
  it('stamps spawned_at, does not settle, is idempotent,  null on unknown', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { markWakeSpawned } = await import('./residency.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'a change', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
    });
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    const first = markWakeSpawned(db, team.id, order!.lease_id, 1_700_000_000_000);
    expect(first!.status).toBe('leased');
    expect(first!.spawned_at).toBe(1_700_000_000_000);
    const second = markWakeSpawned(db, team.id, order!.lease_id, 1_700_000_000_999);
    expect(second!.spawned_at).toBe(1_700_000_000_000); // first stamp wins
    expect(markWakeSpawned(db, team.id, 'nope')).toBeNull();

    settleWakeLease(db, team.id, order!.lease_id);
    const afterSettle = markWakeSpawned(db, team.id, order!.lease_id, 1_800_000_000_000);
    expect(afterSettle!.status).toBe('reported');
    expect(afterSettle!.spawned_at).toBe(1_700_000_000_000); // already set; settle-then-progress is a no-op stamp
  });

  it('after settle with null spawned_at, progress still stamps', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { markWakeSpawned } = await import('./residency.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'a change', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
    });
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    settleWakeLease(db, team.id, order!.lease_id);
    const stamped = markWakeSpawned(db, team.id, order!.lease_id, 42);
    expect(stamped!.status).toBe('reported');
    expect(stamped!.spawned_at).toBe(42);
  });
});
```

- [ ] **Step 2: Run store tests to verify fail**

```bash
pnpm --filter @musterd/server exec vitest run src/store/residency.test.ts
```

Expected: FAIL — `markWakeSpawned is not exported`.

- [ ] **Step 3: Implement `markWakeSpawned`**

```ts
export function markWakeSpawned(
  db: Database,
  teamId: string,
  leaseId: string,
  now = Date.now(),
): WakeLeaseRow | null {
  const row = db
    .prepare<[string, string], WakeLeaseRow>(
      'SELECT * FROM wake_leases WHERE team_id = ? AND id = ?',
    )
    .get(teamId, leaseId);
  if (!row) return null;
  if (row.spawned_at === null) {
    db.prepare('UPDATE wake_leases SET spawned_at = ? WHERE id = ?').run(now, row.id);
    row.spawned_at = now;
  }
  return row;
}
```

- [ ] **Step 4: Store tests pass**

```bash
pnpm --filter @musterd/server exec vitest run src/store/residency.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing HTTP tests**

In `packages/server/src/transport/residency-http.test.ts`, after `enrollAda` helper, add a helper that enrolls Ada with `flow: auto`, arms `loops.review`, opens a ready lane with a `lane_review` ask, then polls `wake-leases` so a lease exists. Follow existing `post(..., agentKey)` style.

```ts
describe('POST /teams/:slug/residency/wake-progress (ADR NNN)', () => {
  it('stamps spawned_at, does not settle, idempotent, 404 unknown, agent-key auth', async () => {
    // ... enroll + arm review + create unanswered lane_review ask + POST wake-leases ...
    const leased = await post('/teams/dawn/residency/wake-leases', { host: 'laptop.local' }, agentKey);
    expect(leased.status).toBe(200);
    const leaseId = leased.json.orders[0].lease_id as string;

    const unauth = await post('/teams/dawn/residency/wake-progress', { lease_id: leaseId });
    expect(unauth.status).toBe(401);

    const first = await post(
      '/teams/dawn/residency/wake-progress',
      { lease_id: leaseId },
      agentKey,
    );
    expect(first.status).toBe(200);
    expect(first.json.ok).toBe(true);
    expect(first.json.lease_id).toBe(leaseId);
    expect(typeof first.json.spawned_at).toBe('number');

    const again = await post(
      '/teams/dawn/residency/wake-progress',
      { lease_id: leaseId },
      agentKey,
    );
    expect(again.status).toBe(200);
    expect(again.json.spawned_at).toBe(first.json.spawned_at);

    const missing = await post(
      '/teams/dawn/residency/wake-progress',
      { lease_id: 'nope' },
      agentKey,
    );
    expect(missing.status).toBe(404);

    const report = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true, session: 'fresh' },
      agentKey,
    );
    expect(report.status).toBe(200);
    // lease settled as reported — progress did not consume that
  });
});
```

Fill the enroll/ask setup by copying the working pattern from any existing test in this file that already POSTs `wake-leases` (search `wake-leases`). If none exists, compose it from `residency.test.ts`'s review-loop setup via HTTP: enroll with policy override `{ flow: 'auto' }`, `PATCH` team policy `{ loops: { review: true } }` if that route exists — otherwise `setPolicy` on `server.db` directly (the test file already imports `getTeamBySlug` and has `server.db`).

Prefer `setPolicy(server.db, team.id, { loops: { review: true } })` plus the existing enroll POST, then insert the ask via the messages route or `insertMessage` on `server.db`. Direct store setup on `server.db` is allowed here: the assertion is the HTTP progress contract, not the derivation.

- [ ] **Step 6: Run HTTP tests to verify fail**

```bash
pnpm --filter @musterd/server exec vitest run src/transport/residency-http.test.ts
```

Expected: FAIL — 404 on the new path (no route).

- [ ] **Step 7: Add the route in `http.ts`**

Next to the `wake-report` / `wake-turn` block. Imports: `WakeProgressBodySchema`, `markWakeSpawned`.

```ts
if (method === 'POST' && rest === '/residency/wake-progress') {
  const team = authAgentKeyOnly(ctx, slug, req);
  const body = parseOrBadRequest(WakeProgressBodySchema, await readJson(req));
  const row = markWakeSpawned(ctx.db, team.id, body.lease_id);
  if (!row) throw new MusterdError('not_found', `no wake lease "${body.lease_id}" on ${slug}`);
  return sendJson(res, 200, {
    ok: true,
    lease_id: row.id,
    spawned_at: row.spawned_at,
  });
}
```

Also on the `wake-report` audit `detail` object, spread `...(lease.edge ? { edge: lease.edge } : {})` so later skip-reads can join failures to an edge. Same for the supplementary cost branch if it has a lease row.

- [ ] **Step 8: HTTP tests pass**

```bash
pnpm --filter @musterd/server exec vitest run src/transport/residency-http.test.ts src/store/residency.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/store/residency.ts packages/server/src/store/residency.test.ts packages/server/src/transport/http.ts packages/server/src/transport/residency-http.test.ts
git commit -m "$(cat <<'EOF'
server: POST /residency/wake-progress stamps spawned_at

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 6: Router skip — still-true + spend breaker

**Files:**
- Modify: `packages/server/src/store/residency.ts` (`claimWakeLeases` candidate loop, new helpers + `WORK_ORDER_EDGE_BREAKER_N`)
- Modify: `packages/server/src/store/residency.test.ts`

**Interfaces:**
- Consumes: `LoopEdge`, stamped `edge` on leases, `detail.edge` + `detail.wakeability` on `residency.wake_failed`.
- Produces:

```ts
export const WORK_ORDER_EDGE_BREAKER_N = 3;

export const STILL_TRUE_WAKEABILITIES: readonly string[] = [
  'enrolled_dead_workspace',
  'not_enrolled',
];
```

Inside the `for (const candidate of candidates)` loop in `claimWakeLeases`, **after** the existing exhaustion/attempt_cap checks, **before** INSERT:

```ts
const edge = loopEdgeOf(candidate);
if (edge && candidate.lane_id) {
  if (workOrderEdgeFailureCount(db, teamId, candidate.lane_id, edge) >= WORK_ORDER_EDGE_BREAKER_N) {
    appendAudit(db, teamId, {
      actor: null,
      action: 'residency.wake_exhausted',
      target: member.name,
      result: 'deny',
      detail: {
        act: exhKey,
        edge,
        lane_id: candidate.lane_id,
        breaker: true,
        attempts: WORK_ORDER_EDGE_BREAKER_N,
        derivation: candidate.derivation,
      },
    });
    continue;
  }
  if (workOrderEdgeStillTrue(db, teamId, candidate.lane_id, edge)) continue;
}
```

```ts
function workOrderEdgeFailureCount(
  db: Database,
  teamId: string,
  laneId: string,
  edge: LoopEdge,
): number {
  const row = db
    .prepare<[string, string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'residency.wake_failed'
          AND json_extract(detail, '$.lane_id') = ?
          AND json_extract(detail, '$.edge') = ?`,
    )
    .get(teamId, laneId, edge);
  return row?.n ?? 0;
}

function workOrderEdgeStillTrue(
  db: Database,
  teamId: string,
  laneId: string,
  edge: LoopEdge,
): boolean {
  const row = db
    .prepare<[string, string, string], { detail: string }>(
      `SELECT detail FROM audit
        WHERE team_id = ? AND action = 'residency.wake_failed'
          AND json_extract(detail, '$.lane_id') = ?
          AND json_extract(detail, '$.edge') = ?
        ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(teamId, laneId, edge);
  if (!row) return false;
  let parsed: { wakeability?: string };
  try {
    parsed = JSON.parse(row.detail) as { wakeability?: string };
  } catch {
    return false;
  }
  return (
    parsed.wakeability === 'enrolled_dead_workspace' || parsed.wakeability === 'not_enrolled'
  );
}
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('claimWakeLeases — spend breaker + still-true (ADR NNN)', () => {
  async function reviewDue() {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'a change', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
    });
    return { db, team, ada, lane };
  }

  it('skips when last wake_failed wakeability is enrolled_dead_workspace', async () => {
    const { db, team, lane } = await reviewDue();
    appendAudit(db, team.id, {
      actor: null,
      action: 'residency.wake_failed',
      target: 'Ada',
      result: 'deny',
      detail: {
        act: 'ask1',
        lane_id: lane.id,
        edge: 'review',
        wakeability: 'enrolled_dead_workspace',
      },
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('retries when last failure is lease_expired or enrolled_seat_busy', async () => {
    const { db, team, lane } = await reviewDue();
    appendAudit(db, team.id, {
      actor: null,
      action: 'residency.wake_failed',
      target: 'Ada',
      result: 'deny',
      detail: { act: 'ask1', lane_id: lane.id, edge: 'review', reason: 'lease_expired' },
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(1);
  });

  it('trips after 3 wake_failed on the same edge, not after 3 woke, and not across edges', async () => {
    const { db, team, lane } = await reviewDue();
    for (let i = 0; i < 3; i++) {
      appendAudit(db, team.id, {
        actor: null,
        action: 'residency.wake_failed',
        target: 'Ada',
        result: 'deny',
        detail: { act: `ask${i}`, lane_id: lane.id, edge: 'review', reason: 'lease_expired' },
      });
    }
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
    const exhausted = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_exhausted');
    expect(JSON.parse(exhausted.at(-1)!.detail as string)).toMatchObject({
      breaker: true,
      edge: 'review',
    });
  });

  it('three woke on dispatch_continuation still derive', async () => {
    const { openLane } = await import('./lanes.js');
    const { db, team, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
    for (let i = 0; i < 3; i++) {
      appendAudit(db, team.id, {
        actor: null,
        action: 'residency.woke',
        target: 'Ada',
        result: 'allow',
        detail: { act: `lane:${lane.id}`, lane_id: lane.id, edge: 'dispatch_continuation' },
      });
    }
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.some((o) => o.lane_id === lane.id)).toBe(true);
  });

  it('review failures do not trip dispatch_handoff on the same lane', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true, dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'h', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
    for (let i = 0; i < 3; i++) {
      appendAudit(db, team.id, {
        actor: null,
        action: 'residency.wake_failed',
        target: 'Ada',
        result: 'deny',
        detail: { lane_id: lane.id, edge: 'review', reason: 'lease_expired' },
      });
    }
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: lane.id, branch: 'feat/x' } },
    });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.some((o) => o.act_id === 'h1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @musterd/server exec vitest run src/store/residency.test.ts
```

Expected: FAIL — still-true / breaker cases still lease.

- [ ] **Step 3: Implement the skip in `claimWakeLeases`**

Paste the helpers and the `if (edge && candidate.lane_id)` block from **Interfaces** above. Import `LoopEdge` from `@musterd/protocol` at the top of `residency.ts` (file-top import, never inline).

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter @musterd/server exec vitest run src/store/residency.test.ts
```

Expected: PASS. If the "retries lease_expired" case fails because attempt_cap / cooldown from the synthetic `wake_failed` row blocks derivation, stop using `wakeOutcomeRow`'s act-keyed rate policy: the skip helpers read `detail.lane_id`+`edge`, while `wakesSince` counts any `wake_failed` for the seat. Use `appendAudit` as written (it **does** count toward hourly/attempt caps). If that makes the retry test lease-empty, backdate the failure with `ts: Date.now() - WAKE_COOLDOWN_MS - 1` via the same UPDATE pattern `wakeOutcomeRow` uses, **or** raise `hourly_cap` / `attempt_cap` on the enrollment override for that test (`enroll(..., { flow: 'auto', attempt_cap: 10, hourly_cap: 10 })`). Prefer the enrollment override so the test is about the skip, not the rate window.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/residency.ts packages/server/src/store/residency.test.ts
git commit -m "$(cat <<'EOF'
server: skip work-order re-wake on still-true failure or edge breaker

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 7: Host posts progress after spawn

**Files:**
- Modify: `packages/cli/src/client.ts` (`wakeProgress`)
- Modify: `packages/cli/src/host/loop.ts` (`WakeClient` + call site)
- Modify: `packages/cli/src/host/loop.test.ts`

**Interfaces:**
- Consumes: `WakeProgressBody` from `@musterd/protocol`.
- Produces:

`HttpClient.wakeProgress(slug, { lease_id })` → `POST /teams/${slug}/residency/wake-progress`.

`WakeClient` grows `wakeProgress(team: string, leaseId: string): Promise<unknown>`.

In `pollHostOnce`, after `const actuation = await backend.wake(...)` and **before** `await report(actuation.outcome)`:

```ts
if (!actuation.outcome.deferred) {
  await client.wakeProgress(group.team, order.lease_id).catch((err: Error) =>
    deps.log(`! wake-progress failed for lease ${order.lease_id}: ${err.message}`),
  );
}
```

Do **not** call it on the pre-`backend.wake` branches (missing registry, missing backend, local-session defer). Those never exec a child.

Invariant: backends must mark no-spawn outcomes `deferred: true` (already true for "claude not found"). Spawn-then-fail is `occupied: false` without `deferred` → progress **is** posted (the child ran).

- [ ] **Step 1: Extend the fake client and write failing tests**

In `loop.test.ts`, extend `FakeCalls` and `fakeClient`:

```ts
interface FakeCalls {
  leases: { team: string; host: string }[];
  reports: WakeReportBody[];
  progress: string[];
  rosters: number;
}

function fakeClient(...) {
  const calls: FakeCalls = { leases: [], reports: [], progress: [], rosters: 0 };
  const client: WakeClient = {
    // existing wakeLeases / wakeReport / roster ...
    wakeProgress: async (_team, leaseId) => {
      calls.progress.push(leaseId);
      return { ok: true };
    },
  };
  return { client, calls };
}
```

Add cases (follow neighboring `it(` style in this file):

```ts
it('posts wake-progress after a spawn, before the outcome report', async () => {
  const { client, calls } = fakeClient([order({ derivation: 'work_order', lane_id: 'L' })]);
  const { backend } = fakeBackend();
  await pollHostOnce({
    // copy deps from an existing successful-spawn test in this file
  });
  expect(calls.progress).toEqual(['L1']);
  expect(calls.reports.length).toBeGreaterThan(0);
});

it('does not post progress on local-session defer or missing registry', async () => {
  // copy the existing defer / missing-entry tests' deps; assert calls.progress is []
});

it('a failed wake-progress still reports the outcome', async () => {
  const { client, calls } = fakeClient([order()]);
  const orig = client.wakeProgress;
  client.wakeProgress = async () => {
    calls.progress.push('threw');
    throw new Error('daemon old');
  };
  void orig;
  await pollHostOnce(/* successful spawn deps */);
  expect(calls.reports.length).toBeGreaterThan(0);
});
```

Copy the `pollHostOnce` deps object from the nearest existing test (`registry: [entryOf()]`, `backends: new Map([['claude-code', backend]])`, `log: () => {}`, `clientFor: () => client`). Do not invent a new deps shape.

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @musterd/cli exec vitest run src/host/loop.test.ts
```

Expected: FAIL — `wakeProgress` missing on `WakeClient` / never called.

- [ ] **Step 3: Implement client + loop**

`packages/cli/src/client.ts` next to `wakeReport`:

```ts
async wakeProgress(
  slug: string,
  body: { lease_id: string },
): Promise<{ ok: boolean; lease_id: string; spawned_at: number | null }> {
  return (await this.request('POST', `/teams/${slug}/residency/wake-progress`, body)) as {
    ok: boolean;
    lease_id: string;
    spawned_at: number | null;
  };
}
```

Import type `WakeProgressBody` if you want the arg typed; `{ lease_id: string }` is enough.

`packages/cli/src/host/loop.ts`: add `wakeProgress` to `WakeClient`; insert the `if (!actuation.outcome.deferred)` block from **Interfaces**.

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter @musterd/cli exec vitest run src/host/loop.test.ts
```

Expected: PASS. Typecheck will fail any other `WakeClient` stub — grep `wakeReport:` under `packages/cli` and add `wakeProgress: async () => ({})` to each fake.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/client.ts packages/cli/src/host/loop.ts packages/cli/src/host/loop.test.ts
git commit -m "$(cat <<'EOF'
cli: host acks spawn via wake-progress

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 8: ADR body + living docs

**Files:**
- Modify: `docs/decisions/NNN-per-edge-firing-ledger.md` (replace stub; fill Context / Problem / Decision / Consequences / Observability — do **not** leave "reserved")
- Modify: `docs/architecture/02-protocol.md` (add the progress route to the HTTP table; one paragraph under the wake schemas)
- Modify: `docs/architecture/03-server.md` (`residency.ts` tree line: mention edge stamp, `markWakeSpawned`, spend breaker)
- Modify: `docs/architecture/04-cli.md` (`loop.ts` line: progress after spawn; `client.ts` line: `wakeProgress`)
- Modify: `docs/superpowers/specs/2026-08-13-per-edge-firing-ledger-design.md` (status: implementing, ADR NNN)

**Interfaces:**
- Consumes: every Decision locked in the spec. Lift O&E verbatim from the spec's Observability section.
- Produces: accepted-quality ADR (`obs-evals:check` requires `## Observability & Evaluation` with Traces / Eval / Experiment). Status stays `proposed` until merge if that is the house rule for in-flight ADRs; otherwise `accepted` at land. Match neighboring in-flight ADRs on this branch's `main` (quiet-set used `accepted` at merge). Write it as `accepted` with Date 2026-08-13 — squash-merge is the land.

- [ ] **Step 1: Write the ADR Decision (frozen once accepted)**

Decision sections, in order, matching the spec:

1. Edges (`LOOP_EDGES`); inbox NULL
2. Columns `edge` + `spawned_at`; no `delivered_at`; no backfill
3. `POST …/wake-progress` `{lease_id}`; does not settle; not `wake-report`
4. Router skip: still-true closed set; breaker = 3 `wake_failed` on that edge; `wake_exhausted` + `detail.breaker`; no human ask; continuation `woke` does not count
5. Host: progress after exec; `deferred` outcomes skip it; failure non-fatal
6. Out of scope list from the spec

Include the continuation clarification in Decision so it is frozen.

- [ ] **Step 2: Architecture one-liners**

`03-server.md` `residency.ts` line — append: `edge+spawned_at (ADR NNN); markWakeSpawned; claimWakeLeases skips still-true wakeability / WORK_ORDER_EDGE_BREAKER_N failed edges`.

`04-cli.md` `loop.ts` line — append: `; wake-progress after spawn (not on deferred)`.

`02-protocol.md` HTTP table — add:

`POST /teams/:slug/residency/wake-progress` | `{ lease_id }` | `{ ok, lease_id, spawned_at }` | host exec ack; does not settle (ADR NNN)

- [ ] **Step 3: `pnpm format:check` (includes `obs-evals:check` + `arch-trees:check` + `vocab:check`)**

```bash
pnpm typecheck && pnpm format:check
```

Expected: PASS. If `obs-evals:check` complains, the ADR is missing a Traces/Eval/Experiment heading. If `vocab:check` flags the spec/ADR, backtick the banned word or rephrase.

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/NNN-per-edge-firing-ledger.md docs/architecture/02-protocol.md docs/architecture/03-server.md docs/architecture/04-cli.md docs/superpowers/specs/2026-08-13-per-edge-firing-ledger-design.md
git commit -m "$(cat <<'EOF'
docs: ADR NNN per-edge firing ledger + living docs

Refs ADR-NNN

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

- [ ] **Step 5: Mark the PR ready (do not poll CI)**

```bash
git push
gh pr ready
gh pr merge --squash --auto --delete-branch
```

Only after Task 3–7 are on the branch. Auto-merge waits for `gates`. Walk away.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
| ---------------- | ---- |
| Work-order edges only; inbox NULL | 2, 4 |
| `edge` + `spawned_at`; no `delivered_at`; no backfill | 3, 4 |
| New progress route, not `wake-report` | 2, 5 |
| Router skip still-true | 6 |
| Breaker = 3 **failures**, not `woke`, not `ready_for_review`; continuation lives | 6 (spec correction) |
| `wake_exhausted` + `detail.breaker`; no human ask | 6 |
| Host progress after exec; non-fatal; not on defer | 7 |
| Old host / null `spawned_at` still derives | 4 (stamp only) + 6 (breaker reads audit, not spawned_at) |
| ADR + living docs | 1 (reserve), 8 (body) |
| `review.ts` untouched | file map |

No TBD/TODO left in tasks. `NNN` is the Task 1 output, substituted everywhere.
