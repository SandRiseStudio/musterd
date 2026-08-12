# Eligible Sets (Increment 1) Implementation Plan

> **For agentic workers:** implement this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT dispatch writing subagents — this lane is owned by a seat (`01KZVP1KKNGKR933C07PX3E7X2`, ryder) and every commit must carry that seat's identity. Work it inline.

**Goal:** Let a seat address an act to 2–4 named teammates, any one of whom discharges it — so "either of you know?" stops being two directed sends or a team-wide shrug.

**Architecture:** Not a new recipient kind. The act is addressed `to:{kind:'team'}` and carries `meta.eligible: ['a','b']`, which narrows **accountability** without narrowing **visibility**. That keeps the `messages` schema, the `to_kind` CHECK, and all seven copies of the inbox visibility predicate untouched, and needs no migration. Any-of discharge stays derivable from the existing accept/decline-with-`in_reply_to` signal, so ADR 090's derive-don't-store doctrine holds.

**Tech Stack:** TypeScript, zod (protocol is zod 3, MCP is zod 4 — see Global Constraints), better-sqlite3, vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-12-eligible-set-addressing-design.md`

**Scope:** Increment 1 only — the primitive on the **free rail**. The wake gate (increment 2) is out of scope: do not touch `packages/server/src/store/residency.ts`. Its hold window is deliberately gated on this increment producing measurable traffic.

## Global Constraints

- **`MAX_ELIGIBLE = 4`**, and 2 is the minimum. Exact values, everywhere.
- **Eligible acts are exactly `message`, `request_help`, `challenge`.** No others.
- **No migration.** The `messages` schema, `to_kind` CHECK, and all seven copies of the `(to_member = ? OR to_kind IN ('team','broadcast'))` predicate stay untouched. If you find yourself writing SQL DDL, stop — you have taken a wrong turn.
- **`pendingInterrupts` stays pure over envelopes.** It takes no `Database`. Do not add one.
- **Zod version split:** `packages/protocol` is on zod 3; `packages/mcp` is on zod 4 and rebuilds enums locally rather than importing protocol schema objects (see the comment at `packages/mcp/src/tools/send.ts:105`). Follow that pattern — do not import a protocol zod object into an MCP `registerTool` input schema.
- **ADR number:** not yet allocated. Pick the next free number off `origin/main` **at PR time** (numbers collide both ways; `pnpm adr-numbers:check` fails on duplicates or an H1 that doesn't match the filename). Until then write `ADR NNN` in comments and fix them in Task 8.
- **Git:** branch `ryder/eligible-set-addressing` (already exists, already carries the spec). Commit after every task. Never `git checkout <file>` to undo — it destroys uncommitted work across the file.
- **Never run `pnpm format`.** Use `pnpm exec prettier --write <your files>`.
- **Gates before PR:** `pnpm build` must run before `pnpm typecheck` (phantom `.d.ts` errors otherwise) and before `pnpm lint`. `pnpm lint` is a separate gate from `format:check`.

## File Structure

| File                                    | Responsibility                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/envelope.ts`     | `MAX_ELIGIBLE`, `ELIGIBLE_ACTS`, `eligibleOf()`, and shape validation in `actMetaRules`. The single definition every other package reads. |
| `packages/server/src/protocol/route.ts` | Roster validation (the half `actMetaRules` structurally cannot do).                                                                       |
| `packages/server/src/store/delivery.ts` | `recipientsOf` — the ledger's obligation holders.                                                                                         |
| `packages/server/src/store/messages.ts` | Discharge set + `actionNeeded` narrowing in `pendingInterrupts`.                                                                          |
| `packages/mcp/src/tools/send.ts`        | `to` accepts an array; arity normalisation.                                                                                               |
| `packages/mcp/src/coerce.ts`            | Comment-only: the 2+ bounce is now a real path.                                                                                           |
| `packages/cli/src/commands/send.ts`     | `--to a,b`.                                                                                                                               |
| `packages/server/src/transport/http.ts` | Inbox `discharged` trace. **Sequencing risk — see Task 7.**                                                                               |
| `docs/decisions/NNN-*.md`               | The ADR.                                                                                                                                  |

---

### Task 1: Protocol — the eligible set's shape ✅ DONE (28a82b94)

**Files:**

- Modify: `packages/protocol/src/envelope.ts` (add exports after `DeferUntilSchema` ~line 29; add a rule inside `actMetaRules`)
- Test: `packages/protocol/src/envelope.test.ts`

**Interfaces:**

- Produces: `MAX_ELIGIBLE: number` (= 4), `ELIGIBLE_ACTS: ReadonlySet<Act>`, `eligibleOf(meta: Record<string, unknown> | null | undefined): string[] | null`. Tasks 3, 4, 5, 6 all import `eligibleOf` — it is the **only** reader of the shape, so no package re-implements the parse.

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/src/envelope.test.ts`. Follow the existing file's import style for `EnvelopeSchema`.

```ts
import { EnvelopeSchema, eligibleOf, MAX_ELIGIBLE } from './envelope.js';

const base = {
  id: 'm1',
  v: 1,
  team: 'revive',
  from: 'ryder',
  to: { kind: 'team' as const },
  body: 'either of you know why the daemon pinned?',
  ts: 1_786_000_000_000,
};

