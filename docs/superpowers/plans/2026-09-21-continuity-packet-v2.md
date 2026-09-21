# Continuity packet v2 — implementation plan (goal `seat-continuity`, increment 4)

> Lane `01M32FHX6JHCVNQRGRAHHMTEJN`. Work stays in the seat that claims it — no subagent edits, claims, builds or commits (AGENTS.md hard rule 8). Steps use `- [ ]` for tracking. Tasks are ordered so each leaves `pnpm -r build && pnpm typecheck && pnpm test` green on its own.

**Goal:** A seat woken cold on any harness reads one `team_wake_context` packet and has the waking thread's recent acts, its open ledger, its lane and its own memory — so its next call is a real act, not an orientation read.

**Architecture:** `WakeContextPacket` v2 is v1 plus an additive `context` block and a `budget` field (ADR 430). The daemon derives `context` at read time in `buildWakeContext` from `messages`, `lanes` and `seat_memory` under a 12,288-byte cap with a fixed fill order; `fetch` names only what did not fit. The MCP tool renders the block for the model; the composed wake line and the primer stop prescribing `team_inbox_check` as a ritual. No new store, no new dependency, spawn line unchanged.

**Tech Stack:** TypeScript / Node 22 ESM, zod (`@musterd/protocol`), better-sqlite3 (`@musterd/server`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-continuity-packet-design.md` · **ADR:** `docs/decisions/430-wake-context-packet-v2.md` · **Contract:** `SPEC.md` §A.13.

## Global constraints

- Protocol schema changes are gated by ADR 430 (merged before this plan runs); no further schema change without its own ADR.
- Bodies in the packet are always attributed (`from`, `act`, `ts`) and addressed to or authored by the recipient; the composed wake line and the interrupt line stay ids-only (ADR 088 §4).
- `context` serialized ≤ 12,288 bytes; fill order memory (3,072) → thread (6,144) → lane (1,536) → open (2,048); truncation cuts: act body 600 chars, lane detail 1,200, memory body 3,072 bytes.
- Authorization unchanged from ADR 209 §4 (`buildWakeContext` keeps its two `forbidden` throws exactly where they are).
- `residency.context_read` audit rows never carry a body, headline or title.
- v1 readers must keep working: every v1 field keeps its name, type and position; `version` widens to `1 | 2`.
- Every external input still passes a `@musterd/protocol` zod schema at the boundary.
- Docs and code land in the same commit: `02-protocol.md`, `03-server.md`, `05-mcp.md` and the ADR 209 dated note move with the code that changes them.

---

## File structure

| file | responsibility |
| ---- | -------------- |
| `packages/protocol/src/residency.ts` | v2 schema: `WakeContextBodySchema`, `WakeContextOpenItemSchema`, `WakeContextContextSchema`, `WakeContextBudgetSchema`; `version: z.union([z.literal(1), z.literal(2)])`; `open_items` in `WAKE_CONTEXT_FETCHES`; `WAKE_CONTEXT_BUDGET` constants exported so server and tests share one number |
| `packages/protocol/src/residency.test.ts` | round-trip + budget-shape pins |
| `packages/server/src/store/wakeContextBody.ts` *(new)* | the derivation: `deriveContext(db, team, recipient, target) → { context, fetch }` — pure queries + `fitBudget` |
| `packages/server/src/store/wakeContextBody.test.ts` *(new)* | derivation and budget tests |
| `packages/server/src/store/residency.ts` | `buildWakeContext` calls `deriveContext`, sets `version: 2`, merges `fetch`; `composeWakeLine` wording |
| `packages/server/src/store/residency.test.ts` | existing packet tests widened; line test |
| `packages/server/src/transport/http.ts` | `residency.context_read` detail gains `used_bytes`, per-category bytes, `thread_acts`, `omitted` |
| `packages/server/src/transport/residency-http.test.ts` | audit-detail pin |
| `packages/mcp/src/tools/wakeContext.ts` | render `context` for the model; description no longer says "never loads bodies" |
| `packages/mcp/src/tools/wakeContext.test.ts` *(new if absent)* | render pin |
| `packages/protocol/src/guidance.ts` | "When you were woken" block; `packages/protocol/src/feature-epoch.ts` `FEATURE_EPOCH` 21 → 22 |
| `docs/architecture/02-protocol.md`, `03-server.md`, `05-mcp.md`, `docs/decisions/209-portable-wake-context.md` | described tree lines + dated note |
| `docs/wiki/resume-bound-is-below-one-wake-life.md` | the three-arm measurement |

---

### Task 1: Protocol — `WakeContextPacket` v2 schema

**Files:**
- Modify: `packages/protocol/src/residency.ts` (the block from `WAKE_CONTEXT_FETCHES` through `WakeContextResponseSchema`)
- Test: `packages/protocol/src/residency.test.ts`

**Interfaces:**
- Produces: `WAKE_CONTEXT_BUDGET = { limit_bytes: 12_288, memory: 3_072, thread: 6_144, lane: 1_536, open: 2_048, act_body_chars: 600, lane_detail_chars: 1_200, thread_acts: 8, open_items: 12 } as const`; types `WakeContextBody`, `WakeContextOpenItem`, `WakeContextContext`, `WakeContextBudget`; `WakeContextPacket['version']` is `1 | 2`; `WakeContextFetch` gains `'open_items'`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/protocol/src/residency.test.ts — append inside the existing describe for wake context, or a new one
import { WAKE_CONTEXT_BUDGET, WakeContextPacketSchema } from './residency.js';

describe('WakeContextPacket v2 (ADR 430)', () => {
  const v1 = {
    version: 1,
    wake: { kind: 'reply', act_id: 'a1' },
    objective: { action: 'reply' },
    state: {},
    fetch: ['inbox_thread', 'seat_memory'],
    delivery: { requirement: 'portable', intended: 'fresh' },
  };

  it('still parses a v1 packet unchanged', () => {
    expect(WakeContextPacketSchema.parse(v1)).toEqual(v1);
  });

  it('parses a v2 packet with attributed bodies and a budget', () => {
    const v2 = {
      ...v1,
      version: 2,
      context: {
        thread: {
          acts: [{ id: 'a0', from: 'nick', act: 'message', ts: 1, body: 'hello', truncated: false }],
          omitted: 3,
        },
        open: [{ kind: 'ask', id: 'q1', from: 'izzo', title: 'review #12', age_ms: 5_000 }],
        memory: { body: 'carrying nothing', truncated: false },
      },
      budget: { limit_bytes: WAKE_CONTEXT_BUDGET.limit_bytes, used_bytes: 210 },
      fetch: ['open_items'],
    };
    expect(WakeContextPacketSchema.parse(v2)).toEqual(v2);
  });

  it('refuses a v2 packet without a budget, and a v1 packet carrying context', () => {
    expect(WakeContextPacketSchema.safeParse({ ...v1, version: 2, context: { open: [] } }).success).toBe(false);
    expect(WakeContextPacketSchema.safeParse({ ...v1, context: { open: [] } }).success).toBe(false);
  });

  it('refuses an unattributed body', () => {
    const bad = {
      ...v1, version: 2, budget: { limit_bytes: 12_288, used_bytes: 1 },
      context: { open: [], thread: { acts: [{ id: 'a0', act: 'message', ts: 1, body: 'x', truncated: false }], omitted: 0 } },
    };
    expect(WakeContextPacketSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @musterd/protocol test -- residency.test.ts`
Expected: FAIL — `WAKE_CONTEXT_BUDGET` is not exported; `version: 2` rejected by `z.literal(1)`.

- [ ] **Step 3: Implement the schema**

In `packages/protocol/src/residency.ts`, replace the `WAKE_CONTEXT_FETCHES` array and extend the packet:

```ts
export const WAKE_CONTEXT_FETCHES = [
  'inbox_thread',
  'lane_detail',
  'seat_memory',
  'git_artifact',
  'open_items', // ADR 430: the v2 ledger did not fit the budget
] as const;

/** ADR 430 §4 — one number, shared by the daemon that fills and the tests that pin it. */
export const WAKE_CONTEXT_BUDGET = {
  limit_bytes: 12_288,
  memory: 3_072,
  thread: 6_144,
  lane: 1_536,
  open: 2_048,
  act_body_chars: 600,
  lane_detail_chars: 1_200,
  thread_acts: 8,
  open_items: 12,
} as const;

/** An attributed act body (ADR 430 §2): the seat is never handed unattributed prose. */
export const WakeContextBodySchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    act: z.string().min(1),
    ts: z.number().int().nonnegative(),
    body: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type WakeContextBody = z.infer<typeof WakeContextBodySchema>;

export const WAKE_CONTEXT_OPEN_KINDS = ['ask', 'request_help', 'review', 'handoff', 'lane'] as const;
export const WakeContextOpenItemSchema = z
  .object({
    kind: z.enum(WAKE_CONTEXT_OPEN_KINDS),
    id: z.string().min(1),
    from: z.string().min(1).optional(),
    title: z.string(),
    age_ms: z.number().int().nonnegative(),
  })
  .strict();
export type WakeContextOpenItem = z.infer<typeof WakeContextOpenItemSchema>;

export const WakeContextContextSchema = z
  .object({
    thread: z
      .object({ acts: z.array(WakeContextBodySchema), omitted: z.number().int().nonnegative() })
      .strict()
      .optional(),
    open: z.array(WakeContextOpenItemSchema),
    lane: z
      .object({
        detail: z.string(),
        truncated: z.boolean(),
        last_status_update: z
          .object({ ts: z.number().int().nonnegative(), body: z.string(), truncated: z.boolean() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    memory: z.object({ body: z.string(), truncated: z.boolean() }).strict().optional(),
  })
  .strict();
export type WakeContextContext = z.infer<typeof WakeContextContextSchema>;

export const WakeContextBudgetSchema = z
  .object({ limit_bytes: z.number().int().positive(), used_bytes: z.number().int().nonnegative() })
  .strict();
export type WakeContextBudget = z.infer<typeof WakeContextBudgetSchema>;
```

Then in `WakeContextPacketSchema`: change `version: z.literal(1)` to `version: z.union([z.literal(1), z.literal(2)])`, add `context: WakeContextContextSchema.optional()` and `budget: WakeContextBudgetSchema.optional()` after `state`, and extend the existing `superRefine` with:

```ts
    if (value.version === 2 && (value.context === undefined || value.budget === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'v2 requires context and budget', path: ['version'] });
    }
    if (value.version === 1 && (value.context !== undefined || value.budget !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'v1 carries no context block', path: ['version'] });
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @musterd/protocol test -- residency.test.ts` — Expected: PASS. Then `pnpm --filter @musterd/protocol test` for the ≥95% line floor.

- [ ] **Step 5: Build the protocol so downstream packages see it, then commit**

```bash
pnpm --filter @musterd/protocol build
git add packages/protocol/src/residency.ts packages/protocol/src/residency.test.ts
git commit -m "protocol: WakeContextPacket v2 — attributed bodies, open ledger, budget (ADR 430)"
```

---

### Task 2: Server — derive the `context` block under the budget

**Files:**
- Create: `packages/server/src/store/wakeContextBody.ts`
- Create: `packages/server/src/store/wakeContextBody.test.ts`

**Interfaces:**
- Consumes: `WAKE_CONTEXT_BUDGET`, `WakeContextContext`, `WakeContextFetch` from `@musterd/protocol`; `MessageRow`, `MemberRow` from `./rows.js`; `getLane` from `./lanes.js`; `getMemory` from `./memory.js`; `getMemberById` from `./members.js`.
- Produces:
  ```ts
  export interface DeriveTarget { threadId?: string; laneId?: string }
  export function deriveContext(db: Database, team: { id: string; slug: string }, recipient: MemberRow, target: DeriveTarget):
    { context: WakeContextContext; used_bytes: number; fetch: WakeContextFetch[]; stats: { thread_acts: number; omitted: number; bytes: Record<'memory'|'thread'|'lane'|'open', number> } }
  export function truncateChars(s: string, max: number): { text: string; truncated: boolean }
  export function truncateBytes(s: string, max: number): { text: string; truncated: boolean }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/store/wakeContextBody.test.ts
import type { Database } from 'better-sqlite3';
import { makeEnvelope, WAKE_CONTEXT_BUDGET, type Act } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import { openLane } from './lanes.js';
import { saveMemory } from './memory.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';
import { deriveContext, truncateBytes, truncateChars } from './wakeContextBody.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
  const bob = addMember(db, team, { name: 'bob', kind: 'agent' }).row;
  return { db, team, nick, ada, bob };
}

function msg(db: Database, team: TeamRow, from: MemberRow, to: MemberRow | null, act: Act, id: string, ts: number,
  opts: { thread?: string; body?: string; meta?: Record<string, unknown> } = {}) {
  insertMessage(db, team.id, from.id, to?.id ?? null, makeEnvelope({
    id, team: team.slug, from: from.name,
    to: to ? { kind: 'member', name: to.name } : { kind: 'team' },
    act, body: opts.body ?? 'x', thread: opts.thread ?? null, meta: opts.meta ?? null, ts,
  }));
}

describe('truncation helpers', () => {
  it('cuts at the limit and flags it, and leaves short text alone', () => {
    expect(truncateChars('abcdef', 4)).toEqual({ text: 'abcd', truncated: true });
    expect(truncateChars('abc', 4)).toEqual({ text: 'abc', truncated: false });
    // bytes: a 3-byte character must not be split
    expect(truncateBytes('aé€', 4)).toEqual({ text: 'aé', truncated: true });
  });
});

describe('deriveContext (ADR 430)', () => {
  it('carries the waking thread oldest→newest, attributed, including the recipient\'s own acts', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'message', 'm1', 1_000, { body: 'first' });
    msg(db, team, ada, nick, 'message', 'm2', 1_001, { thread: 'm1', body: 'my reply' });
    msg(db, team, nick, ada, 'steer', 'm3', 1_002, { thread: 'm1', body: 'do the thing' });
    const { context, fetch } = deriveContext(db, team, ada, { threadId: 'm1' });
    expect(context.thread?.acts.map((a) => [a.from, a.act, a.body])).toEqual([
      ['nick', 'message', 'first'], ['Ada', 'message', 'my reply'], ['nick', 'steer', 'do the thing'],
    ]);
    expect(context.thread?.omitted).toBe(0);
    expect(fetch).not.toContain('inbox_thread');
  });

  it('keeps the last 8 acts and counts the rest as omitted', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'message', 't0', 1_000);
    for (let i = 1; i <= 11; i++) msg(db, team, nick, ada, 'message', `t${i}`, 1_000 + i, { thread: 't0', body: `n${i}` });
    const { context } = deriveContext(db, team, ada, { threadId: 't0' });
    expect(context.thread?.acts).toHaveLength(WAKE_CONTEXT_BUDGET.thread_acts);
    expect(context.thread?.acts[0]?.id).toBe('t4');
    expect(context.thread?.omitted).toBe(4);
  });

  it('cuts a long body at 600 chars and flags it', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'message', 'l1', 1_000, { body: 'y'.repeat(1_000) });
    const { context } = deriveContext(db, team, ada, { threadId: 'l1' });
    expect(context.thread?.acts[0]).toMatchObject({ truncated: true });
    expect(context.thread?.acts[0]?.body).toHaveLength(WAKE_CONTEXT_BUDGET.act_body_chars);
  });

  it('lists open directed asks and owned lanes, titles only, oldest first, capped at 12', () => {
    const { db, team, nick, ada, bob } = seed();
    msg(db, team, bob, ada, 'ask', 'q1', 500, { body: 'can you review #12?', meta: { species: 'consult', tier: 'advisory' } });
    msg(db, team, nick, ada, 'request_help', 'r1', 600, { body: 'help with the plist' });
    msg(db, team, nick, ada, 'ask', 'q2', 700, { body: 'answered one' });
    msg(db, team, ada, nick, 'accept', 'a2', 701, { thread: 'q2' });          // q2 is answered
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'My lane', claim: true });
    const { context } = deriveContext(db, team, ada, {});
    expect(context.open.map((o) => [o.kind, o.id, o.from])).toEqual([
      ['ask', 'q1', 'bob'], ['request_help', 'r1', 'nick'], ['lane', lane.id, undefined],
    ]);
    expect(context.open[0]?.title).toBe('can you review #12?');
    for (const o of context.open) expect(o.title.length).toBeLessThanOrEqual(120);
  });

  it('carries the lane detail and the recipient\'s own last status_update naming it', () => {
    const { db, team, nick, ada } = seed();
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'Lane', detail: 'ACCEPTANCE: x', claim: true });
    msg(db, team, ada, null, 'status_update', 's1', 900, { body: `on ${lane.id}: halfway` });
    msg(db, team, ada, null, 'status_update', 's2', 950, { body: 'unrelated' });
    const { context } = deriveContext(db, team, ada, { laneId: lane.id });
    expect(context.lane).toMatchObject({ detail: 'ACCEPTANCE: x', truncated: false,
      last_status_update: { body: `on ${lane.id}: halfway`, truncated: false } });
    void nick;
  });

  it('carries the memory body whole when it fits, else headline + 3 KiB flagged', () => {
    const { db, team, ada } = seed();
    saveMemory(db, ada.id, { headline: 'short', body: 'carrying nothing' });
    expect(deriveContext(db, team, ada, {}).context.memory).toEqual({ body: 'carrying nothing', truncated: false });
    saveMemory(db, ada.id, { headline: 'long', body: 'z'.repeat(10_000) });
    const { context, fetch } = deriveContext(db, team, ada, {});
    expect(context.memory?.truncated).toBe(true);
    expect(Buffer.byteLength(context.memory!.body, 'utf8')).toBeLessThanOrEqual(WAKE_CONTEXT_BUDGET.memory);
    expect(fetch).toContain('seat_memory');
  });

  it('never exceeds the 12 KiB cap, drops the ledger before the thread, and names what it dropped', () => {
    const { db, team, nick, ada, bob } = seed();
    saveMemory(db, ada.id, { headline: 'h', body: 'm'.repeat(3_000) });
    msg(db, team, nick, ada, 'message', 'b0', 1_000, { body: 'b'.repeat(600) });
    for (let i = 1; i <= 8; i++) msg(db, team, nick, ada, 'message', `b${i}`, 1_000 + i, { thread: 'b0', body: 'b'.repeat(600) });
    for (let i = 0; i < 12; i++) msg(db, team, bob, ada, 'ask', `o${i}`, 2_000 + i, { body: 'o'.repeat(120) });
    const { context, used_bytes, fetch } = deriveContext(db, team, ada, { threadId: 'b0' });
    expect(used_bytes).toBeLessThanOrEqual(WAKE_CONTEXT_BUDGET.limit_bytes);
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBe(used_bytes);
    expect(context.thread?.acts.length).toBeGreaterThan(0);
    if (context.open.length < 12) expect(fetch).toContain('open_items');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @musterd/server test -- wakeContextBody` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement the derivation**

```ts
// packages/server/src/store/wakeContextBody.ts
import type { WakeContextContext, WakeContextFetch, WakeContextOpenItem } from '@musterd/protocol';
import { WAKE_CONTEXT_BUDGET as B } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { getLane } from './lanes.js';
import { getMemberById } from './members.js';
import { getMemory } from './memory.js';
import type { MemberRow, MessageRow } from './rows.js';

/**
 * ADR 430 — the v2 `context` block, derived at read time from canonical rows and fitted to the
 * budget in the spec's fill order (memory → thread → lane → open). Every act body is attributed;
 * the ledger carries titles only. Nothing here is stored.
 */
export interface DeriveTarget {
  threadId?: string;
  laneId?: string;
}

export function truncateChars(s: string, max: number): { text: string; truncated: boolean } {
  return s.length <= max ? { text: s, truncated: false } : { text: s.slice(0, max), truncated: true };
}

export function truncateBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false };
  const buf = Buffer.from(s, 'utf8').subarray(0, max);
  // Walk back off a split multi-byte sequence: a continuation byte is 10xxxxxx.
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  if (end > 0 && (buf[end - 1]! & 0xc0) === 0xc0) end--; // a lead byte with nothing after it
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

const OPEN_ACTS = ['ask', 'request_help'] as const;

export function deriveContext(
  db: Database,
  team: { id: string; slug: string },
  recipient: MemberRow,
  target: DeriveTarget,
): {
  context: WakeContextContext;
  used_bytes: number;
  fetch: WakeContextFetch[];
  stats: { thread_acts: number; omitted: number; bytes: Record<'memory' | 'thread' | 'lane' | 'open', number> };
} {
  const fetch: WakeContextFetch[] = [];
  const bytes = { memory: 0, thread: 0, lane: 0, open: 0 };
  const context: WakeContextContext = { open: [] };
  const nameOf = (memberId: string): string => getMemberById(db, memberId)?.name ?? memberId;

  // 1. memory (≤ 3,072 bytes)
  const memory = getMemory(db, recipient.id);
  if (memory) {
    const cut = truncateBytes(memory.body, B.memory);
    context.memory = { body: cut.text, truncated: cut.truncated };
    if (cut.truncated) fetch.push('seat_memory');
    bytes.memory = bytesOf(context.memory);
  }

  // 2. thread (last 8 acts, ≤ 6,144 bytes)
  if (target.threadId !== undefined) {
    const rows = db
      .prepare<[string, string, string], MessageRow>(
        `SELECT * FROM messages WHERE team_id = ? AND (id = ? OR thread_id = ?) ORDER BY ts DESC`,
      )
      .all(team.id, target.threadId, target.threadId);
    const recent = rows.slice(0, B.thread_acts).reverse();
    let acts = recent.map((r) => {
      const cut = truncateChars(r.body, B.act_body_chars);
      return { id: r.id, from: nameOf(r.from_member), act: r.act, ts: r.ts, body: cut.text, truncated: cut.truncated };
    });
    let omitted = rows.length - acts.length;
    while (acts.length > 1 && bytesOf({ acts, omitted }) > B.thread) {
      acts = acts.slice(1); // drop the OLDEST first — the newest act is why the seat is awake
      omitted++;
    }
    context.thread = { acts, omitted };
    if (omitted > 0) fetch.push('inbox_thread');
    bytes.thread = bytesOf(context.thread);
  }

  // 3. lane (≤ 1,536 bytes)
  if (target.laneId !== undefined) {
    const lane = getLane(db, team.id, target.laneId, team.slug);
    if (lane) {
      const detail = truncateChars(lane.detail ?? '', B.lane_detail_chars);
      const last = db
        .prepare<[string, string, string], MessageRow>(
          `SELECT * FROM messages WHERE team_id = ? AND from_member = ? AND act = 'status_update'
             AND instr(body, ?) > 0 ORDER BY ts DESC LIMIT 1`,
        )
        .get(team.id, recipient.id, lane.id);
      const status = last ? truncateChars(last.body, B.act_body_chars) : undefined;
      context.lane = {
        detail: detail.text,
        truncated: detail.truncated,
        ...(last && status ? { last_status_update: { ts: last.ts, body: status.text, truncated: status.truncated } } : {}),
      };
      if (bytesOf(context.lane) > B.lane) {
        delete context.lane.last_status_update;
        context.lane.detail = truncateChars(context.lane.detail, Math.floor(B.lane_detail_chars / 2)).text;
        context.lane.truncated = true;
      }
      if (context.lane.truncated) fetch.push('lane_detail');
      bytes.lane = bytesOf(context.lane);
    }
  }

  // 4. open ledger (≤ 12 items, ≤ 2,048 bytes)
  const now = Date.now();
  const directed = db
    .prepare<[string, string, ...string[]], MessageRow>(
      `SELECT m.* FROM messages m
        WHERE m.team_id = ? AND m.to_kind = 'member' AND m.to_member = ?
          AND m.act IN (${OPEN_ACTS.map(() => '?').join(',')})
          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.team_id = m.team_id
                            AND r.from_member = m.to_member AND (r.thread_id = m.id OR r.thread_id = m.thread_id))
        ORDER BY m.ts ASC`,
    )
    .all(team.id, recipient.id, ...OPEN_ACTS);
  const items: WakeContextOpenItem[] = directed.map((r) => {
    const meta = JSON.parse(r.meta ?? '{}') as { lane_review?: unknown; lane_handoff?: unknown };
    const kind = meta.lane_review ? 'review' : meta.lane_handoff ? 'handoff' : (r.act as 'ask' | 'request_help');
    return { kind, id: r.id, from: nameOf(r.from_member), title: truncateChars(r.body.split('\n')[0] ?? '', 120).text, age_ms: Math.max(0, now - r.ts) };
  });
  const lanes = db
    .prepare<[string, string], { id: string; title: string; created_at: number }>(
      `SELECT id, title, created_at FROM lanes WHERE team_id = ? AND owner_seat = ? AND state IN ('claimed','active','blocked') ORDER BY created_at ASC`,
    )
    .all(team.id, recipient.name);
  for (const l of lanes) items.push({ kind: 'lane', id: l.id, title: truncateChars(l.title, 120).text, age_ms: Math.max(0, now - l.created_at) });
  const total = items.length;
  let open = items.slice(0, B.open_items);
  while (open.length > 0 && bytesOf(open) > B.open) open = open.slice(0, -1);
  context.open = open;
  if (open.length < total) fetch.push('open_items');
  bytes.open = bytesOf(context.open);

  // 5. the whole-block cap — the fill order above means the ledger is the first casualty
  let used = bytesOf(context);
  if (used > B.limit_bytes && context.open.length > 0) {
    context.open = [];
    if (!fetch.includes('open_items')) fetch.push('open_items');
    used = bytesOf(context);
  }
  if (used > B.limit_bytes && context.lane) {
    delete context.lane;
    if (!fetch.includes('lane_detail')) fetch.push('lane_detail');
    used = bytesOf(context);
  }

  return {
    context,
    used_bytes: used,
    fetch,
    stats: { thread_acts: context.thread?.acts.length ?? 0, omitted: context.thread?.omitted ?? 0, bytes },
  };
}
```

