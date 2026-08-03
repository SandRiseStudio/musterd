# Deferred wake / nudge (ADR 211) Implementation Plan

> **For agentic workers:** implement this plan task-by-task in your own seat. Do not dispatch
> subagents to write: musterd's AGENTS.md hard rule 8 keeps write work in a seat (read-only
> fan-out is fine). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Member postpone a directed act with `wait` + `meta.defer_ref` + `meta.until`, and
have that act return to their inbox when a named state edge fires — no clock, no scheduler.

**Architecture:** A deferring `wait` is validated in the protocol, folded latest-wins in the server
store next to `pendingInterrupts`, and read back through `listInbox`. Pendingness becomes
`unread-by-cursor OR deferred-and-raised`, so the single monotonic read cursor is never touched. The
CLI gains `musterd inbox defer` and a deferred footer; `musterd report` warns on long-deferred acts.

**Tech Stack:** TypeScript, zod (protocol schemas), better-sqlite3 (store), vitest, pnpm workspaces.

**Source spec:** `docs/superpowers/specs/2026-08-03-deferred-wake-nudge-design.md`

## Global Constraints

- Branch: `docs/deferred-wake-nudge`. Lane 01KYJXGW63DQ4P408H37YDGV46 (ryder). Branch from fresh
  `origin/main`; PR with `gh pr merge --squash --auto --delete-branch`; rebase + `--force-with-lease`,
  never merge (ADR 106).
- **Scope is increments 0 and 1 only.** Increment 2 (wake eligibility for raised acts) is
  deliberately excluded and gets its own plan. Task 5 exists to keep it excluded.
- No new act. The acts enum in `packages/protocol/src/acts.ts` is not modified.
- No new DB table, no new column, no migration. Deferral state is derived, never stored.
- No timer, scheduler, due date, or wall-clock field anywhere (ADR 179 doctrine).
- Audit detail carries shapes only — condition kind and target ids, never message bodies (ADR 051).
- ADR 211 must carry an `## Observability & Evaluation` section or `pnpm obs-evals:check` fails.
  The ADR H1 must read `# 211 — …` and match its filename or `pnpm adr-numbers:check` fails.
- Never run `pnpm format`. Use `pnpm exec prettier --write <your files>`.
- Run `pnpm build` before `pnpm typecheck` (phantom `.d.ts` errors otherwise). `pnpm lint` is a
  separate gate from `format:check` — run both before pushing.
- Run vitest from the repo root only.

---

### Task 1: ADR 211

**Files:**

- Create: `docs/decisions/211-deferred-act-raise.md`

**Interfaces:**

- Consumes: nothing.
- Produces: the accepted contract every later task implements. Later tasks cite it in comments as
  "ADR 211 §N".

- [ ] **Step 1: Confirm 211 is still free**

Run:

```bash
git fetch -q origin main && git ls-tree --name-only origin/main docs/decisions/ | grep -c '^docs/decisions/211'
```

Expected: `0`. If non-zero, take the next free number and use it consistently everywhere below.
Do **not** reuse 208 — it was vacated by a 208→210 renumber and still appears in the live audit
trail.

- [ ] **Step 2: Write the ADR**

Create `docs/decisions/211-deferred-act-raise.md` with H1 `# 211 — Deferred acts: raise on a
condition, never a clock`, `- Status: accepted`, `- Date: 2026-08-03`, and a `- Builds on:` list
citing ADR 024, 054, 103, 111, 117, 131, 145, 147, 179, 189, 209.

Port these sections verbatim in substance from the spec (`docs/superpowers/specs/2026-08-03-deferred-wake-nudge-design.md`):
Context (the three consequences), Problem, Decision §1–§6, Failure mode, Consequences, and
`## Observability & Evaluation`.

The Observability section MUST state: `inbox.deferred` is the only new audit action; a _raise_ is
derived at read time and emits no event, because emitting one would invent a fact the system does
not have (ADR 189); and the eval measures deferral count, condition-kind split, deferral→raise
interval, and the answered / re-deferred / never-answered outcome split.

- [ ] **Step 3: Verify the doc gates pass**

Run:

```bash
pnpm adr-numbers:check && pnpm obs-evals:check
```

Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write docs/decisions/211-deferred-act-raise.md
git add docs/decisions/211-deferred-act-raise.md
git commit -m "docs(adr-211): deferred acts raise on a condition, never a clock"
```

---

### Task 2: Protocol — the deferring `wait` shape and its validation

**Files:**

- Modify: `packages/protocol/src/envelope.ts` (add `DeferUntilSchema` near the other meta schemas;
  add a refine block immediately after the existing `wait` + `ask_ref` block at ~line 143)
- Test: `packages/protocol/src/envelope.test.ts`

**Interfaces:**

- Consumes: the existing `makeEnvelope` / `EnvelopeSchema` from this file.
- Produces:

  ```ts
  export type DeferUntil = { lane: string } | { reply: true };
  export const DeferUntilSchema: z.ZodType<DeferUntil>;
  ```

  Task 3 imports `DeferUntil` and `DeferUntilSchema` from `@musterd/protocol`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/protocol/src/envelope.test.ts`:

