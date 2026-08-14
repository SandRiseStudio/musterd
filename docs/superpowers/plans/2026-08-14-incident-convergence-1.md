# Incident Convergence — Increment 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task (musterd seats execute inline in their own lane — no writing subagents).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When ≥2 distinct seats report the same red gate via `meta.blocked_by` on `status_update`,
the daemon auto-opens a `kind:'incident'` lane, appends later reports to it, auto-replies to
duplicate reporters, and `team_next` leads with a banner — no wakes, no config block.

**Architecture:** A `BlockedBy` meta contract in `@musterd/protocol`; a v41 migration adding
`lanes.kind` and an `incident_reports` table; a new `packages/server/src/store/incidents.ts` store
module holding all clustering logic; one best-effort hook in `routeEnvelope` after `insertMessage`
(the same seam `recordAskLifecycle` uses); `NextBrief.incidents` threaded through `deriveNext` and
rendered first in `fmtNext`.

**Tech Stack:** TypeScript, zod, better-sqlite3, vitest 3 (`:memory:` db unit tests), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-14-incident-convergence-design.md` (commit `d877e464`,
branch `spec/incident-convergence`). Lane: `01M00PNG2Q0JZFEVH53PKAPKH1`.

## Global Constraints

- Increment 1 only: cluster + incident lane + banner + auto-reply. **No wakes, no claim window, no
  fallback-role routing, no `incident` policy block** (those are increment 2, spec §Increments).
- Cluster key is `blocked_by.gate`, **exact string match only**; `sig` is never matched on (spec §1).
- Cluster threshold is a hardcoded constant `CLUSTER_THRESHOLD = 2` **distinct seats** (config knob
  arrives in increment 2).
- One open incident per `(team, gate)`: reports matching an open incident append, never open a second.
- All daemon-side incident work is best-effort: wrapped in try/catch, a failure must never fail the
  `status_update` that carried the report (mirror `fireGatedHumanAsk` at
  `packages/server/src/protocol/route.ts:322-327`).
- Audit detail carries shapes, never bodies (ADR 051); free text truncated to 500 chars.
- Migration is **v41**, appended to `MIGRATIONS`; never edit `SCHEMA_V1_SQL` in
  `packages/server/src/db/schema.ts`.
- `@musterd/protocol` changes require `pnpm -r build` before sibling packages resolve them.
- Coverage floors (CI-enforced, `pnpm coverage`): protocol 95 / server 85 / mcp 75 lines.
- **Plan decision (spec §4 deviation, recorded here):** the session-start primer (`renderPrimer`) is
  pure and returned on every MCP initialize including health probes, so it cannot carry a dynamic
  "open incident" banner. Increment 1 puts the dynamic banner in `team_next` only, and adds the
  spec §1 *static* guidance line to the primer. Revisit dynamic primer delivery in increment 2 if
  the eval shows sessions still start blind.

**Branch setup (before Task 1):** from `/Users/nick/agents-miley` (detached at main):

```bash
git checkout -b feat/incident-convergence-1 origin/main
git cherry-pick d877e464   # the spec travels with the implementation
```

---

### Task 1: `BlockedBy` protocol contract

**Files:**
- Create: `packages/protocol/src/incident.ts`
- Create: `packages/protocol/src/incident.test.ts`
- Modify: `packages/protocol/src/envelope.ts` (inside `actMetaRules`, line ~89; use the
  `ask_outcome` block at lines 179-215 as the template for a conditional meta rule)
- Modify: `packages/protocol/src/index.ts` (add `export * from './incident.js';` beside the
  `./loops.js` export at line 13)

**Interfaces:**
- Produces: `BlockedBySchema`, `type BlockedBy = { gate: string; ref?: string; sig?: string }`,
  `blockedByOf(meta: Record<string, unknown> | null | undefined): BlockedBy | null`
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** in `packages/protocol/src/incident.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BlockedBySchema, blockedByOf } from './incident.js';
import { EnvelopeSchema, makeEnvelope } from './envelope.js';