Check `lanes` column names against `packages/server/src/store/lanes.ts` (`LaneRow`: `title`, `created_at`, `owner_seat`, `state`) and adjust the SQL if a name differs — the test will say so.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @musterd/server test -- wakeContextBody` — Expected: PASS (all 8).

- [ ] **Step 5: Add the described tree line and commit**

In `docs/architecture/03-server.md`, inside the ``packages/server/src/`` tree under `store/`, add:

```
    wakeContextBody.ts  // ADR 430: deriveContext — the v2 packet's attributed thread window, open ledger, lane block and memory body, fitted to the 12 KiB budget in fill order; read-time only, never stored
```

```bash
pnpm format:check   # arch-trees:check must see the new file
git add packages/server/src/store/wakeContextBody.ts packages/server/src/store/wakeContextBody.test.ts docs/architecture/03-server.md
git commit -m "server: derive the v2 wake-context block under the budget (ADR 430)"
```

---

### Task 3: Server — `buildWakeContext` emits v2; the audit records its shape

**Files:**
- Modify: `packages/server/src/store/residency.ts` (`buildWakeContext`, both return objects)
- Modify: `packages/server/src/store/residency.test.ts` (`describe('buildWakeContext (ADR 209)')`)
- Modify: `packages/server/src/transport/http.ts` (the `/wake-context` route's allow audit)
- Modify: `packages/server/src/transport/residency-http.test.ts`

**Interfaces:**
- Consumes: `deriveContext` (Task 2).
- Produces: `buildWakeContext` returns `version: 2` with `context`, `budget`, and `fetch` = v1's list **intersected with** what did not fit (i.e. `deriveContext().fetch` plus `git_artifact` when a lane is present — the branch is never in the packet).

- [ ] **Step 1: Write the failing tests**

Add to `residency.test.ts` inside the existing `describe('buildWakeContext (ADR 209)')`:

```ts
  it('v2: carries the waking thread, the open ledger and the memory body; fetch names only what did not fit (ADR 430)', () => {
    const { db, team, nick, ada } = seed();
    saveMemory(db, ada.id, { headline: 'h', body: 'carrying lane X' });
    msg(db, team, nick, ada, 'message', 'v1', 1_000);
    msg(db, team, nick, ada, 'steer', 'v2', 1_001, { thread: 'v1' });
    const packet = buildWakeContext(db, team, ada, { act_id: 'v2' });
    expect(packet.version).toBe(2);
    expect(packet.context?.thread?.acts.map((a) => a.id)).toEqual(['v1', 'v2']);
    expect(packet.context?.memory).toEqual({ body: 'carrying lane X', truncated: false });
    expect(packet.budget?.used_bytes).toBeGreaterThan(0);
    expect(packet.fetch).toEqual([]);            // everything fit
    expect(WakeContextPacketSchema.parse(packet)).toEqual(packet);
  });

  it('v2: a lane wake carries the lane block and still points at the git artifact', () => {
    const { db, team, ada } = seed();
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'L', detail: 'D', branch: 'feat/x', claim: true });
    const packet = buildWakeContext(db, team, ada, { lane_id: lane.id });
    expect(packet.context?.lane).toMatchObject({ detail: 'D' });
    expect(packet.fetch).toEqual(['git_artifact']);
  });