```ts
describe('deferring wait (ADR 211 §1)', () => {
  const base = {
    from: 'ryder',
    to: { kind: 'member' as const, name: 'stanley' },
    act: 'wait' as const,
    body: 'not now',
  };

  it('accepts a lane condition', () => {
    const env = makeEnvelope({
      ...base,
      meta: {
        defer_ref: '01KZ4PAE1EEWEZ6E6DF84P9AK5',
        until: { lane: '01KZ4C4R8NDZ1F7N7NJET2MG9K' },
      },
    });
    expect(EnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('accepts a reply condition', () => {
    const env = makeEnvelope({
      ...base,
      meta: { defer_ref: '01KZ4PAE1EEWEZ6E6DF84P9AK5', until: { reply: true } },
    });
    expect(EnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('rejects a defer_ref with no until', () => {
    const env = makeEnvelope({ ...base, meta: { defer_ref: '01KZ4PAE1EEWEZ6E6DF84P9AK5' } });
    const res = EnvelopeSchema.safeParse(env);
    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).toContain('meta.until');
  });

  it('rejects an until that is neither a lane nor a reply', () => {
    const env = makeEnvelope({
      ...base,
      meta: { defer_ref: '01KZ4PAE1EEWEZ6E6DF84P9AK5', until: { at: 1785790000000 } },
    });
    expect(EnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it('rejects a wall-clock until (no clocks, ADR 179)', () => {
    const env = makeEnvelope({
      ...base,
      meta: { defer_ref: '01KZ4PAE1EEWEZ6E6DF84P9AK5', until: '1h' },
    });
    expect(EnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it('leaves the deciding wait (ask_ref + duration until) untouched', () => {
    const env = makeEnvelope({
      ...base,
      from: 'nick',
      meta: { ask_ref: '01KZ4PAE1EEWEZ6E6DF84P9AK5', until: '1h' },
    });
    expect(EnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('leaves a bare wait untouched', () => {
    expect(EnvelopeSchema.safeParse(makeEnvelope(base)).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/protocol/src/envelope.test.ts -t 'deferring wait'`
Expected: FAIL — the four rejection cases pass validation today because nothing inspects
`defer_ref`.

- [ ] **Step 3: Add the schema**

In `packages/protocol/src/envelope.ts`, above the refine function:

```ts
/**
 * ADR 211 §1: what ends a deferral. A condition, never a clock — ADR 179's doctrine is that the
 * daemon runs no clocks on anyone's behalf, so there is deliberately no `{ at: <timestamp> }` arm.
 * `{ lane }` raises on the next lane-state act for that lane; `{ reply: true }` raises on the next
 * act from someone else on the deferred act's own thread.
 */
export const DeferUntilSchema = z.union([
  z.object({ lane: z.string().min(1) }).strict(),
  z.object({ reply: z.literal(true) }).strict(),
]);
export type DeferUntil = z.infer<typeof DeferUntilSchema>;
```

- [ ] **Step 4: Add the refine block**

In the same file, immediately after the existing `wait` + `ask_ref` block (~line 143):

```ts
// ADR 211 §1: the recipient's "not now, bring this back when ⟨cond⟩" rides `wait` rather than a
// thirteenth act (ADR 145 §4 — surfaces before more acts). When a `wait` names the act it postpones
// (`meta.defer_ref`), it MUST carry a well-formed `meta.until` condition. This is a THIRD shape of
// `wait`, distinguished by which meta key is present: bare (paused), `ask_ref` (deciding), and
// `defer_ref` (deferring). The deciding shape's `until` is a duration string and is checked above;
// this shape's `until` is a condition object and never a duration.
if (env.act === 'wait' && meta['defer_ref'] !== undefined) {
  const ref = meta['defer_ref'];
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['meta', 'defer_ref'],
      message: 'meta.defer_ref must be the id of the act being deferred',
    });
  }
  if (!DeferUntilSchema.safeParse(meta['until']).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['meta', 'until'],
      message:
        'a deferring wait (meta.defer_ref) requires meta.until — { lane: "<lane_id>" } or { reply: true }',
    });
  }
}
```

- [ ] **Step 5: Guard the two `wait` shapes against collision**

Still in the refine function, extend the existing `ask_ref` `wait` block's condition so the two
shapes cannot both apply. Change its guard from `env.act === 'wait' && meta['ask_ref'] !== undefined`
to:

```ts
if (env.act === 'wait' && meta['ask_ref'] !== undefined && meta['defer_ref'] === undefined) {
```

and add, inside the new `defer_ref` block:

```ts
if (meta['ask_ref'] !== undefined) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['meta', 'defer_ref'],
    message: 'a wait is either deciding (ask_ref) or deferring (defer_ref), never both',
  });
}
```

- [ ] **Step 6: Add the collision test**

```ts
it('rejects a wait that is both deciding and deferring', () => {
  const env = makeEnvelope({
    from: 'ryder',
    to: { kind: 'member' as const, name: 'stanley' },
    act: 'wait' as const,
    body: 'x',
    meta: {
      ask_ref: '01KZ4PAE1EEWEZ6E6DF84P9AK5',
      defer_ref: '01KZ4PAE1EEWEZ6E6DF84P9AK5',
      until: { reply: true },
    },
  });
  expect(EnvelopeSchema.safeParse(env).success).toBe(false);
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run packages/protocol/src/envelope.test.ts`
Expected: PASS, including the pre-existing `ask_ref` tests.

- [ ] **Step 8: Export the type**

Confirm `DeferUntil` and `DeferUntilSchema` are re-exported from `packages/protocol/src/index.ts`
alongside the other envelope exports. Add them if the file uses an explicit export list.

- [ ] **Step 9: Commit**

```bash
pnpm exec prettier --write packages/protocol/src/envelope.ts packages/protocol/src/envelope.test.ts packages/protocol/src/index.ts
git add packages/protocol/src/envelope.ts packages/protocol/src/envelope.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): validate the deferring wait (ADR 211 §1)"
```

---

### Task 3: The fold — `deferrals` and `raisedDeferrals`

**Files:**