describe('BlockedBy', () => {
  it('parses gate-only and full shapes', () => {
    expect(BlockedBySchema.parse({ gate: 'ci:gates/A11y contrast' }).gate).toBe(
      'ci:gates/A11y contrast',
    );
    const full = BlockedBySchema.parse({
      gate: 'ci:gates/A11y contrast',
      ref: 'pr#828',
      sig: 'lc-office__caption /office-preview 2.83',
    });
    expect(full.ref).toBe('pr#828');
  });

  it('rejects an empty gate', () => {
    expect(BlockedBySchema.safeParse({ gate: '' }).success).toBe(false);
  });

  it('blockedByOf returns null for absent/malformed meta and the value when valid', () => {
    expect(blockedByOf(null)).toBeNull();
    expect(blockedByOf({})).toBeNull();
    expect(blockedByOf({ blocked_by: { gate: '' } })).toBeNull();
    expect(blockedByOf({ blocked_by: { gate: 'g' } })).toEqual({ gate: 'g' });
  });

  it('envelope validation rejects a malformed blocked_by on any act, accepts a valid one', () => {
    const base = { team: 'revive', from: 'miley', to: 'nick' };
    const bad = makeEnvelope({ ...base, act: 'status_update', body: 'x', meta: { blocked_by: { gate: '' } } });
    expect(EnvelopeSchema.safeParse(bad).success).toBe(false);
    const good = makeEnvelope({ ...base, act: 'status_update', body: 'x', meta: { blocked_by: { gate: 'ci:gates/A11y contrast' } } });
    expect(EnvelopeSchema.safeParse(good).success).toBe(true);
  });
});
```

(If `makeEnvelope`'s input requires more fields — check `envelope.ts:282` — supply them; copy an
existing envelope test's construction from `envelope.test.ts` rather than inventing one.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/protocol/src/incident.test.ts`
Expected: FAIL — module `./incident.js` not found.

- [ ] **Step 3: Implement** `packages/protocol/src/incident.ts`:

```ts
import { z } from 'zod';

/**
 * Incident convergence (increment 1). A seat that hits a red it cannot explain attaches this to
 * the status_update it already sends. `gate` is the cluster key — exact match only (element-level
 * signatures would split one defect into many incidents; check-name granularity is what seats can
 * state identically without coordinating). `sig` rides along for the eventual owner and is never
 * matched on. `ref` is what is parked behind the red.
 */
export const BlockedBySchema = z.object({
  gate: z.string().min(1),
  ref: z.string().min(1).optional(),
  sig: z.string().min(1).optional(),
});
export type BlockedBy = z.infer<typeof BlockedBySchema>;

/** Typed accessor over loose envelope meta (same posture as `eligibleOf`). */
export function blockedByOf(
  meta: Record<string, unknown> | null | undefined,
): BlockedBy | null {
  if (!meta || meta['blocked_by'] === undefined) return null;
  const parsed = BlockedBySchema.safeParse(meta['blocked_by']);
  return parsed.success ? parsed.data : null;
}
```

Then in `actMetaRules` (`envelope.ts:89`) add — validating whenever the key appears, on any act
(same posture as `eligible` at line 154):

```ts
if (meta['blocked_by'] !== undefined) {
  const parsed = BlockedBySchema.safeParse(meta['blocked_by']);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['meta', 'blocked_by'],
      message: 'blocked_by must be { gate: string, ref?, sig? } with a non-empty gate',
    });
  }
}
```