```

(`saveMemory` from `./memory.js` and `WakeContextPacketSchema` from `@musterd/protocol` need importing at the top of the test file; `msg` already exists there — give it a `body` option exactly as in Task 2's helper.)

Add to `residency-http.test.ts` inside `describe('POST /wake-context — residency.context_read audit …')`:

```ts
  it('records the v2 shape on the allow row and never a body (ADR 430)', async () => {
    await directedToAda('wc9');
    const res = await postAsAda('/teams/dawn/wake-context', { act_id: 'wc9' });
    expect(res.status).toBe(200);
    expect(res.json.context.version).toBe(2);
    const row = db.prepare(`SELECT detail FROM audit WHERE action = 'residency.context_read' ORDER BY ts DESC LIMIT 1`).get() as { detail: string };
    const detail = JSON.parse(row.detail);
    expect(detail).toMatchObject({ version: 2, thread_acts: expect.any(Number), omitted: 0 });
    expect(detail.used_bytes).toBeGreaterThan(0);
    expect(detail.bytes).toEqual(expect.objectContaining({ memory: expect.any(Number), thread: expect.any(Number) }));
    expect(JSON.stringify(detail)).not.toContain(res.json.context.context.thread.acts[0].body);
  });
```

(`db` is whatever handle the surrounding describe already uses for audit assertions — reuse it.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @musterd/server test -- residency` — Expected: FAIL, `version` is 1, `context` undefined.