- Modify: `packages/server/src/store/messages.ts` (add both functions immediately after
  `pendingInterrupts`)
- Test: `packages/server/src/store/messages.test.ts`

**Interfaces:**

- Consumes: `DeferUntil` from `@musterd/protocol` (Task 2); `Envelope` as `pendingInterrupts` uses it.
- Produces:
  ```ts
  export interface Deferral {
    target: string;
    by: string;
    ts: number;
    until: DeferUntil;
  }
  export function deferrals(messages: Envelope[], me: string): Map<string, Deferral>;
  export function raisedDeferrals(messages: Envelope[], me: string): Set<string>;
  ```
  Task 4 calls `deferrals` and `raisedDeferrals`. Task 6 calls `deferrals` for the footer. Task 7
  calls `deferrals` for the report exception.

Both functions are **pure** — envelopes in, derived state out, no DB — exactly like
`pendingInterrupts`. That is what makes them trivially testable.

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/src/store/messages.test.ts`:

```ts
import { deferrals, raisedDeferrals } from './messages.js';

// Minimal envelope factory for fold tests — the fold reads only these fields.
const env = (o: {
  id: string;
  from: string;
  to?: string;
  act: string;
  ts: number;
  thread?: string;
  meta?: Record<string, unknown>;
}) =>
  ({
    id: o.id,
    v: 'musterd/0.3',
    from: o.from,
    to: o.to ? { kind: 'member', name: o.to } : { kind: 'team' },
    act: o.act,
    body: '',
    ts: o.ts,
    ...(o.thread ? { thread: o.thread } : {}),
    ...(o.meta ? { meta: o.meta } : {}),
  }) as unknown as Envelope;

describe('deferrals (ADR 211 §3)', () => {
  it('folds a deferring wait onto its target', () => {
    const msgs = [
      env({ id: 'a1', from: 'stanley', to: 'ryder', act: 'ask', ts: 100 }),
      env({
        id: 'w1',
        from: 'ryder',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { reply: true } },
      }),
    ];
    const d = deferrals(msgs, 'ryder');
    expect(d.get('a1')).toMatchObject({ target: 'a1', by: 'w1', ts: 200, until: { reply: true } });
  });

  it('takes the newest wait per target — re-deferring supersedes', () => {
    const msgs = [
      env({ id: 'a1', from: 'stanley', to: 'ryder', act: 'ask', ts: 100 }),
      env({
        id: 'w1',
        from: 'ryder',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { reply: true } },
      }),
      env({
        id: 'w2',
        from: 'ryder',
        act: 'wait',
        ts: 300,
        meta: { defer_ref: 'a1', until: { lane: 'L1' } },
      }),
    ];
    expect(deferrals(msgs, 'ryder').get('a1')).toMatchObject({ by: 'w2', until: { lane: 'L1' } });
  });

  it('ignores a wait authored by someone else — only the recipient may defer', () => {
    const msgs = [
      env({ id: 'a1', from: 'stanley', to: 'ryder', act: 'ask', ts: 100 }),
      env({
        id: 'w1',
        from: 'izzo',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { reply: true } },
      }),
    ];
    expect(deferrals(msgs, 'ryder').size).toBe(0);
  });

  it('ignores a bare wait and a deciding wait', () => {
    const msgs = [
      env({ id: 'w1', from: 'ryder', act: 'wait', ts: 200 }),
      env({ id: 'w2', from: 'ryder', act: 'wait', ts: 300, meta: { ask_ref: 'a1', until: '1h' } }),
    ];
    expect(deferrals(msgs, 'ryder').size).toBe(0);
  });
});