Import `BlockedBySchema` from `./incident.js` at the top of `envelope.ts`, and add
`export * from './incident.js';` to `index.ts`.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/protocol/src/` — expected: PASS (whole protocol dir, to catch
envelope regressions).

- [ ] **Step 5: Build + commit**

```bash
pnpm -r build
git add packages/protocol/src/incident.ts packages/protocol/src/incident.test.ts packages/protocol/src/envelope.ts packages/protocol/src/index.ts
git commit -m "protocol: blocked_by meta contract for incident convergence (spec d877e464 §1)"
```

---

### Task 2: Migration v41 — `lanes.kind` + `incident_reports`

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (append to `MIGRATIONS`; copy the v36
  idempotence-guard shape at lines 718-723)
- Test: `packages/server/src/db/migrations.test.ts` (add cases beside existing ones; if per-version
  cases don't exist there, assert via `runMigrations` + `pragma_table_info` as below)

**Interfaces:**
- Produces: nullable `lanes.kind TEXT` column; `incident_reports` table
  (`id INTEGER PK AUTOINCREMENT, team_id TEXT NOT NULL, gate TEXT NOT NULL, seat TEXT NOT NULL,
  sig TEXT, ref TEXT, message_id TEXT, lane_id TEXT, created_at INTEGER NOT NULL`) with index
  `idx_incident_reports_team_gate(team_id, gate)`.

- [ ] **Step 1: Write the failing test:**

```ts
it('v41 adds lanes.kind and the incident_reports table', () => {
  const db = openDb(':memory:'); // runMigrations runs in openDb; if not, call it explicitly
  const laneCols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
  expect(laneCols).toContain('kind');
  const cols = db.prepare("SELECT name FROM pragma_table_info('incident_reports')").pluck().all();
  expect(cols).toEqual(
    expect.arrayContaining(['team_id', 'gate', 'seat', 'sig', 'ref', 'message_id', 'lane_id', 'created_at']),
  );
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/server/src/db/` → FAIL.

- [ ] **Step 3: Implement** — append to `MIGRATIONS`:

```ts
{
  // v41 — incident convergence (spec d877e464): lanes grow a nullable `kind` (null = ordinary
  // lane; 'incident' = daemon-opened shared-blocker lane), and incident_reports records every
  // blocked_by report so clustering counts distinct seats per (team, gate) and duplicate
  // reporters can be answered. lane_id is set once the incident lane opens.
  version: 41,
  up: (db) => {
    const laneCols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
    if (!laneCols.includes('kind')) db.exec('ALTER TABLE lanes ADD COLUMN kind TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS incident_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        gate TEXT NOT NULL,
        seat TEXT NOT NULL,
        sig TEXT,
        ref TEXT,
        message_id TEXT,
        lane_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_incident_reports_team_gate ON incident_reports(team_id, gate);
    `);
  },
},
```

- [ ] **Step 4: Verify** — `pnpm exec vitest run packages/server/src/db/` PASS, then
  `pnpm migrations:check` PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/migrations.ts packages/server/src/db/migrations.test.ts
git commit -m "db: v41 — lanes.kind + incident_reports (incident convergence inc 1)"
```

---

### Task 3: Lane plumbing for `kind`

**Files:**
- Modify: `packages/protocol/src/lanes.ts` — `LaneSchema` (line 138): add
  `kind: z.enum(['incident']).nullable().default(null)`; `OpenLaneSchema` (line 266): add
  `kind: z.enum(['incident']).optional()`.
- Modify: `packages/server/src/store/lanes.ts` — `LaneRow` (line 30): add `kind: string | null`;
  `rowToLane` (line 58): map it (`kind: (row.kind as 'incident' | null) ?? null`); `openLane`
  (line 91): include `kind` in the INSERT column list and values (line 137-141), defaulting null.
- Test: `packages/server/src/store/lanes.test.ts`

**Interfaces:**
- Consumes: v41 column from Task 2.
- Produces: `openLane(db, teamId, teamSlug, createdBy, { title, kind: 'incident', ... })` persists
  and `getLane`/`listLanes` read back `lane.kind === 'incident'`. `kind` is **immutable** — it is
  deliberately absent from `UpdateLaneSchema` and `updateLane`'s UPDATE (note: `updateLane`'s SQL
  at lines 234-239 must NOT be extended; kind never changes after open — state that in a comment on
  the schema field).

- [ ] **Step 1: Failing test** in `lanes.test.ts` (reuse its existing `seed()`-style setup):

```ts
it('kind persists through open and reads back; default is null', () => {
  const lane = openLane(db, team.id, 'revive', 'miley', { title: 'incident: ci:gates/A11y contrast', kind: 'incident', stakes: 'high' });
  expect(lane.kind).toBe('incident');
  expect(getLane(db, team.id, lane.id, 'revive')?.kind).toBe('incident');
  const plain = openLane(db, team.id, 'revive', 'miley', { title: 'ordinary' });
  expect(plain.kind).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/server/src/store/lanes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schema + store changes listed under Files. Follow the `stakes`
  precedent (nullable column, default-on-read) but with `null` as the default, not a string.
- [ ] **Step 4: Verify** — `pnpm exec vitest run packages/server/src/store/ packages/protocol/src/lanes` PASS;
  `pnpm -r build` (protocol changed); `pnpm typecheck`.
- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/lanes.ts packages/server/src/store/lanes.ts packages/server/src/store/lanes.test.ts
git commit -m "lanes: nullable kind column, 'incident' variant (inc 1)"
```

---

### Task 4: Incident store module — clustering, open, append

**Files:**
- Create: `packages/server/src/store/incidents.ts`
- Create: `packages/server/src/store/incidents.test.ts`
- Modify: `packages/server/src/store/audit.ts` — extend `AuditAction` (line 12) with
  `'incident.opened' | 'incident.report_appended' | 'incident.duplicate_replied'`, commented in the
  house style of the `lane.*` block (lines 78-104).

**Interfaces:**
- Consumes: `openLane`, `getLane`, `updateLane`, `listLanes` from `./lanes.js`; `appendAudit` from
  `./audit.js`; `BlockedBy` from `@musterd/protocol`; `LANE_TERMINAL_STATES` from `@musterd/protocol`.
- Produces (route hook in Task 5 consumes exactly this):

```ts
export const CLUSTER_THRESHOLD = 2; // distinct seats; becomes policy in increment 2

export type IncidentOutcome =
  | { kind: 'recorded' }                                   // below threshold, no open incident
  | { kind: 'opened'; lane: Lane }                          // this report tripped the threshold
  | { kind: 'appended'; lane: Lane };                       // matched an open incident (duplicate)

export function recordBlockedReport(
  db: Database,
  teamId: string,
  teamSlug: string,
  seat: string,               // sender.name
  report: BlockedBy,
  messageId: string,
  now?: number,
): IncidentOutcome;

export function openIncidents(db: Database, teamId: string, teamSlug: string): Lane[];

export function incidentReporters(db: Database, teamId: string, laneId: string): string[]; // distinct seats
```

**Behavior (from spec §1-§3, increment-1 subset):**
- Insert the report row always (more refs = better fan-out at resolve).
- Open incident lookup: lanes with `kind='incident'`, title exactly `` `incident: ${gate}` ``, state
  not in `LANE_TERMINAL_STATES`. Title is the derived, deterministic gate key (spec §2 "title
  derived from the gate") — exact-match lookup is safe because the daemon is the only writer.
- If an open incident exists: set the new row's `lane_id`, append one detail line
  `` `${seat}: ${report.sig ?? '(no sig)'}${report.ref ? ` [${report.ref}]` : ''}` `` via
  `updateLane` (read `existing.detail`, concatenate with `\n`), audit `incident.report_appended`,
  return `appended`.
- Else count `SELECT COUNT(DISTINCT seat) FROM incident_reports WHERE team_id=? AND gate=? AND lane_id IS NULL`
  (including the just-inserted row). If `>= CLUSTER_THRESHOLD`: `openLane` with
  `{ title: 'incident: '+gate, kind: 'incident', stakes: 'high', detail: <one line per unresolved report, same format> }`,
  `createdBy` = the seat whose report tripped the threshold; stamp `lane_id` on all matching
  `lane_id IS NULL` rows; audit `incident.opened` with `detail: { gate, reporters: n }`; return
  `opened`. Unowned, no surface globs (diagnosis localizes later, spec §2).
- Else return `recorded`.
- Same seat reporting the same gate twice below threshold: still one distinct seat — no open.

- [ ] **Step 1: Failing tests** in `incidents.test.ts`, copying the `seed()` pattern from
  `gateAsk.test.ts` (`openDb(':memory:')`, `createTeam`, `addMember`):

```ts
const GATE = 'ci:gates/A11y contrast';
const report = (over: Partial<BlockedBy> = {}): BlockedBy => ({ gate: GATE, sig: 'lc 2.83', ref: 'pr#828', ...over });

it('first report records without opening', () => {
  expect(recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1').kind).toBe('recorded');
  expect(openIncidents(db, team.id, 'revive')).toHaveLength(0);
});

it('second distinct seat opens one incident lane, seeded with both sigs', () => {
  recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
  const out = recordBlockedReport(db, team.id, 'revive', 'dolly', report({ ref: 'pr#829', sig: 'lc 2.85' }), 'm2');
  expect(out.kind).toBe('opened');
  const lane = (out as { lane: Lane }).lane;
  expect(lane.kind).toBe('incident');
  expect(lane.stakes).toBe('high');
  expect(lane.title).toBe('incident: ' + GATE);
  expect(lane.detail).toContain('izzo: lc 2.83 [pr#828]');
  expect(lane.detail).toContain('dolly: lc 2.85 [pr#829]');
  expect(incidentReporters(db, team.id, lane.id)).toEqual(expect.arrayContaining(['izzo', 'dolly']));
});

it('same seat twice does not open', () => {
  recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
  expect(recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm2').kind).toBe('recorded');
});

it('third report appends to the open incident, never opens a second', () => {
  recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
  recordBlockedReport(db, team.id, 'revive', 'dolly', report(), 'm2');
  const out = recordBlockedReport(db, team.id, 'revive', 'stanley', report({ sig: 'lc 2.11', ref: 'pr#830' }), 'm3');
  expect(out.kind).toBe('appended');
  expect(openIncidents(db, team.id, 'revive')).toHaveLength(1);
  expect((out as { lane: Lane }).lane.detail).toContain('stanley: lc 2.11 [pr#830]');
});

it('a resolved incident does not absorb new reports — a fresh pair opens a fresh lane', () => {
  recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
  const opened = recordBlockedReport(db, team.id, 'revive', 'dolly', report(), 'm2') as { lane: Lane };
  // drive the lane to a terminal state via the existing lane machinery (see laneClose tests for the call)
  resolveLaneToTerminal(db, team.id, opened.lane.id);
  expect(recordBlockedReport(db, team.id, 'revive', 'miley', report(), 'm3').kind).toBe('recorded');
});

it('different gates cluster independently', () => {
  recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
  expect(recordBlockedReport(db, team.id, 'revive', 'dolly', report({ gate: 'ci:gates/other' }), 'm2').kind).toBe('recorded');
});
```

(`resolveLaneToTerminal` is a test helper: find how `laneClose.authorization.test.ts` moves a lane
to a terminal state and use the same call — do not hand-write SQL for it unless those tests do.)

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/server/src/store/incidents.test.ts` → FAIL.
- [ ] **Step 3: Implement** `incidents.ts` per the Behavior block, plus the three `AuditAction`
  variants. Keep every SQL statement prepared inline in the module, matching `gateAsk.ts` style.
- [ ] **Step 4: Verify** — `pnpm exec vitest run packages/server/src/store/` PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/incidents.ts packages/server/src/store/incidents.test.ts packages/server/src/store/audit.ts
git commit -m "server: incident clustering store — open at 2 distinct seats, append after (inc 1)"
```

---

### Task 5: Route hook — detect reports, auto-reply to duplicates, announce on open

**Files:**
- Modify: `packages/server/src/protocol/route.ts` — new function `handleBlockedReport` near
  `fireGatedHumanAsk` (line 446), called from `routeEnvelopeInner` right beside
  `recordAskLifecycle` (line ~354), guarded `if (!daemonComposed && env.act === 'status_update')`.
- Test: `packages/server/src/transport/integration.test.ts` (full-daemon path) — add an
  `incident convergence` describe block using its existing `createServer({ db, port: 0 })` +
  `authHeaders`/`post` helpers.

**Interfaces:**
- Consumes: `blockedByOf` (Task 1), `recordBlockedReport`/`IncidentOutcome` (Task 4),
  `makeEnvelope`, `routeEnvelope(..., daemonComposed = true)`, `appendAudit`.
- Produces: observable behavior only (messages + audit rows), no new exports.

**Behavior:**
- `blockedByOf(outgoingEnv.meta)` null → return immediately (plain status_updates untouched).
- Call `recordBlockedReport(...)` with `messageId = message.id`.
- On `appended` (duplicate reporter): compose a daemon reply **to the reporter** —
  body `` `already ${lane.owner_seat ? 'owned by ' + lane.owner_seat : 'open (unclaimed)'}, lane ${lane.id} — park behind it.` ``,
  `act: 'message'`, `thread: outgoingEnv.id`, `meta: { incident: { lane: lane.id, gate } }`.
  Sender: the lane's `owner_seat` member row if set, else the lane's `created_by` member row
  (mirror how `fireGatedHumanAsk` resolves and routes as the owner, route.ts:446-519, including its
  envelope-id construction). Route with `routeEnvelope(ctx, team, senderRow, reply, undefined, true)`.
  Audit `incident.duplicate_replied` `{ gate, lane: lane.id }`.
- On `opened`: compose one daemon announcement routed to **each distinct reporter**
  (`incidentReporters`), same sender-resolution rule, body
  `` `incident opened: ${gate} — lane ${lane.id}, unclaimed. If your red matches, park behind it; any seat may claim.` ``
  This reuses the normal delivery path, so live sessions get the existing delivery-hint/relay nudge
  for free (spec §3 "on open: nudge live local sessions") and out seats get inbox rows. No wakes.
- Whole hook wrapped: `try { ... } catch (err) { log.warn({ msg: 'incident_hook_failed', err: String(err) }); }`.
- Recursion bound: daemon-composed envelopes are excluded by the `!daemonComposed` guard, and the
  replies are `act:'message'`, which the hook ignores anyway — both belts, per the precedent note at
  route.ts:441.

- [ ] **Step 1: Failing integration test** (sketch — adapt to the file's existing helpers):

```ts
describe('incident convergence (inc 1)', () => {
  const blocked = (ref: string, sig: string) => ({
    act: 'status_update', body: 'red on a check my diff cannot touch',
    meta: { blocked_by: { gate: 'ci:gates/A11y contrast', ref, sig } },
  });

  it('second reporter opens an incident lane and both reporters are notified', async () => {
    await post('/teams/revive/messages', izzoAuth, { ...blocked('pr#828', 'lc 2.83'), to: '@team' });
    await post('/teams/revive/messages', dollyAuth, { ...blocked('pr#829', 'lc 2.85'), to: '@team' });
    const lanes = await get('/teams/revive/lanes', nickAuth);
    const incident = lanes.find((l) => l.kind === 'incident');
    expect(incident).toBeDefined();
    expect(incident.state).not.toBe('resolved');
    // both reporters have a daemon announcement naming the lane
    const izzoInbox = await get('/teams/revive/inbox', izzoAuth); // use the file's actual inbox read
    expect(JSON.stringify(izzoInbox)).toContain(incident.id);
  });

  it('third reporter gets the park-behind-it auto-reply and no second lane opens', async () => {
    // ...first two as above...
    await post('/teams/revive/messages', stanleyAuth, { ...blocked('pr#830', 'lc 2.11'), to: '@team' });
    const lanes = await get('/teams/revive/lanes', nickAuth);
    expect(lanes.filter((l) => l.kind === 'incident')).toHaveLength(1);
    const stanleyInbox = await get('/teams/revive/inbox', stanleyAuth);
    expect(JSON.stringify(stanleyInbox)).toContain('park behind it');
  });

  it('a status_update without blocked_by changes nothing', async () => {
    await post('/teams/revive/messages', izzoAuth, { act: 'status_update', body: 'shipping', to: '@team' });
    const lanes = await get('/teams/revive/lanes', nickAuth);
    expect(lanes.filter((l) => l.kind === 'incident')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/server/src/transport/integration.test.ts` → FAIL.
- [ ] **Step 3: Implement** `handleBlockedReport` per the Behavior block. Read
  `fireGatedHumanAsk` (route.ts:446-519) first and mirror its member-row resolution, envelope-id
  construction, and best-effort posture exactly.
- [ ] **Step 4: Verify** — integration test PASS, then the whole server package:
  `pnpm exec vitest run packages/server/` PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/server/src/protocol/route.ts packages/server/src/transport/integration.test.ts
git commit -m "server: blocked_by reports cluster into incident lanes; duplicates get park-behind-it reply (inc 1)"
```

---

### Task 6: `team_next` banner

**Files:**
- Modify: `packages/protocol/src/lanes.ts` — `NextBriefSchema` (line 402): add
  `incidents: z.array(z.object({ lane: z.string(), gate: z.string(), owner_seat: z.string().nullable(), opened_at: z.number() })).default([])`.
- Modify: `packages/server/src/store/orientation.ts` — `deriveNext` (line 79): populate
  `incidents` from `openIncidents(db, teamId, teamSlug)` (Task 4), mapping
  `{ lane: l.id, gate: l.title.replace(/^incident: /, ''), owner_seat: l.owner_seat, opened_at: l.created_at }`.
- Modify: `packages/mcp/src/tools/lanes.ts` — `fmtNext` (line 459): immediately after the
  `const lines = ['next — as ' + b.member]` line, render each incident first (mirroring the ADR 233
  "FIRST, above your own work" comment style at 461-470), with the daemon-skew `?? []` idiom:

```ts
for (const inc of b.incidents ?? []) {
  const age = fmtAge(Date.now() - inc.opened_at); // reuse the file's existing age formatter; if none, render without age
  lines.push(
    `⚠ incident: ${inc.gate} — ${inc.owner_seat ? 'owned by ' + inc.owner_seat : 'UNCLAIMED'} (lane ${inc.lane}${age ? ', open ' + age : ''}).`,
    `  If your red matches, it is not yours. Report blocked_by and park behind it.`,
  );
}
```

- Test: `packages/server/src/store/orientation.test.ts` and `packages/mcp/src/tools/next.render.test.ts`.

**Interfaces:**
- Consumes: `openIncidents` (Task 4).
- Produces: `NextBrief.incidents` (shape above) — increment 2 reuses it for the claim-window countdown.

- [ ] **Step 1: Failing tests.** In `orientation.test.ts` (existing seed style): open an incident
  via `recordBlockedReport` ×2 distinct seats, then
  `expect(deriveNext(db, team.id, 'revive', 'miley').incidents).toEqual([expect.objectContaining({ gate: 'ci:gates/A11y contrast', owner_seat: null })])`.
  In `next.render.test.ts` (pure renderer): feed a brief with one incident and assert the first
  content line starts `⚠ incident: ci:gates/A11y contrast — UNCLAIMED`; feed `incidents: []` and a
  brief *without* the key (daemon skew) and assert no banner and no throw.
- [ ] **Step 2: Run to verify failure** — both files → FAIL.
- [ ] **Step 3: Implement** the three modifications above. `pnpm -r build` after the protocol edit.
- [ ] **Step 4: Verify** — `pnpm exec vitest run packages/server/src/store/orientation.test.ts packages/mcp/src/tools/next.render.test.ts` PASS, then `pnpm typecheck`.
- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/lanes.ts packages/server/src/store/orientation.ts packages/mcp/src/tools/lanes.ts packages/server/src/store/orientation.test.ts packages/mcp/src/tools/next.render.test.ts
git commit -m "team_next: open incidents banner leads the brief (inc 1)"
```

---

### Task 7: Static primer guidance line

**Files:**
- Modify: `packages/protocol/src/primer.ts` (`renderPrimer`, line 29) — add ONE line (the primer is
  a per-session tax, its own comment says so):
  `"A red on a check your diff can't touch: report blocked_by on your status_update, park the work, move on — don't debug it. team_next shows open incidents."`
- Test: `packages/protocol/src/primer.test.ts`

- [ ] **Step 1: Failing test** — assert `renderPrimer({ team: 'revive' })` contains `blocked_by`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/protocol/src/primer.test.ts` → FAIL.
- [ ] **Step 3: Implement** the one-line addition.
- [ ] **Step 4: Verify** — primer test PASS, then the budget/drift gates this touches:
  `pnpm context:check && pnpm guidance:check && pnpm vocab:check`. If `vocab:check` flags
  "incident" or "blocked_by", register them per `scripts/check-vocab.ts`'s instructions.
- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/primer.ts packages/protocol/src/primer.test.ts
git commit -m "primer: one-line blocked_by norm (spec d877e464 §1 guidance)"
```

---

### Task 8: ADR, full gates, PR

**Files:**
- Create: `docs/decisions/<next>-incident-convergence-increment-1.md` (number via `pnpm adr:next`;
  spec §Increments requires an ADR per increment). Content: context = spec §Problem condensed;
  decision = increment-1 subset incl. the two plan decisions (hardcoded threshold, banner in
  `team_next` not the primer); consequences = increment 2/3 hooks (`NextBrief.incidents` reused for
  claim window; `incident_reports.lane_id` reused by resolve-notification).

- [ ] **Step 1: Write the ADR**, run `pnpm adr-numbers:check`.
- [ ] **Step 2: Full verification** (order matters — build first, protocol dist is consumed by siblings):

```bash
pnpm -r build && pnpm typecheck && pnpm lint && pnpm coverage && pnpm format:check
```

Expected: all PASS. If coverage floors fail, the new modules need the uncovered branches tested —
do not lower a floor.

- [ ] **Step 3: Commit the ADR**

```bash
git add docs/decisions/
git commit -m "ADR <n>: incident convergence increment 1 — cluster, incident lane, banner, auto-reply"
```

- [ ] **Step 4: Push, open PR, submit lane**

```bash
git push -u origin feat/incident-convergence-1
gh pr create --title "Incident convergence inc 1: shared blockers become owned lanes (spec d877e464)" --body "..."
```

Then `lane_update` lane `01M00PNG2Q0JZFEVH53PKAPKH1` with the PR, declare surface globs
(`packages/protocol/src/incident.ts`, `packages/server/src/store/incidents.ts`,
`packages/server/src/db/migrations.ts`, `packages/server/src/protocol/route.ts`,
`packages/server/src/store/orientation.ts`, `packages/mcp/src/tools/lanes.ts`,
`packages/protocol/src/primer.ts`, `docs/decisions/**`), `lane_submit`, and
`team_send {act:'status_update'}` announcing it.

---

## Self-review notes (done at write time)

- **Spec coverage:** §1 report contract → Task 1+7; §2 incident lane → Tasks 2-4; §3 increment-1
  subset (on-open nudge via normal delivery, duplicate auto-reply) → Task 5; §4 banner → Task 6
  (primer deviation recorded in Global Constraints); §5 config and §3 claim-window/wakes/resolve
  notifications → out of scope (increment 2, per spec §Increments); §6 human ask → no code, norm
  only; Observability audit verbs → Task 4.
- **Type consistency:** `IncidentOutcome`/`recordBlockedReport`/`openIncidents`/`incidentReporters`
  defined in Task 4, consumed by name in Tasks 5-6; `NextBrief.incidents` shape defined once in
  Task 6 and used by its renderer test.
- **Known adapt-points (deliberate, not placeholders):** test-helper names in integration tests
  (`post`/`get`/auth headers) and the terminal-state helper in Task 4 mirror existing files the
  executor must read first; envelope-id construction in Task 5 mirrors `fireGatedHumanAsk` rather
  than being restated, because that helper is the live precedent and drift would be a bug.