- [ ] **Step 3: Implement**

In `buildWakeContext` (residency.ts), for the act path, after `const kind = …` and before the `return`:

```ts
    const derived = deriveContext(db, team, recipient, { threadId, ...(lane ? { laneId: lane.id } : {}) });
```

and change the return to:

```ts
    return {
      version: 2,
      wake: { kind, act_id: row.id },
      objective: { … unchanged … },
      state: { … unchanged … },
      context: derived.context,
      budget: { limit_bytes: WAKE_CONTEXT_BUDGET.limit_bytes, used_bytes: derived.used_bytes },
      fetch: [...derived.fetch, ...(lane ? (['git_artifact'] as const) : [])],
      delivery: { requirement: 'portable', intended: 'fresh' },
    };
```

For the lane path, `const derived = deriveContext(db, team, recipient, { laneId: lane.id });` and the same four fields, `fetch: [...derived.fetch, 'git_artifact']`. Import `deriveContext` from `./wakeContextBody.js` and `WAKE_CONTEXT_BUDGET` from `@musterd/protocol`. Update the function's doc comment: it no longer says "an Act body or memory body never crosses this seam" — it says bodies cross *attributed and budgeted* (ADR 430) and the audit never carries them.

In `http.ts`, the allow audit's `detail` becomes:

```ts
            detail: {
              kind: context.wake.kind,
              version: context.version,
              bytes: Buffer.byteLength(JSON.stringify(context), 'utf8'),
              ...(context.budget ? { used_bytes: context.budget.used_bytes } : {}),
              ...(context.context
                ? {
                    thread_acts: context.context.thread?.acts.length ?? 0,
                    omitted: context.context.thread?.omitted ?? 0,
                    bytes_by: {
                      memory: context.context.memory ? Buffer.byteLength(JSON.stringify(context.context.memory), 'utf8') : 0,
                      thread: context.context.thread ? Buffer.byteLength(JSON.stringify(context.context.thread), 'utf8') : 0,
                      lane: context.context.lane ? Buffer.byteLength(JSON.stringify(context.context.lane), 'utf8') : 0,
                      open: Buffer.byteLength(JSON.stringify(context.context.open), 'utf8'),
                    },
                  }
                : {}),
              fetch: context.fetch,
              fetch_count: context.fetch.length,
              delivery: context.delivery,
            },
```

(the test above reads `detail.bytes` as an object — rename the existing scalar `bytes` to `packet_bytes` so the two do not collide, and update any test that pinned `bytes` on the v1 row.) The deny row is unchanged: it already exists with `result: 'deny'`, which is what ADR 430 §6's "context_denied" asks for — record in ADR 430's Consequences that the existing deny row satisfies it and no new action name is added.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @musterd/server test -- residency` — Expected: PASS, including every pre-existing `buildWakeContext` test (they use `toMatchObject`, so the new fields do not break them).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/residency.ts packages/server/src/store/residency.test.ts packages/server/src/transport/http.ts packages/server/src/transport/residency-http.test.ts
git commit -m "server: buildWakeContext emits v2; context_read audit records its shape, never a body (ADR 430)"
```