describe('meta.eligible', () => {
  it('accepts 2 names on an eligible act', () => {
    const r = EnvelopeSchema.safeParse({
      ...base,
      act: 'message',
      meta: { eligible: ['stanley', 'izzo'] },
    });
    expect(r.success).toBe(true);
  });

  it('accepts the cap exactly', () => {
    const r = EnvelopeSchema.safeParse({
      ...base,
      act: 'message',
      meta: { eligible: ['a', 'b', 'c', 'd'] },
    });
    expect(r.success).toBe(true);
  });

  it('rejects more than MAX_ELIGIBLE', () => {
    const r = EnvelopeSchema.safeParse({
      ...base,
      act: 'message',
      meta: { eligible: ['a', 'b', 'c', 'd', 'e'] },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('@team');
  });

  it('rejects a single name — that is a directed act', () => {
    const r = EnvelopeSchema.safeParse({
      ...base,
      act: 'message',
      meta: { eligible: ['stanley'] },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a repeated seat', () => {
    const r = EnvelopeSchema.safeParse({
      ...base,
      act: 'message',
      meta: { eligible: ['stanley', 'stanley'] },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an eligible set on handoff — two owners is zero owners', () => {
    const r = EnvelopeSchema.safeParse({
      ...base,
      act: 'handoff',
      meta: { eligible: ['stanley', 'izzo'] },
    });
    expect(r.success).toBe(false);
  });

  it.each(['message', 'request_help', 'challenge'])('allows it on %s', (act) => {
    const r = EnvelopeSchema.safeParse({
      ...base,
      act,
      meta: { eligible: ['stanley', 'izzo'] },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-array', () => {
    const r = EnvelopeSchema.safeParse({
      ...base,
      act: 'message',
      meta: { eligible: 'stanley,izzo' },
    });
    expect(r.success).toBe(false);
  });

  it('leaves envelopes without the key alone', () => {
    const r = EnvelopeSchema.safeParse({ ...base, act: 'message' });
    expect(r.success).toBe(true);
  });

  it('eligibleOf returns null for absent, malformed, and mixed-type values', () => {
    expect(eligibleOf(null)).toBeNull();
    expect(eligibleOf({})).toBeNull();
    expect(eligibleOf({ eligible: 'a' })).toBeNull();
    expect(eligibleOf({ eligible: ['a', 3] })).toBeNull();
    expect(eligibleOf({ eligible: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('MAX_ELIGIBLE is four', () => {
    expect(MAX_ELIGIBLE).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/protocol test -- envelope`
Expected: FAIL — `eligibleOf` is not exported.

- [ ] **Step 3: Add the exports**

In `packages/protocol/src/envelope.ts`, add `import type { Act } from './acts.js';` to the existing `./acts.js` import line, then insert after `DeferUntilSchema` (~line 29):

```ts
/**
 * ADR NNN: the eligible set — 2–`MAX_ELIGIBLE` named seats, **any one of whom discharges the act**.
 *
 * Four is the cap for two reasons, and the second is the load-bearing one. Above four, a named set
 * is `@team` with extra steps and the sender should be made to say so. But the cap also bounds the
 * escalation tail a later increment walks: at a 5-minute hold, four seats is ~20 minutes and at most
 * four `wake_cost` charges. Uncapped, both the latency and the spend of a serial walk are unbounded.
 */
export const MAX_ELIGIBLE = 4;

/**
 * Acts that may carry an eligible set. Deliberately narrow: a `handoff` to two seats is incoherent
 * (two owners is zero owners), and accept/decline/defer/steer are structurally single-target. That
 * restriction is what earns a single global "first answer wins" rule instead of a per-act table.
 */
export const ELIGIBLE_ACTS: ReadonlySet<Act> = new Set<Act>([
  'message',
  'request_help',
  'challenge',
]);

/**
 * The eligible set on an envelope's meta, or `null` when there isn't one (or it is malformed).
 *
 * The single reader of the shape — server, MCP, and CLI all come through here so no package can
 * interpret `meta.eligible` differently from the schema that validated it. A mixed-type array
 * returns `null` rather than a filtered list: silently dropping a name would mean silently dropping
 * an obligation.
 */
export function eligibleOf(meta: Record<string, unknown> | null | undefined): string[] | null {
  const v = meta?.['eligible'];
  if (!Array.isArray(v) || !v.every((n) => typeof n === 'string')) return null;
  return v as string[];
}
```

- [ ] **Step 4: Add the validation rule**

Inside `actMetaRules`, after the `ask` block (~line 110) and before the `wait` rules:

```ts
// ADR NNN: the eligible set. **Shape only.** `actMetaRules` receives `{act, thread, meta}` — no
// `from`, no roster handle — so "these seats exist, none has left, none is an observer, and none
// is the sender" is necessarily a server-side check in `routeEnvelope`. Two-layer by structure,
// not by preference.
if (meta['eligible'] !== undefined) {
  const names = eligibleOf(meta);
  const issue = (message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['meta', 'eligible'], message });
  if (!names) {
    issue('meta.eligible must be an array of seat names');
  } else if (!ELIGIBLE_ACTS.has(env.act)) {
    issue(
      `act "${env.act}" cannot carry meta.eligible (only ${[...ELIGIBLE_ACTS].join(', ')}) — ` +
        'an act with one owner cannot have several',
    );
  } else if (names.some((n) => n.trim().length === 0)) {
    issue('meta.eligible must not contain an empty name');
  } else if (names.length < 2) {
    issue('meta.eligible needs at least 2 seats — to reach one seat, name it in `to`');
  } else if (names.length > MAX_ELIGIBLE) {
    issue(`meta.eligible allows at most ${MAX_ELIGIBLE} seats — to reach more, use @team`);
  } else if (new Set(names).size !== names.length) {
    issue('meta.eligible must not name the same seat twice');
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @musterd/protocol test -- envelope`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/protocol/src/envelope.ts packages/protocol/src/envelope.test.ts
git add packages/protocol/src/envelope.ts packages/protocol/src/envelope.test.ts
git commit -m "Protocol: meta.eligible shape — 2-4 seats on message/request_help/challenge"
```

---

### Task 2: Server — roster validation in routeEnvelope ✅ DONE (2287423d)

> **Plan corrections found while implementing:** `MusterdError('invalid', …)` is not a real code — `ERROR_CODES` has no `invalid`; use `validation` (422). There is no `postEnvelope`/`del` helper in `integration.test.ts` — the idiom is `post('/teams/dawn/messages', { envelope }, tok)` returning `{status, json}`, with `server.db` for state the API cannot reach. Later tasks writing integration tests should follow the file, not the plan's sketch.

**Files:**

- Modify: `packages/server/src/protocol/route.ts` (insert immediately before `// Resolve recipients.` ~line 249)
- Test: `packages/server/src/transport/integration.test.ts`

**Interfaces:**

- Consumes: `eligibleOf` from Task 1.
- Produces: nothing importable. A rejected send throws `MusterdError('not_found' | 'invalid')`.

**Design note:** recipient resolution and the live websocket push are **deliberately unchanged**. An eligible-set act is team-addressed, so every seat still receives the push and sees it in their inbox. Only the _ledger_ (Task 3) and the _obligation predicate_ (Task 4) narrow. That is the whole point of separating visibility from accountability — if you find yourself editing the `recipients` query, you are building the wrong design.

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/src/transport/integration.test.ts`, following the file's existing helper style for creating a team and posting an envelope.

```ts
it('rejects an eligible set naming a seat that does not exist', async () => {
  const res = await postEnvelope({
    from: 'ryder',
    to: { kind: 'team' },
    act: 'message',
    body: 'either of you know?',
    meta: { eligible: ['stanley', 'nobody-here'] },
  });
  expect(res.status).toBe(404);
  expect(res.body.error).toContain('nobody-here');
});

it('rejects an eligible set naming the sender', async () => {
  const res = await postEnvelope({
    from: 'ryder',
    to: { kind: 'team' },
    act: 'message',
    body: 'either of you know?',
    meta: { eligible: ['ryder', 'stanley'] },
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('sender');
});

it('accepts a valid eligible set and stores ONE team-addressed row', async () => {
  const res = await postEnvelope({
    from: 'ryder',
    to: { kind: 'team' },
    act: 'message',
    body: 'either of you know?',
    meta: { eligible: ['stanley', 'izzo'] },
  });
  expect(res.status).toBe(200);
  const row = db
    .prepare('SELECT to_kind, to_member, meta FROM messages WHERE id = ?')
    .get(res.body.id);
  expect(row.to_kind).toBe('team');
  expect(row.to_member).toBeNull();
  expect(JSON.parse(row.meta).eligible).toEqual(['stanley', 'izzo']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/server test -- integration`
Expected: FAIL — the two rejection cases return 200.

- [ ] **Step 3: Implement**

Add `eligibleOf` to the existing `@musterd/protocol` import in `route.ts`, then insert immediately before the `// Resolve recipients.` comment:

```ts
// ADR NNN: the roster half of eligible-set validation. `actMetaRules` validated the shape; only
// the daemon can validate the *names*, and it rejects rather than dropping — a question addressed
// to a seat that cannot answer it is worse than a rejected send, because the sender goes on
// believing someone owes them a reply.
const eligible = eligibleOf(outgoingEnv.meta);
if (eligible) {
  for (const name of eligible) {
    const seat = getMemberByName(ctx.db, team.id, name);
    if (!seat || seat.left_at !== null) {
      throw new MusterdError('not_found', `no member "${name}" in ${team.slug}`);
    }
    if (seat.observer === 1) {
      throw new MusterdError(
        'invalid',
        `seat "${name}" is an observer and cannot owe an answer (ADR 063)`,
      );
    }
    if (seat.id === sender.id) {
      throw new MusterdError('invalid', `meta.eligible cannot name the sender ("${name}")`);
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/server test -- integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/protocol/route.ts packages/server/src/transport/integration.test.ts
git add packages/server/src/protocol/route.ts packages/server/src/transport/integration.test.ts
git commit -m "Server: validate eligible-set names against the roster, reject rather than drop"
```

---

### Task 3: Ledger — the obligation holders ✅ DONE (5443638b)

> **Design correction found while implementing:** any-of discharge is NOT free. `answerBy` is scoped per recipient (`from_member = recipientId`, `delivery.ts:78`), so one seat's answer left the others owing. Required a genuinely new `anyAnswer(db, msg)` clause, applied only when an eligible set is present. **Task 7's `discharged` trace must use the same any-sender query** — not `answerBy`. Spec updated with a dated correction.

**Files:**

- Modify: `packages/server/src/store/delivery.ts` (`recipientsOf`, line 30)
- Test: `packages/server/src/store/delivery.test.ts`

**Interfaces:**

- Consumes: `eligibleOf` from Task 1.
- Produces: no new exports. `recipientsOf` is module-private; the behaviour surfaces through the existing `GET /messages/:id/delivery`.

- [ ] **Step 1: Write the failing test**

```ts
it('an eligible-set act is owed by the named seats, not the roster', () => {
  // team of four: ryder (sender), stanley, izzo, wanderer
  const id = insertTeamMessage({
    from: 'ryder',
    act: 'message',
    meta: { eligible: ['stanley', 'izzo'] },
  });
  const delivery = actDelivery(db, id);
  expect(delivery.recipients.map((r) => r.seat).sort()).toEqual(['izzo', 'stanley']);
});

it('a plain team act is still owed by the whole roster', () => {
  const id = insertTeamMessage({ from: 'ryder', act: 'message' });
  expect(
    actDelivery(db, id)
      .recipients.map((r) => r.seat)
      .sort(),
  ).toEqual(['izzo', 'stanley', 'wanderer']);
});

it('the first accept answers it for every eligible seat', () => {
  const id = insertTeamMessage({
    from: 'ryder',
    act: 'message',
    meta: { eligible: ['stanley', 'izzo'] },
  });
  insertDirectMessage({ from: 'stanley', to: 'ryder', act: 'accept', meta: { in_reply_to: id } });
  const delivery = actDelivery(db, id);
  expect(delivery.recipients.every((r) => r.state === 'answered')).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/server test -- delivery`
Expected: FAIL — the first test returns all three non-sender seats.

- [ ] **Step 3: Implement**

Add `eligibleOf` to the `@musterd/protocol` import. Add a meta parser beside the existing `isUrgent` (which already does this inline — reuse the new helper there too if it is a clean edit, but do not refactor further):

```ts
function metaOf(msg: MessageRow): Record<string, unknown> | null {
  if (!msg.meta) return null;
  try {
    return JSON.parse(msg.meta) as Record<string, unknown>;
  } catch {
    return null;
  }
}
```

Then in `recipientsOf`, after the `to_kind === 'member'` branch and before the roster query:

```ts
// ADR NNN: an eligible set narrows OBLIGATION, not visibility. The act is team-addressed and every
// seat can read it — but only the named seats owe an answer, and the ledger tracks what is owed.
// Note this branch is strictly *more* precise than the roster query below: the names are pinned in
// the envelope, so a seat that later leaves is still visibly the one who was asked, where a plain
// team act can only be approximated by the roster of now.
const eligible = eligibleOf(metaOf(msg));
if (eligible) {
  const stmt = db.prepare<[string, string], RecipientRow>(
    'SELECT id, name FROM members WHERE team_id = ? AND name = ?',
  );
  return eligible.flatMap((name) => {
    const row = stmt.get(msg.team_id, name);
    return row ? [row] : [];
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/server test -- delivery`
Expected: PASS. The third test should pass without extra work — `answerBy` already handles any-of.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/store/delivery.ts packages/server/src/store/delivery.test.ts
git add packages/server/src/store/delivery.ts packages/server/src/store/delivery.test.ts
git commit -m "Ledger: an eligible-set act is owed by the named seats, not the roster"
```

---

### Task 4: Stand-down — discharge in the interrupt line

**Files:**

- Modify: `packages/server/src/store/messages.ts` (`pendingInterrupts`, lines 220–272)
- Test: `packages/server/src/store/messages.test.ts`

**Interfaces:**

- Consumes: `eligibleOf` from Task 1.
- Produces: no signature change. `pendingInterrupts(messages, me, opts)` keeps its exact shape and stays pure over envelopes.

**Critical constraint:** this function has **two consumers with opposite needs** (see its own comment at line 223) — the free interrupt line, and `claimWakeLeases`, which spends real money. Widening `actionNeeded` widens both. That is acceptable here **only** because the line-265 gate still requires `urgent`/`steer`/obligation, so a plain eligible-set message never reaches the paid rail. Do not touch line 265.

- [ ] **Step 1: Write the failing tests**

```ts
const eligibleMsg = (over: Partial<Envelope> = {}): Envelope => ({
  id: 'm1',
  v: 1,
  team: 'revive',
  from: 'ryder',
  to: { kind: 'team' },
  act: 'message',
  body: 'either of you know?',
  ts: 1_000,
  meta: { eligible: ['stanley', 'izzo'], urgent: true, urgent_reason: 'daemon is pinned' },
  ...over,
});

it('an eligible seat owes an urgent eligible-set act', () => {
  expect(pendingInterrupts([eligibleMsg()], 'stanley')).toHaveLength(1);
});

it('a seat outside the set owes nothing', () => {
  expect(pendingInterrupts([eligibleMsg()], 'wanderer')).toHaveLength(0);
});

it('the first accept stands the others down', () => {
  const accept: Envelope = {
    id: 'm2',
    v: 1,
    team: 'revive',
    from: 'izzo',
    to: { kind: 'member', name: 'ryder' },
    act: 'accept',
    body: 'the lockfile predicate self-heals',
    ts: 2_000,
    meta: { in_reply_to: 'm1' },
  };
  expect(pendingInterrupts([eligibleMsg(), accept], 'stanley')).toHaveLength(0);
});

it('an eligible set NARROWS request_help instead of raising it team-wide', () => {
  const m = eligibleMsg({ act: 'request_help' });
  expect(pendingInterrupts([m], 'stanley')).toHaveLength(1);
  expect(pendingInterrupts([m], 'wanderer')).toHaveLength(0);
});

it('regression: a plain request_help still raises for everyone', () => {
  const m = eligibleMsg({ act: 'request_help', meta: { urgent: true, urgent_reason: 'blocked' } });
  expect(pendingInterrupts([m], 'wanderer')).toHaveLength(1);
});

it('regression: a directed act is unaffected', () => {
  const m = eligibleMsg({
    to: { kind: 'member', name: 'wanderer' },
    meta: { urgent: true, urgent_reason: 'blocked' },
  });
  expect(pendingInterrupts([m], 'wanderer')).toHaveLength(1);
});

it('a non-urgent eligible-set act is inbox-class, not interrupt-class', () => {
  const m = eligibleMsg({ meta: { eligible: ['stanley', 'izzo'] } });
  expect(pendingInterrupts([m], 'stanley')).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/server test -- messages`
Expected: FAIL — the eligible seat gets 0 (the act is team-addressed, so `actionNeeded` is false).

- [ ] **Step 3: Implement**

Add `eligibleOf` to the `@musterd/protocol` import. Inside `pendingInterrupts`, extend the existing loop at line 232–233 (do not add a second pass):

```ts
const resolved = new Set<string>();
// ADR NNN: an eligible-set act is discharged by the FIRST accept/decline naming it — for every
// eligible seat at once. Built in the same pass as `resolved` and for the same reason: this
// predicate has no DB handle, so it cannot call the ledger's `actAnswered`. It does not need one —
// the discharging act is an envelope in the same list.
const discharged = new Set<string>();
for (const m of messages) {
  if (m.act === 'resolve' && m.thread) resolved.add(m.thread);
  if (m.act === 'accept' || m.act === 'decline') {
    const ref = (m.meta as { in_reply_to?: unknown } | null | undefined)?.['in_reply_to'];
    if (typeof ref === 'string') discharged.add(ref);
  }
}
```

Then replace `actionNeeded` (line 242):

```ts
// An eligible set REPLACES the default obligation rule rather than adding to it — which is what
// narrows `request_help` from "every seat on the team" (its behaviour without a set, below) to the
// named few. Discharge is checked here so a stood-down act stops being action-needed everywhere at
// once, including for the `steer` winner scan.
const actionNeeded = (m: Envelope) => {
  if (m.act === 'resolve') return false;
  const names = eligibleOf(m.meta as Record<string, unknown> | null | undefined);
  if (names) return names.includes(me) && !discharged.has(m.id);
  return m.act === 'request_help' || (m.to.kind === 'member' && m.to.name === me);
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/server test -- messages`
Expected: PASS, including all three regression cases.

- [ ] **Step 5: Run the wake-rail tests, which share this predicate**

Run: `pnpm --filter @musterd/server test -- residency`
Expected: PASS, unchanged. If anything here fails, you have widened the paid rail — stop and re-read the constraint above.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/server/src/store/messages.ts packages/server/src/store/messages.test.ts
git add packages/server/src/store/messages.ts packages/server/src/store/messages.test.ts
git commit -m "Stand-down: the first accept discharges an eligible-set act for every named seat"
```

---

### Task 5: MCP — `to` accepts an array

**Files:**

- Modify: `packages/mcp/src/tools/send.ts` (`recipient()` at line 42; `to` input schema at line 100; `DESCRIPTION` at line 30)
- Modify: `packages/mcp/src/coerce.ts` (comment at line 83 only)
- Test: `packages/mcp/src/tools/send.test.ts`, `packages/mcp/src/coerce.test.ts`

**Interfaces:**

- Consumes: `eligibleOf`, `MAX_ELIGIBLE` from Task 1.
- Produces: `normalizeTo(to: string | string[]): { to: Recipient; eligible: string[] | null }` — exported from `send.ts` so Task 6 can mirror the arity rules without re-deriving them.

**Why `coerce.ts` needs almost nothing:** `recipientShape` (line 64) already repairs `[]` → default and `[one]` → string, and returns `null` for 2+ meaning "no repair applied." Once the schema accepts arrays, "no repair" is exactly right — the value passes through untouched. Only the comment is now false.

- [ ] **Step 1: Write the failing tests**

```ts
import { normalizeTo } from './send.js';

describe('normalizeTo', () => {
  it('a bare string is a directed act', () => {
    expect(normalizeTo('stanley')).toEqual({
      to: { kind: 'member', name: 'stanley' },
      eligible: null,
    });
  });

  it('@team and @broadcast are unchanged', () => {
    expect(normalizeTo('@team')).toEqual({ to: { kind: 'team' }, eligible: null });
    expect(normalizeTo('@broadcast')).toEqual({ to: { kind: 'broadcast' }, eligible: null });
  });

  it('an empty array is @team', () => {
    expect(normalizeTo([])).toEqual({ to: { kind: 'team' }, eligible: null });
  });

  it('a one-element array is a directed act — the existing coerce repair, preserved', () => {
    expect(normalizeTo(['stanley'])).toEqual({
      to: { kind: 'member', name: 'stanley' },
      eligible: null,
    });
  });

  it('two names become a team act with an eligible set', () => {
    expect(normalizeTo(['stanley', 'izzo'])).toEqual({
      to: { kind: 'team' },
      eligible: ['stanley', 'izzo'],
    });
  });

  it('five names are rejected, pointing at @team', () => {
    expect(() => normalizeTo(['a', 'b', 'c', 'd', 'e'])).toThrow(/@team/);
  });

  it('rejects @team inside a list — a set is named seats or it is not a set', () => {
    expect(() => normalizeTo(['stanley', '@team'])).toThrow(/@team/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/mcp test -- send`
Expected: FAIL — `normalizeTo` is not exported.

- [ ] **Step 3: Implement**

Replace `recipient()` in `send.ts` with:

```ts
function recipient(to: string): Recipient {
  if (to === '@team') return { kind: 'team' };
  if (to === '@broadcast') return { kind: 'broadcast' };
  return { kind: 'member', name: to };
}

/**
 * ADR NNN: `to` normalised by **arity**. The 0- and 1-element rows are exactly what `coerce.ts`
 * already repaired, so this is additive — the only behaviour that changes is that 2+ stops bouncing.
 *
 * The array is surface sugar: a multi-name send is persisted and audited as a team act carrying
 * `meta.eligible`, never as an array-shaped recipient, so nothing downstream of `routeEnvelope`
 * learns a new wire shape.
 */
export function normalizeTo(to: string | string[]): {
  to: Recipient;
  eligible: string[] | null;
} {
  const names = Array.isArray(to) ? to : [to];
  if (names.length === 0) return { to: { kind: 'team' }, eligible: null };
  if (names.length === 1) return { to: recipient(names[0]!), eligible: null };
  if (names.length > MAX_ELIGIBLE) {
    throw new Error(
      `too many recipients (${names.length}) — name at most ${MAX_ELIGIBLE} seats, or use @team`,
    );
  }
  const alias = names.find((n) => n.startsWith('@'));
  if (alias) {
    throw new Error(`"${alias}" cannot appear in a list of seats — send to ${alias} on its own`);
  }
  return { to: { kind: 'team' }, eligible: names };
}
```

Change the `to` input schema (line 100):

```ts
        to: z
          .union([z.string(), z.array(z.string())])
          .default('@team')
          .describe(
            "member name, or '@team', or '@broadcast' — or 2-4 names, any one of whom can answer",
          ),
```

In the handler, replace the `recipient(args.to)` call site:

```ts
let normalized;
try {
  normalized = normalizeTo(args.to);
} catch (e) {
  return textResult(e instanceof Error ? e.message : String(e));
}
if (normalized.eligible) meta['eligible'] = normalized.eligible;
```

…and pass `normalized.to` wherever `recipient(args.to)` was used.

Append to `DESCRIPTION`:

```
'Name 2-4 seats in `to` when either of them could answer — they each owe a reply, the first ' +
'accept/decline stands the rest down, and everyone else still sees it. ' +
'e.g. {act:"message",to:["stanley","izzo"],body:"either of you know why the daemon pinned?"}.';
```

Fix the now-false comment in `coerce.ts:83`:

```ts
return null; // 2+ recipients: an eligible set (ADR NNN) — the schema takes it as-is.
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/mcp test`
Expected: PASS, including the existing `coerce` tests for `[]` and `[one]` — those are the regression guard that the repair path is untouched.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/mcp/src/tools/send.ts packages/mcp/src/coerce.ts packages/mcp/src/tools/send.test.ts
git add packages/mcp/src/tools/send.ts packages/mcp/src/coerce.ts packages/mcp/src/tools/send.test.ts
git commit -m "MCP: team_send accepts 2-4 names in to, normalised by arity"
```

---

### Task 6: CLI — `--to a,b`

**Files:**

- Modify: `packages/cli/src/commands/send.ts` (`parseRecipient` at line 69; `sendCommand` at line 78)
- Test: `packages/cli/src/commands/send.test.ts`

**Interfaces:**

- Consumes: `MAX_ELIGIBLE` from Task 1. Mirrors Task 5's arity rules — keep the messages consistent, but the CLI keeps its own `CliError` exit codes rather than importing from the MCP package.

- [ ] **Step 1: Write the failing tests**

```ts
it('--to a,b becomes a team act with an eligible set', () => {
  const { to, eligible } = parseRecipients('stanley,izzo');
  expect(to).toEqual({ kind: 'team' });
  expect(eligible).toEqual(['stanley', 'izzo']);
});

it('a single name is still a directed act', () => {
  expect(parseRecipients('stanley')).toEqual({
    to: { kind: 'member', name: 'stanley' },
    eligible: null,
  });
});

it('@team is unchanged', () => {
  expect(parseRecipients('@team')).toEqual({ to: { kind: 'team' }, eligible: null });
});

it('tolerates spaces around commas', () => {
  expect(parseRecipients('stanley, izzo').eligible).toEqual(['stanley', 'izzo']);
});

it('rejects five names with exit code 2', () => {
  expect(() => parseRecipients('a,b,c,d,e')).toThrow(CliError);
});

it('rejects an unknown @alias, as before', () => {
  expect(() => parseRecipients('@nobody')).toThrow(/use @team or @broadcast/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/cli test -- send`
Expected: FAIL — `parseRecipients` is not exported.

- [ ] **Step 3: Implement**

Replace `parseRecipient` with:

```ts
/**
 * ADR NNN: `--to a,b` names an eligible set — 2–MAX_ELIGIBLE seats, any one of whom can answer.
 * A single value keeps its exact existing behaviour, including the `@alias` rejection.
 */
export function parseRecipients(to: string): { to: Recipient; eligible: string[] | null } {
  const names = to
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length <= 1) return { to: parseRecipient(names[0] ?? '@team'), eligible: null };
  if (names.length > MAX_ELIGIBLE) {
    throw new CliError(
      `too many recipients (${names.length}) — name at most ${MAX_ELIGIBLE} seats, or use @team`,
      2,
    );
  }
  const alias = names.find((n) => n.startsWith('@'));
  if (alias) {
    throw new CliError(`"${alias}" cannot appear in a list of seats — send to it on its own`, 2);
  }
  return { to: { kind: 'team' }, eligible: names };
}
```

Keep `parseRecipient` exactly as it is (it is the single-value path). In `sendCommand`, replace the `parseRecipient(to)` call:

```ts
const { to: recipientTo, eligible } = parseRecipients(to);
if (eligible) meta['eligible'] = eligible;
```

…and use `recipientTo` where `parseRecipient(to)` was used. Update the usage string:

```ts
throw new CliError('usage: musterd send --to <name|a,b|@team> --act <act> <body...>', 2);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/cli test -- send`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/cli/src/commands/send.ts packages/cli/src/commands/send.test.ts
git add packages/cli/src/commands/send.ts packages/cli/src/commands/send.test.ts
git commit -m "CLI: musterd send --to a,b names an eligible set"
```

---

### Task 7: The "who answered" trace on the inbox

**Files:**

- Modify: `packages/server/src/transport/http.ts` (`GET /inbox`, ~lines 3299–3345)
- Test: `packages/server/src/transport/integration.test.ts`

> **⚠ SEQUENCING RISK — read before starting.** `transport/http.ts` is also declared by wanderer's **active** lane `01KZVNCACS707B5FZET19T98XD` (non-risky lanes / review-loop breaker). Surface overlap is advisory, not blocking, but do not silently edit around a live owner. Before this task: check `lane_board`, and if that lane is still active, `team_send {act:'message', to:'wanderer'}` to agree an order — or land Tasks 1–6 and 8 first and do this one after their merge. Tasks 1–6 do not depend on this task.

**Interfaces:**

- Consumes: `eligibleOf` (Task 1), the `discharged` concept from Task 4 (recomputed server-side here — do not export it from `messages.ts`; that function must stay pure).
- Produces: `GET /inbox` response gains `discharged: { id: string; by: string }[]`, sibling to the existing `answered: string[]`.

**Why this exists:** stand-down that doesn't tell you is the same defect as an instrument that goes quiet. The second seat may be mid-draft; they need to know the question was taken, and by whom, so they can drop it or disagree.

- [ ] **Step 1: Write the failing test**

```ts
it('an eligible seat sees who took the act it no longer owes', async () => {
  const asked = await postEnvelope({
    from: 'ryder',
    to: { kind: 'team' },
    act: 'message',
    body: 'either of you know?',
    meta: { eligible: ['stanley', 'izzo'] },
  });
  await postEnvelope({
    from: 'izzo',
    to: { kind: 'member', name: 'ryder' },
    act: 'accept',
    body: 'the lockfile predicate self-heals',
    meta: { in_reply_to: asked.body.id },
  });
  const inbox = await getInbox({ as: 'stanley' });
  expect(inbox.body.discharged).toContainEqual({ id: asked.body.id, by: 'izzo' });
});

it('a seat with nothing discharged gets an empty list, not a missing key', async () => {
  const inbox = await getInbox({ as: 'wanderer' });
  expect(inbox.body.discharged).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/server test -- integration`
Expected: FAIL — `discharged` is undefined.

- [ ] **Step 3: Implement**

In the `GET /inbox` handler, beside the existing `answered` computation (~line 3332):

```ts
// ADR NNN: stand-down needs a trace. For each eligible-set act in this inbox that someone else
// has already answered, name the seat that took it — the reader may be mid-draft, and a silent
// retirement would destroy that work AND deny them the chance to disagree with what landed.
const discharged = messages.flatMap((m) => {
  const names = eligibleOf(m.meta as Record<string, unknown> | null | undefined);
  if (!names || !names.includes(member.name)) return [];
  const answer = ctx.db
    .prepare<[string, string], { from_name: string }>(
      `SELECT mem.name AS from_name
               FROM messages msg JOIN members mem ON mem.id = msg.from_member
              WHERE msg.team_id = ?
                AND msg.act IN ('accept','decline')
                AND json_extract(msg.meta, '$.in_reply_to') = ?
              ORDER BY msg.ts ASC LIMIT 1`,
    )
    .get(team.id, m.id);
  return answer ? [{ id: m.id, by: answer.from_name }] : [];
});
```

…and add `discharged` to the JSON response beside `answered`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/server test -- integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/transport/http.ts packages/server/src/transport/integration.test.ts
git add packages/server/src/transport/http.ts packages/server/src/transport/integration.test.ts
git commit -m "Inbox: name the seat that took an eligible-set act you no longer owe"
```

---

### Task 8: The ADR, the spec's home, and the gates

**Files:**

- Create: `docs/decisions/NNN-eligible-sets.md`
- Modify: `SPEC.md` (the recipient list, lines 43–48)
- Modify: `docs/superpowers/specs/2026-08-12-eligible-set-addressing-design.md` (status line: replace "ADR number assigned at PR time" with the allocated number)

- [ ] **Step 1: Allocate the ADR number**

```bash
git fetch origin && git ls-tree --name-only origin/main docs/decisions/ | tail -5
```

Take the next free number. The H1 **must** match the filename or `pnpm adr-numbers:check` fails.

- [ ] **Step 2: Write the ADR**

Required sections: `## Context`, `## Decision`, `## Consequences`, and — mandatory for every ADR ≥ 060 — `## Observability & Evaluation`. Carry the spec's evaluation section over verbatim:

- **Emitted:** `meta.eligible` makes every eligible-set act self-describing in the audit log and firehose; no new audit action for the send. (`residency.wake_held` belongs to increment 2 — do not claim it here.)
- **Evaluated:** (1) adoption — eligible-set acts per week, and the `coerce.ts:83` bounce rate falling toward zero; (2) duplicate answers avoided — distinct seats producing an accept/decline per act, predicted ~1; (3) strand rate versus the directed-act baseline.
- **Reopening trigger:** (2) sustained above 1.3, or (3) above the directed baseline ⇒ reopen; the likely fix is making stand-down interrupt-class rather than inbox-class.

Note in `## Consequences` that increment 2 (the wake gate) is **deliberately unbuilt**, and that lease expiry is not an "unanswered" signal — a wake lease is discharged by _reporting_ the wake, not by answering it.

- [ ] **Step 3: Update SPEC.md**

Add a fourth bullet under the recipient list:

```markdown
- `{"kind":"team"}` with `meta.eligible: ["a","b"]` — delivered to every Member as above, but only the
  named 2–4 Members owe an answer, and the first `accept`/`decline` discharges it for all of them.
  Visibility is team-wide; accountability is the named set (ADR NNN).
```

- [ ] **Step 4: Replace every `ADR NNN` placeholder**

```bash
grep -rn "ADR NNN" packages/ docs/ SPEC.md
```

Expected after fixing: no results.

- [ ] **Step 5: Run the full gate**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm adr-numbers:check && pnpm vocab:check && pnpm guidance:check
```

Build **before** typecheck (phantom `.d.ts` errors otherwise). All must pass.

- [ ] **Step 6: Commit**

```bash
git add docs/decisions SPEC.md docs/superpowers/specs packages
git commit -m "ADR NNN: eligible sets — accountability narrows, visibility does not"
```

---

### Task 9: Exercise it live, then submit

A green test suite is not evidence the primitive works — every prior increment that shipped on tests alone had a gap the first real use found.

- [ ] **Step 1: Send one for real**

From this seat, `team_send` with `to: ['<two live seats>']` and a genuine question. Confirm: both named seats see it, a third seat sees it in their inbox but owes nothing, and the roster/firehose render it without breaking.

- [ ] **Step 2: Have one answer, and check the other**

Confirm the second seat's obligation is gone and `discharged` names the answerer.

- [ ] **Step 3: Confirm the negative case**

`GET /messages/:id/delivery` on the act lists exactly the eligible seats — not the roster.

- [ ] **Step 4: Record what the exercise found**

Append a dated note to the spec's `## Observability & Evaluation` section. If the exercise found nothing, say so explicitly — "exercised, no gap found" is a result.

- [ ] **Step 5: PR and submit the lane**

```bash
git push -u origin ryder/eligible-set-addressing
gh pr create --fill
gh pr merge --squash --auto --delete-branch
```

Then `lane_submit` on `01KZVP1KKNGKR933C07PX3E7X2` with the PR number.

---

## Self-Review

**Spec coverage:** three rules → Task 1; two-layer validation → Tasks 1–2; storage (no migration) → asserted in Task 2 Step 1; ledger → Task 3; stand-down → Tasks 4 and 7; inbox-class not interrupt-class → Task 4; surface arity table → Tasks 5–6; cap → Tasks 1, 5, 6; observability → Task 8. The wake gate is increment 2 and correctly absent.

**Type consistency:** `eligibleOf` has one signature (`Record<string, unknown> | null | undefined` → `string[] | null`) used identically in Tasks 3, 4, 5, 7. `normalizeTo` (MCP) and `parseRecipients` (CLI) deliberately differ in name and error type — same rules, different error conventions per package — and both return `{to, eligible}`.

**Known gap, accepted:** Task 7 depends on a file a live lane declares. Tasks 1–6 and 8 are independent of it, so the plan stays executable if Task 7 has to wait.