describe('raisedDeferrals (ADR 211 §2)', () => {
  const ask = env({ id: 'a1', from: 'stanley', to: 'ryder', act: 'ask', ts: 100 });

  it('does not raise while nothing has happened', () => {
    const msgs = [
      ask,
      env({
        id: 'w1',
        from: 'ryder',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { reply: true } },
      }),
    ];
    expect(raisedDeferrals(msgs, 'ryder').size).toBe(0);
  });

  it('raises on a reply from someone else after the wait', () => {
    const msgs = [
      ask,
      env({
        id: 'w1',
        from: 'ryder',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { reply: true } },
      }),
      env({ id: 'm1', from: 'stanley', act: 'message', ts: 300, thread: 'a1' }),
    ];
    expect(raisedDeferrals(msgs, 'ryder').has('a1')).toBe(true);
  });

  it('does not raise on my own act in the thread', () => {
    const msgs = [
      ask,
      env({
        id: 'w1',
        from: 'ryder',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { reply: true } },
      }),
      env({ id: 'm1', from: 'ryder', act: 'message', ts: 300, thread: 'a1' }),
    ];
    expect(raisedDeferrals(msgs, 'ryder').has('a1')).toBe(false);
  });

  it('does not raise on a reply that predates the wait', () => {
    const msgs = [
      ask,
      env({ id: 'm1', from: 'stanley', act: 'message', ts: 150, thread: 'a1' }),
      env({
        id: 'w1',
        from: 'ryder',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { reply: true } },
      }),
    ];
    expect(raisedDeferrals(msgs, 'ryder').has('a1')).toBe(false);
  });

  it('raises on the FIRST lane-state act after the wait, whatever the state (deliberately loose)', () => {
    const msgs = [
      ask,
      env({
        id: 'w1',
        from: 'ryder',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { lane: 'L1' } },
      }),
      env({
        id: 'l1',
        from: 'izzo',
        act: 'message',
        ts: 300,
        meta: { lane_state: { lane: 'L1', state: 'active' } },
      }),
    ];
    expect(raisedDeferrals(msgs, 'ryder').has('a1')).toBe(true);
  });

  it('does not raise on a different lane moving', () => {
    const msgs = [
      ask,
      env({
        id: 'w1',
        from: 'ryder',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { lane: 'L1' } },
      }),
      env({
        id: 'l1',
        from: 'izzo',
        act: 'message',
        ts: 300,
        meta: { lane_state: { lane: 'L2', state: 'done' } },
      }),
    ];
    expect(raisedDeferrals(msgs, 'ryder').has('a1')).toBe(false);
  });

  it('does not raise a target whose thread was resolved', () => {
    const msgs = [
      ask,
      env({
        id: 'w1',
        from: 'ryder',
        act: 'wait',
        ts: 200,
        meta: { defer_ref: 'a1', until: { reply: true } },
      }),
      env({ id: 'r1', from: 'ryder', act: 'resolve', ts: 250, thread: 'a1' }),
      env({ id: 'm1', from: 'stanley', act: 'message', ts: 300, thread: 'a1' }),
    ];
    expect(raisedDeferrals(msgs, 'ryder').has('a1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/server/src/store/messages.test.ts -t 'deferral'`
Expected: FAIL with "deferrals is not a function".

- [ ] **Step 3: Implement the fold**

In `packages/server/src/store/messages.ts`, immediately after `pendingInterrupts`:

```ts
/**
 * ADR 211 §3: the deferrals `me` currently holds, latest-wins per target. A deferring `wait`
 * (`meta.defer_ref` + `meta.until`) postpones one directed act; re-deferring is appending another
 * wait, so this is a pure read-side collapse — no supersede column, no write-path side-effect,
 * the same shape as the steer supersession above.
 *
 * Only waits authored by `me` count: deferring someone else's inbox item is not expressible.
 */
export interface Deferral {
  /** the act being postponed */
  target: string;
  /** the deferring wait's id */
  by: string;
  /** the deferring wait's ts — the bar every condition is measured against */
  ts: number;
  until: DeferUntil;
}

export function deferrals(messages: Envelope[], me: string): Map<string, Deferral> {
  const out = new Map<string, Deferral>();
  for (const m of messages) {
    if (m.act !== 'wait' || m.from !== me) continue;
    const meta = (m.meta ?? {}) as { defer_ref?: unknown; until?: unknown };
    if (typeof meta.defer_ref !== 'string' || meta.defer_ref.length === 0) continue;
    const until = DeferUntilSchema.safeParse(meta.until);
    if (!until.success) continue;
    const prev = out.get(meta.defer_ref);
    // Newest wins; ties on ts break on id, as ULIDs sort deterministically.
    if (prev && (prev.ts > m.ts || (prev.ts === m.ts && prev.by >= m.id))) continue;
    out.set(meta.defer_ref, { target: meta.defer_ref, by: m.id, ts: m.ts, until: until.data });
  }
  return out;
}

/**
 * ADR 211 §2: the deferred targets whose condition has since fired. Both conditions reduce to one
 * question — does an act exist on this subject with a ts later than the deferral's? — so there is
 * one predicate over two subjects, and no clock.
 *
 * `{ lane }` is deliberately LOOSE: it fires on the first lane-state act for that lane after the
 * wait, which may not be the state the deferrer wanted. Naming a target state would be more precise
 * and more to get wrong; evidence can argue for it later.
 *
 * A target whose thread is closed (ADR 025 `resolve`) never raises — the deferral is inert because
 * the work it postponed is over.
 */
export function raisedDeferrals(messages: Envelope[], me: string): Set<string> {
  const held = deferrals(messages, me);
  if (held.size === 0) return new Set();
  const threadOf = new Map<string, string>();
  for (const m of messages) threadOf.set(m.id, m.thread ?? m.id);
  const resolved = new Set<string>();
  for (const m of messages) if (m.act === 'resolve' && m.thread) resolved.add(m.thread);

  const out = new Set<string>();
  for (const [target, d] of held) {
    const thread = threadOf.get(target) ?? target;
    if (resolved.has(thread)) continue;
    for (const m of messages) {
      if (m.ts <= d.ts) continue;
      if ('reply' in d.until) {
        if (m.from !== me && (m.thread ?? m.id) === thread) {
          out.add(target);
          break;
        }
      } else {
        const laneState = (m.meta ?? {}) as { lane_state?: { lane?: unknown } };
        if (laneState.lane_state?.lane === d.until.lane) {
          out.add(target);
          break;
        }
      }
    }
  }
  return out;
}
```

Add `DeferUntil` and `DeferUntilSchema` to the existing `@musterd/protocol` import at the top of the
file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/server/src/store/messages.test.ts`
Expected: PASS, including the pre-existing `pendingInterrupts` tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/store/messages.ts packages/server/src/store/messages.test.ts
git add packages/server/src/store/messages.ts packages/server/src/store/messages.test.ts
git commit -m "feat(server): fold deferring waits and derive which have raised (ADR 211 §2-3)"
```

---

### Task 4: Pendingness moves off the cursor

**Files:**

- Modify: `packages/server/src/transport/http.ts` (the `GET /messages`/inbox handler that serves
  `listInbox` — locate it with `grep -n "listInbox" packages/server/src/transport/http.ts`)
- Test: `packages/server/src/transport/inbox-deferred.test.ts` (create)

**Interfaces:**

- Consumes: `deferrals`, `raisedDeferrals` (Task 3).
- Produces: the inbox response gains a `deferred` block:
  ```ts
  { messages: MessageRow[], deferred: { target: string; until: DeferUntil; raised: boolean }[] }
  ```
  Task 6 renders `deferred`.

**Design note the implementer must not get wrong:** `listInbox`'s SQL is unchanged. The raise is
applied _after_ the query, by re-including raised targets that the cursor has passed. Do not add a
join or a subquery — the fold is pure and stays that way.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/transport/inbox-deferred.test.ts`. Follow the existing harness in
`packages/server/src/transport/residency-http.test.ts` for spinning a server + team + two members;
copy its setup rather than inventing one. The test body:

```ts
it('re-raises a deferred act the cursor has passed (ADR 211 §3)', async () => {
  // stanley asks ryder; ryder defers it until a reply; ryder then reads PAST it (cursor advances);
  // stanley replies. The act must come back even though the cursor is beyond it.
  const ask = await send(stanley, {
    to: 'ryder',
    act: 'ask',
    body: 'judge this',
    meta: { species: 'approve', tier: 'standard' },
  });
  await send(ryder, {
    to: 'stanley',
    act: 'wait',
    body: 'not now',
    meta: { defer_ref: ask.id, until: { reply: true } },
  });
  await send(stanley, { to: 'ryder', act: 'message', body: 'later thing' });
  await readInbox(ryder); // advances the cursor past the ask

  let res = await readInbox(ryder);
  expect(res.messages.map((m) => m.id)).not.toContain(ask.id);
  expect(res.deferred).toEqual([{ target: ask.id, until: { reply: true }, raised: false }]);

  await send(stanley, { to: 'ryder', act: 'message', body: 'ping', thread: ask.id });

  res = await readInbox(ryder);
  expect(res.messages.map((m) => m.id)).toContain(ask.id);
  expect(res.deferred).toEqual([{ target: ask.id, until: { reply: true }, raised: true }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/transport/inbox-deferred.test.ts`
Expected: FAIL — `res.deferred` is undefined and the raised ask is absent from `messages`.

- [ ] **Step 3: Implement the re-inclusion**

In the inbox handler in `http.ts`, after the existing `listInbox` call:

```ts
// ADR 211 §3: pendingness is unread-by-cursor OR deferred-and-raised. The cursor is a single
// monotonic ts and is NOT modified here — a raised act is re-included after the query instead, so
// an act the cursor sailed past still comes back. That is the whole point of the primitive.
const all = listInbox(ctx.db, member, {}).map(rowToEnvelope);
const held = deferrals(all, member.name);
const raised = raisedDeferrals(all, member.name);
const shown = new Set(messages.map((m) => m.id));
for (const id of raised) {
  if (shown.has(id)) continue;
  const row = all.find((m) => m.id === id);
  if (row) messages.push(envelopeToRow(row));
}
messages.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
const deferred = [...held.values()].map((d) => ({
  target: d.target,
  until: d.until,
  raised: raised.has(d.target),
}));
```

and add `deferred` to the JSON response. Reuse whatever row↔envelope helpers the handler already
uses; do not write new ones.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/transport/inbox-deferred.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify no existing inbox test regressed**

Run: `pnpm vitest run packages/server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/server/src/transport/http.ts packages/server/src/transport/inbox-deferred.test.ts
git add packages/server/src/transport/http.ts packages/server/src/transport/inbox-deferred.test.ts
git commit -m "feat(server): a raised deferral re-enters the inbox past the cursor (ADR 211 §3)"
```

---

### Task 5: Keep raised acts OUT of the wake ledger

**Files:**

- Modify: `packages/server/src/store/residency.ts` (the inbox-candidate derivation at ~line 663)
- Test: `packages/server/src/store/residency.test.ts`

**Interfaces:**

- Consumes: `deferrals` (Task 3).
- Produces: nothing new. This task exists to make an omission explicit and tested.

**Why this task exists:** wake candidates come from `listInbox(..., unreadOnly)`. Nothing in Tasks
1–4 tells `claimWakeLeases` about deferrals, so a _deferred but not yet raised_ act stays a wake
candidate — a Member who said "not now" would still be woken for it. And once increment 2 lands,
raised acts must become candidates _deliberately_, not by accident. Increment 0 therefore suppresses
deferred acts and does not add raised ones.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/store/residency.test.ts`:

```ts
it('does not wake a seat for an act it deferred (ADR 211 §4)', () => {
  // Setup mirrors the existing "wakes on an unread directed act" test in this file.
  const ask = insertMessage({ from: 'stanley', to: 'ryder', act: 'ask', ts: 100 });
  insertMessage({
    from: 'ryder',
    act: 'wait',
    ts: 200,
    meta: { defer_ref: ask.id, until: { lane: 'L1' } },
  });
  const leases = claimWakeLeases(db, team, { now: 300 });
  expect(leases.map((l) => l.act_id)).not.toContain(ask.id);
});

it('does not wake a seat for a RAISED deferral either — increment 2 turns that on (ADR 211 §4)', () => {
  const ask = insertMessage({ from: 'stanley', to: 'ryder', act: 'ask', ts: 100 });
  insertMessage({
    from: 'ryder',
    act: 'wait',
    ts: 200,
    meta: { defer_ref: ask.id, until: { lane: 'L1' } },
  });
  insertMessage({
    from: 'izzo',
    act: 'message',
    ts: 300,
    meta: { lane_state: { lane: 'L1', state: 'done' } },
  });
  const leases = claimWakeLeases(db, team, { now: 400 });
  expect(leases.map((l) => l.act_id)).not.toContain(ask.id);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/server/src/store/residency.test.ts -t 'defer'`
Expected: FAIL — both leases are currently issued.

- [ ] **Step 3: Suppress deferred acts in the candidate set**

In `claimWakeLeases`, where inbox candidates are gathered:

```ts
// ADR 211 §4: an act its recipient deferred is not a wake reason — they said "not now". Deferred
// targets are suppressed here whether or not their condition has fired: increment 0 ships the
// primitive WITHOUT wake eligibility, and increment 2 turns raised acts on deliberately behind the
// existing loop/seat controls. Landing that by omission would wake seats nobody decided to wake.
const deferredTargets = deferrals(inboxEnvelopes, member.name);
candidates = candidates.filter((c) => !deferredTargets.has(c.id));
```

Bind `inboxEnvelopes` to the same envelope list the surrounding code already builds for this member;
if it only has rows, map them with the row→envelope helper already used in this file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/server/src/store/residency.test.ts`
Expected: PASS, including every pre-existing wake test.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/store/residency.ts packages/server/src/store/residency.test.ts
git add packages/server/src/store/residency.ts packages/server/src/store/residency.test.ts
git commit -m "feat(server): a deferred act is not a wake reason (ADR 211 §4)"
```

---

### Task 6: Audit the deferral

**Files:**

- Modify: `packages/server/src/store/audit.ts` (add `'inbox.deferred'` to the action union)
- Modify: `packages/server/src/protocol/route.ts` (append the row on the send path, next to the
  existing `ask.deferred` append at ~line 538)
- Test: `packages/server/src/protocol/route.test.ts`

**Interfaces:**

- Consumes: the validated envelope from Task 2.
- Produces: audit rows `{ action: 'inbox.deferred', target: <deferred act id>, detail: { until: 'lane' | 'reply' } }`.
  Task 8's eval reads these.

- [ ] **Step 1: Write the failing test**

```ts
it('audits a deferring wait with the condition KIND only (ADR 211 Observability)', async () => {
  const ask = await send(stanley, {
    to: 'ryder',
    act: 'ask',
    body: 'x',
    meta: { species: 'consult', tier: 'advisory' },
  });
  await send(ryder, {
    to: 'stanley',
    act: 'wait',
    body: 'not now',
    meta: { defer_ref: ask.id, until: { lane: 'L1' } },
  });
  const rows = db.prepare("SELECT * FROM audit WHERE action = 'inbox.deferred'").all();
  expect(rows).toHaveLength(1);
  expect(rows[0].target).toBe(ask.id);
  expect(JSON.parse(rows[0].detail)).toEqual({ until: 'lane' });
  // The lane id and the body are NOT in the detail — shapes only (ADR 051).
  expect(rows[0].detail).not.toContain('L1');
  expect(rows[0].detail).not.toContain('not now');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/server/src/protocol/route.test.ts -t 'inbox.deferred'`
Expected: FAIL — zero rows.

- [ ] **Step 3: Add the audit action**

In `packages/server/src/store/audit.ts`, in the action union:

```ts
// ADR 211: a recipient deferred one directed act. Detail is the condition KIND only
// (`{ until: 'lane' | 'reply' }`) — never the lane id, never a body (ADR 051). There is no
// corresponding `raised` row: a raise is derived at read time and has no event, and emitting one
// would invent a fact the system does not have (ADR 189).
| 'inbox.deferred'
```

- [ ] **Step 4: Append the row on the send path**

In `packages/server/src/protocol/route.ts`, beside the existing `ask.deferred` append:

```ts
if (env.act === 'wait' && typeof meta['defer_ref'] === 'string') {
  const until = DeferUntilSchema.safeParse(meta['until']);
  if (until.success) {
    appendAudit(db, team.id, {
      actor: env.from,
      action: 'inbox.deferred',
      target: meta['defer_ref'],
      result: 'allow',
      detail: { until: 'reply' in until.data ? 'reply' : 'lane' },
    });
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run packages/server/src/protocol/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/server/src/store/audit.ts packages/server/src/protocol/route.ts packages/server/src/protocol/route.test.ts
git add packages/server/src/store/audit.ts packages/server/src/protocol/route.ts packages/server/src/protocol/route.test.ts
git commit -m "feat(server): audit a deferral as inbox.deferred, shapes only (ADR 211)"
```

---

### Task 7: CLI — `musterd inbox defer` and the deferred footer

**Files:**

- Modify: `packages/cli/src/commands/inbox.ts`
- Modify: `packages/cli/src/help/catalog.ts`
- Test: `packages/cli/src/commands/inbox.test.ts`

**Interfaces:**

- Consumes: the `deferred` block from Task 4; `http.send(slug, envelope)` from
  `packages/cli/src/client.ts:244`.
- Produces: the user-facing surface. Nothing consumes it.

- [ ] **Step 1: Write the failing tests**

```ts
it('sends a deferring wait for a lane condition', async () => {
  const sent: Envelope[] = [];
  const http = fakeHttp({ onSend: (_s, e) => sent.push(e) });
  const code = await inboxCmd(['defer', 'A1', '--until-lane', 'L1'], { http });
  expect(code).toBe(0);
  expect(sent[0]).toMatchObject({ act: 'wait', meta: { defer_ref: 'A1', until: { lane: 'L1' } } });
});

it('sends a deferring wait for a reply condition', async () => {
  const sent: Envelope[] = [];
  const http = fakeHttp({ onSend: (_s, e) => sent.push(e) });
  await inboxCmd(['defer', 'A1', '--until-reply'], { http });
  expect(sent[0]).toMatchObject({ act: 'wait', meta: { defer_ref: 'A1', until: { reply: true } } });
});

it('refuses a defer with no condition', async () => {
  const code = await inboxCmd(['defer', 'A1'], { http: fakeHttp({}) });
  expect(code).toBe(2);
});

it('refuses a defer with both conditions', async () => {
  const code = await inboxCmd(['defer', 'A1', '--until-lane', 'L1', '--until-reply'], {
    http: fakeHttp({}),
  });
  expect(code).toBe(2);
});

it('renders the deferred footer', async () => {
  const http = fakeHttp({
    inbox: {
      messages: [],
      deferred: [
        { target: 'A1', until: { lane: 'L1' }, raised: false },
        { target: 'A2', until: { reply: true }, raised: true },
      ],
    },
  });
  const out = await capture(() => inboxCmd([], { http }));
  expect(out).toContain('2 deferred');
  expect(out).toContain('1 raised');
});
```

Match the existing test harness in `inbox.test.ts` for `fakeHttp` / `capture`; copy its shape rather
than inventing one.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/inbox.test.ts -t 'defer'`
Expected: FAIL — `defer` is treated as an unknown argument.

- [ ] **Step 3: Add the subcommand**

At the top of the inbox command handler, before the firehose branch:

```ts
// ADR 211 §6: the CLI takes the surface investment, since "surfaces before more acts" (ADR 145 §4)
// means spending here rather than on a thirteenth verb. Agents reach the same primitive through
// team_send {act:'wait', meta:{defer_ref, until}} — no new MCP tool (ADR 144 makes tools expensive).
if (parsed.positional[0] === 'defer') {
  const target = parsed.positional[1];
  if (!target) {
    process.stderr.write(
      `${theme.err('✗')} musterd inbox defer <act_id> --until-lane <id> | --until-reply\n`,
    );
    return 2;
  }
  const lane = flagStr(parsed.flags, 'until-lane');
  const reply = Boolean(parsed.flags['until-reply']);
  if ((lane === undefined) === !reply) {
    process.stderr.write(`${theme.err('✗')} exactly one of --until-lane <id> or --until-reply\n`);
    return 2;
  }
  const until = reply ? { reply: true as const } : { lane: lane! };
  await http.send(
    team,
    makeEnvelope({
      from: identity.name,
      to: { kind: 'team' },
      act: 'wait',
      body: 'deferred',
      meta: { defer_ref: target, until },
    }),
  );
  process.stdout.write(
    `${theme.ok('✓')} deferred ${theme.accent(target)} until ${reply ? 'a reply' : `lane ${lane}`}\n`,
  );
  return 0;
}
```

- [ ] **Step 4: Add the footer**

After the existing unread footer is written:

```ts
// ADR 211 §5: ADR 117 requires the default view to include every unread. A deferred act is still
// unread and still counted — it is demoted below the fold with an honest line, never hidden.
const deferred = res.deferred ?? [];
if (deferred.length > 0) {
  const raisedCount = deferred.filter((d) => d.raised).length;
  const detail = raisedCount > 0 ? `, ${raisedCount} raised` : '';
  process.stdout.write(
    theme.meta(`${deferred.length} deferred${detail} — musterd inbox --deferred for detail`) + '\n',
  );
}
```

Add a `--deferred` filter branch listing each deferral's target and condition.

- [ ] **Step 5: Register the surface in help**

Add a `musterd inbox defer` entry to `packages/cli/src/help/catalog.ts` beside the other inbox
entries, or `pnpm guidance:check` will fail on the unlisted command.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/inbox.test.ts && pnpm guidance:check`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write packages/cli/src/commands/inbox.ts packages/cli/src/commands/inbox.test.ts packages/cli/src/help/catalog.ts
git add packages/cli/src/commands/inbox.ts packages/cli/src/commands/inbox.test.ts packages/cli/src/help/catalog.ts
git commit -m "feat(cli): musterd inbox defer + the deferred footer (ADR 211 §6)"
```

---

### Task 8: The long-deferred report exception

**Files:**

- Modify: `packages/server/src/store/staleness.ts` (or the report exception module the
  `stale_plan` warning lives in — confirm with `grep -n "stale_plan" packages/server/src`)
- Test: `packages/server/src/store/staleness.test.ts`

**Interfaces:**

- Consumes: `deferrals` (Task 3).
- Produces: a warning `{ kind: 'long_deferred', subject: <act id>, detail: string }` in the same
  shape `stale_plan` uses, surfaced by `musterd report`.

**Why:** this is the named failure mode. An act deferred `until-lane` on a lane that never moves
again is never raised, and postponement becomes a quiet way to drop work. Warn, never block, never
auto-un-defer — the system does not decide on a Member's behalf that a deferral has expired.

- [ ] **Step 1: Write the failing test**

```ts
it('warns on a deferral older than the threshold that has not raised (ADR 211 Failure mode)', () => {
  const now = 1785790000000;
  const week = 7 * 24 * 60 * 60 * 1000;
  const msgs = [
    env({ id: 'a1', from: 'stanley', to: 'ryder', act: 'ask', ts: now - week - 1000 }),
    env({
      id: 'w1',
      from: 'ryder',
      act: 'wait',
      ts: now - week - 500,
      meta: { defer_ref: 'a1', until: { lane: 'L1' } },
    }),
  ];
  const warnings = longDeferredWarnings(msgs, 'ryder', now);
  expect(warnings).toEqual([
    { kind: 'long_deferred', subject: 'a1', detail: 'deferred 7d ago until lane L1, never raised' },
  ]);
});

it('does not warn on a recent deferral', () => {
  const now = 1785790000000;
  const msgs = [
    env({ id: 'a1', from: 'stanley', to: 'ryder', act: 'ask', ts: now - 1000 }),
    env({
      id: 'w1',
      from: 'ryder',
      act: 'wait',
      ts: now - 500,
      meta: { defer_ref: 'a1', until: { lane: 'L1' } },
    }),
  ];
  expect(longDeferredWarnings(msgs, 'ryder', now)).toEqual([]);
});

it('does not warn on a deferral that has raised', () => {
  const now = 1785790000000;
  const week = 7 * 24 * 60 * 60 * 1000;
  const msgs = [
    env({ id: 'a1', from: 'stanley', to: 'ryder', act: 'ask', ts: now - week - 1000 }),
    env({
      id: 'w1',
      from: 'ryder',
      act: 'wait',
      ts: now - week - 500,
      meta: { defer_ref: 'a1', until: { lane: 'L1' } },
    }),
    env({
      id: 'l1',
      from: 'izzo',
      act: 'message',
      ts: now - 100,
      meta: { lane_state: { lane: 'L1', state: 'done' } },
    }),
  ];
  expect(longDeferredWarnings(msgs, 'ryder', now)).toEqual([]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/server/src/store/staleness.test.ts -t 'deferred'`
Expected: FAIL with "longDeferredWarnings is not a function".

- [ ] **Step 3: Implement**

```ts
/** ADR 211: a deferral this old that has not raised is the loss mode — warn, never block, never
 *  auto-un-defer. The system does not decide on a Member's behalf that a deferral has expired. */
export const LONG_DEFERRED_MS = 7 * 24 * 60 * 60 * 1000;

export function longDeferredWarnings(
  messages: Envelope[],
  me: string,
  now: number,
): { kind: 'long_deferred'; subject: string; detail: string }[] {
  const raised = raisedDeferrals(messages, me);
  const out: { kind: 'long_deferred'; subject: string; detail: string }[] = [];
  for (const d of deferrals(messages, me).values()) {
    if (raised.has(d.target)) continue;
    const age = now - d.ts;
    if (age < LONG_DEFERRED_MS) continue;
    const days = Math.floor(age / (24 * 60 * 60 * 1000));
    const cond = 'reply' in d.until ? 'a reply' : `lane ${d.until.lane}`;
    out.push({
      kind: 'long_deferred',
      subject: d.target,
      detail: `deferred ${days}d ago until ${cond}, never raised`,
    });
  }
  return out;
}
```

Wire it into the report derivation next to `stale_plan`, matching how that warning is collected and
directed at the affected Member (never broadcast).

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run packages/server/src/store/staleness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/store/staleness.ts packages/server/src/store/staleness.test.ts
git add packages/server/src/store/staleness.ts packages/server/src/store/staleness.test.ts
git commit -m "feat(server): warn on long-deferred acts that never raised (ADR 211)"
```

---

### Task 9: Docs, full gates, PR

**Files:**

- Modify: `docs/architecture/02-protocol.md` (the deferring `wait` shape)
- Modify: `docs/architecture/04-cli.md` (`musterd inbox defer`)
- Modify: `SPEC.md` (the `meta.defer_ref` / `meta.until` contract, beside the existing `wait` shapes)

Architecture chapters describe the shipped system, so they update in the increment that changes the
corresponding code (ADR 209 §5 states this rule explicitly).

- [ ] **Step 1: Update the three docs**

Document: the three shapes of `wait`; that `until` is a condition object here and a duration string
in the deciding shape; that only the recipient may defer; that a raised act re-enters the inbox
without the cursor moving; and that **wake eligibility is NOT in this increment**.

- [ ] **Step 2: Run the full gate set**

Run:

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
```

Expected: all PASS. Build before typecheck or you get phantom `.d.ts` errors.

- [ ] **Step 3: Commit and open the PR**

```bash
pnpm exec prettier --write docs/architecture/02-protocol.md docs/architecture/04-cli.md SPEC.md
git add docs/architecture/02-protocol.md docs/architecture/04-cli.md SPEC.md
git commit -m "docs(adr-211): protocol, CLI, and SPEC carry the deferring wait"
git push -u origin docs/deferred-wake-nudge
gh pr create --title "Deferred acts raise on a condition, never a clock (ADR 211)" --body "..."
gh pr merge --squash --auto --delete-branch
```

- [ ] **Step 4: Close the lane**

After the PR lands, `lane_submit` then `lane_resolve` with `pr`, `sha`, and `authorized_by` so the
audit log joins the seat to the landed SHA.

---

## Self-Review

**Spec coverage.** Decision §1 → Task 2. §2 → Task 3. §3 → Tasks 3, 4. §4 → Task 5. §5 → Task 7
(footer). §6 → Task 7 (CLI; the "no new MCP tool" decision is an omission, correctly requiring no
task). Failure mode → Task 8. Observability & Evaluation → Tasks 1, 6. Increments 0–1 → Tasks 2–8.
Increment 2 → deliberately out of scope, and Task 5 enforces the exclusion.

**Placeholders.** None. Every code step carries real code; the one `--body "..."` is a PR
description, written at PR time.

**Type consistency.** `DeferUntil` / `DeferUntilSchema` defined in Task 2, consumed in Tasks 3, 6.
`Deferral` / `deferrals` / `raisedDeferrals` defined in Task 3, consumed in Tasks 4, 5, 7, 8 under
those exact names. The inbox `deferred` block shape `{ target, until, raised }` is produced in Task
4 and consumed in Task 7 unchanged.

**Known soft spots for the implementer.** Task 4's `envelopeToRow`/`rowToEnvelope` and Task 5's
`inboxEnvelopes` bind to helpers that already exist in those files — read the surrounding code
before writing, and reuse rather than adding new converters. Task 7's `fakeHttp`/`capture` come from
the existing `inbox.test.ts` harness.