---

### Task 4: Server — the composed wake line stops prescribing the inbox ritual

**Files:**
- Modify: `packages/server/src/store/residency.ts:730-745` (`composeWakeLine`)
- Modify: `packages/server/src/store/residency.test.ts` (the test near line 252 that pins `team_wake_context {act_id: "u1"}`)

- [ ] **Step 1: Write the failing test**

Next to the existing `composed_line` assertion:

```ts
    expect(order.composed_line).toMatch(/Read `team_wake_context \{act_id: "u1"\}` — it carries the thread, what else is open, and your memory\. Fetch more only for what it lists under `fetch`\. Then act\./);
    expect(order.composed_line).not.toContain('read it via team_inbox_check');
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/server test -- residency.test` — Expected: FAIL on the new wording.

- [ ] **Step 3: Implement**

```ts
function composeWakeLine(seat: string, teamSlug: string, act: string, sender: string, actId?: string): string {
  const read = actId !== undefined ? `Read \`team_wake_context {act_id: "${actId}"}\`` : 'Read `team_wake_context`';
  return (
    `musterd wake — you are seat "${seat}" on team "${teamSlug}": a ${act} from "${sender}" is ` +
    `waiting. ${read} — it carries the thread, what else is open, and your memory. ` +
    `Fetch more only for what it lists under \`fetch\`. Then act.`
  );
}
```

The line still carries ids only — sender name, act name, act id — no body text (ADR 088 §4).

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @musterd/server test -- residency.test` — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/residency.ts packages/server/src/store/residency.test.ts
git commit -m "server: the wake line says the packet is the orientation (ADR 430 §7)"
```

---

### Task 5: MCP — render the `context` block for the model

**Files:**
- Modify: `packages/mcp/src/tools/wakeContext.ts`
- Test: `packages/mcp/src/tools/wakeContext.test.ts` (create if absent; follow the neighbouring `*.test.ts` in that directory for how a tool is invoked against a fake client)

**Interfaces:**
- Consumes: `WakeContextPacket` v2 from `@musterd/protocol`.
- Produces: `render(context)` text that puts the thread, the ledger, the lane and the memory in front of the model, attributed, and ends with the `fetch` follow-ups only when non-empty.

- [ ] **Step 1: Write the failing test**

```ts
// packages/mcp/src/tools/wakeContext.test.ts
import { describe, expect, it } from 'vitest';
import { render } from './wakeContext.js';

describe('team_wake_context render (ADR 430)', () => {
  it('shows the thread attributed, the ledger, the memory, and no follow-ups when everything fit', () => {
    const text = render({
      version: 2,
      wake: { kind: 'reply', act_id: 'a2' },
      objective: { action: 'reply' },
      state: {},
      context: {
        thread: { acts: [
          { id: 'a1', from: 'nick', act: 'message', ts: 1_000, body: 'first', truncated: false },
          { id: 'a2', from: 'nick', act: 'steer', ts: 2_000, body: 'do the thing', truncated: true },
        ], omitted: 0 },
        open: [{ kind: 'ask', id: 'q1', from: 'izzo', title: 'review #12', age_ms: 90_000 }],
        memory: { body: 'carrying lane X', truncated: false },
      },
      budget: { limit_bytes: 12_288, used_bytes: 300 },
      fetch: [],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toContain('wake context: reply a2');
    expect(text).toContain('nick · message · a1: first');
    expect(text).toContain('nick · steer · a2: do the thing …');
    expect(text).toContain('open: ask q1 from izzo — review #12 (1m)');
    expect(text).toContain('memory:\ncarrying lane X');
    expect(text).not.toContain('explicit reads');
  });

  it('v1 renders exactly as before', () => {
    const text = render({
      version: 1, wake: { kind: 'reply', act_id: 'a1' }, objective: { action: 'reply' }, state: {},
      fetch: ['inbox_thread', 'seat_memory'], delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toContain('explicit reads: team_inbox_check, team_memory_read');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @musterd/mcp test -- wakeContext` — FAIL: `render` not exported / v2 fields not rendered.

- [ ] **Step 3: Implement**

Export `render` and extend it:

```ts
const ago = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

export function render(context: WakeContextPacket): string {
  const target = context.wake.act_id ?? context.wake.lane_id;
  const lines = [
    `wake context: ${context.wake.kind} ${target}`,
    `next action: ${context.objective.action} · delivery: ${context.delivery.requirement}/${context.delivery.intended}`,
  ];
  const c = context.context;
  if (c) {
    if (c.thread) {
      lines.push(`thread (${c.thread.acts.length} shown${c.thread.omitted ? `, ${c.thread.omitted} older omitted` : ''}):`);
      for (const a of c.thread.acts) lines.push(`  ${a.from} · ${a.act} · ${a.id}: ${a.body}${a.truncated ? ' …' : ''}`);
    }
    if (c.lane) {
      lines.push(`lane: ${c.lane.detail}${c.lane.truncated ? ' …' : ''}`);
      if (c.lane.last_status_update) lines.push(`your last word on it: ${c.lane.last_status_update.body}${c.lane.last_status_update.truncated ? ' …' : ''}`);
    }
    for (const o of c.open) lines.push(`open: ${o.kind} ${o.id}${o.from ? ` from ${o.from}` : ''} — ${o.title} (${ago(o.age_ms)})`);
    if (c.memory) lines.push(`memory:\n${c.memory.body}${c.memory.truncated ? '\n…(truncated — team_memory_read for the rest)' : ''}`);
  }
  if (context.fetch.length > 0) {
    const followUps = context.fetch.map((fetch) => {
      if (fetch === 'seat_memory') return 'team_memory_read';
      if (fetch === 'inbox_thread') return 'team_inbox_check';
      if (fetch === 'lane_detail') return 'lane_board';
      if (fetch === 'open_items') return 'team_inbox_check (open items did not fit)';
      return 'git artifact on the declared branch';
    });
    lines.push(`explicit reads: ${followUps.join(', ')}`);
  }
  return lines.join('\n');
}
```

Change `DESCRIPTION` to: `'Read your wake context packet for one directed Act or owned Lane: the thread you were woken for, what else is open against you, your lane, and your memory — attributed and budgeted (ADR 430). Fetch more only for what it lists under fetch.'` Keep it under the tools-list byte budget (`pnpm context:check`).

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @musterd/mcp test -- wakeContext` — PASS; then `pnpm context:check`.

- [ ] **Step 5: Update `05-mcp.md`'s tree line for `tools/wakeContext.ts` (describe the v2 render) and commit**

```bash
git add packages/mcp/src/tools/wakeContext.ts packages/mcp/src/tools/wakeContext.test.ts docs/architecture/05-mcp.md
git commit -m "mcp: team_wake_context renders the v2 context block (ADR 430)"
```

---

### Task 6: Guidance — the packet is the orientation

**Files:**
- Modify: `packages/protocol/src/guidance.ts:269-281` (the `## When you were woken (ADR 209)` block)
- Modify: `packages/protocol/src/feature-epoch.ts:102` (`FEATURE_EPOCH = 21` → `22`)
- Test: whichever guidance test pins the woken block's wording (`grep -rn "carries \*\*no message or memory bodies" packages/protocol/src packages/cli/src --include='*.test.ts'`) — update that pin; if none pins it, add one line to `packages/protocol/src/guidance.test.ts` asserting the new sentence is present.

- [ ] **Step 1: Write the failing test**

```ts
  it('the woken block says the packet is the orientation (ADR 430)', () => {
    const text = renderGuidance(/* whatever the neighbouring tests pass */);
    expect(text).toContain('it carries the thread you were woken for');
    expect(text).not.toContain('carries **no message or memory bodies**');
  });
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @musterd/protocol test -- guidance` — FAIL.

- [ ] **Step 3: Replace the block**

```ts
    '## When you were woken (ADR 209 / 430)',
    '',
    'A session the wake actuator started did not choose its own task: something addressed to this seat',
    'is why it is running. **Find out what before you do anything else.** `team_wake_context` returns a',
    'bounded packet for the one act or lane you were woken for — and it carries the thread you were woken',
    'for (attributed, last few acts), everything else open against you, your lane and your own memory,',
    'under a 12 KiB budget. **The packet is the orientation.** Fetch more only for what it lists under',
    '`fetch` (`team_inbox_check`, `team_memory_read`, `lane_board`, or the branch it points at). A packet',
    'that says `version: 1` is an older daemon: then make those reads as before.',
    '',
    '- **Do the thing you were woken for.** A wake naming an act or a lane is work routed to this seat;',
    '  it is not a prompt to survey the board or pick something more interesting.',
    '- **Answer through the acts, as always** — a wake changes what started you, not how you report.',
    '- **A wake with no context packet is worth saying out loud**, not guessing past.',
```

Bump `FEATURE_EPOCH` to `22` and add a one-line comment naming ADR 430 next to it, following the style of the existing entries in that file.

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @musterd/protocol test` — PASS. Then `pnpm -r build && pnpm typecheck` (the CLI's guidance snapshot tests, if any, will now need their fixtures regenerated — follow what the failing test names).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/guidance.ts packages/protocol/src/feature-epoch.ts packages/protocol/src/guidance.test.ts
git commit -m "guidance: the packet is the orientation on a wake; epoch 22 (ADR 430 §7)"
```

---

### Task 7: Docs that must land with the code

**Files:**
- Modify: `docs/architecture/02-protocol.md:168-172` — the `WakeContextPacketSchema` sentence stops saying "body-free"; says v2 carries attributed, budgeted bodies under `context` with a `budget`.
- Modify: `docs/architecture/03-server.md:76` — the `http.ts` line: "recipient-only body-free index" → "recipient-only packet (v2: attributed, budgeted bodies, ADR 430)".
- Modify: `docs/decisions/209-portable-wake-context.md` — a dated note in `## Consequences`: `- 2026-MM-DD (ADR 430, lane 01M32FHX6J): the packet now carries attributed, budgeted bodies; the "no bodies" rule is narrowed to the spawn prompt, which is unchanged.`
- Modify: `docs/decisions/430-wake-context-packet-v2.md` — a dated Consequences note: shipped; the existing `residency.context_read` deny row satisfies §6's denied-read record, no new action name.
- Modify: `SPEC.md` — move A.13's content into the released body (the wake-context paragraph near line 338) and delete A.13, per "Appendix A holds Unreleased".

- [ ] **Step 1: Make the edits above** (no code).
- [ ] **Step 2: `pnpm format:check`** — arch-trees, wiki, vocab, change-adr all green.
- [ ] **Step 3: Commit**

```bash
git add docs SPEC.md
git commit -m "docs: WakeContextPacket v2 is shipped — arch chapters, SPEC, ADR 209/430 notes"
```

---

### Task 8: Land, refresh, and run the three-arm measurement

**Files:**
- Modify: `docs/wiki/resume-bound-is-below-one-wake-life.md` — a new dated section with the table below.

- [ ] **Step 1: Open the PR and let it land** — `gh pr create … && gh pr merge <n> --squash --auto --delete-branch`. Wait for `~/.musterd/autorefresh/refresh.log` to show the merge SHA **and** `restarted the wake actuator`.
- [ ] **Step 2: Rebuild this workspace and `/mcp` reload** so your own adapter parses v2 (`pnpm build`).
- [ ] **Step 3: Seed the task thread.** In one thread to each target seat (dolly, gptbot), send three acts; the third is the steer and it refers to the first: e.g. `message` "the wiki page to touch is X", `message` "second point…", then `steer` "do what the first message in this thread asked, and say which file". Check `team_members` first — a **live** seat does not wake; the seat must be asleep.
- [ ] **Step 4: Arm A (dolly, resume)** — with dolly's newest transcript under the ADR 427 conversation bound, steer; confirm `session=resumed` in `~/.musterd/host.log`. **Arm B (dolly, fresh + v2)** — steer again after her resumed session has exited and with an order that is portable/fresh (a `handoff` or `work_order` wake is always portable per ADR 209 §2 — use a small lane handoff carrying the same three-act thread), confirm `session=fresh` and `residency.context_read` with `version: 2`. **Arm C (gptbot, fresh + v2)** — same as B on the Codex seat.
- [ ] **Step 5: Record per wake:** cost and wall from `host.log`; tool calls between `team_wake_context` and the first non-read act from the seat's transcript (`~/.claude/projects/-Users-nick-agents-<seat>/` for Claude Code; the Codex rollout for gptbot); `used_bytes` from the `context_read` row; first-act correctness judged by you (the sender) and written down as a sentence, not a score.

| arm | seat | delivery | cost | wall | calls before first act | used_bytes | first act correct? |
| --- | ---- | -------- | ---- | ---- | ---------------------- | ---------- | ------------------ |
| A | dolly | resume | | | | — | |
| B | dolly | fresh + v2 | | | | | |
| C | gptbot | fresh + v2 | | | | | |

- [ ] **Step 6: Judge against the spec:** B ≈ A on correctness, B < A on cost, C ≈ B on both. Write the section with a dated falsifier and `<!-- claim: … -->`; `pnpm wiki:check`; commit; PR.
- [ ] **Step 7: `lane_submit` `01M32FHX6JHCVNQRGRAHHMTEJN` `{pr, sha, authorized_by}`** and follow the reply.

---

## Self-review

- **Spec coverage.** §1 schema → Task 1. §2 derivation → Task 2 (thread, open, lane, memory, authorization untouched in Task 3). §3 budget → Task 2 (`WAKE_CONTEXT_BUDGET`, fill order, `fetch` = what did not fit). §4 audit → Task 3 (allow-row detail; deny row already exists — recorded in Task 7). §5 guidance → Tasks 4 and 6. §6 measurement → Task 8. "Out of scope" items have no task, correctly.
- **Placeholders.** None: every code step carries its code; Task 6's `renderGuidance(...)` argument is deliberately deferred to "whatever the neighbouring tests pass" because the test file's helper is the source of truth — the implementer reads it, not this plan.
- **Type consistency.** `deriveContext` returns `{ context, used_bytes, fetch, stats }` in Task 2 and is consumed with those names in Task 3; `WAKE_CONTEXT_BUDGET` field names (`limit_bytes`, `memory`, `thread`, `lane`, `open`, `act_body_chars`, `lane_detail_chars`, `thread_acts`, `open_items`) match between Tasks 1 and 2; `render` is exported in Task 5 and imported by name in its test.
