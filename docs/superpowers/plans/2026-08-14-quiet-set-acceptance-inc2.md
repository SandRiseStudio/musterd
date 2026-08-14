# Quiet-set acceptance increment 2 — Implementation Plan

> **Parked 2026-08-14.** Increment-1 Eval (izzo #837) fired the spec's pre-registered stop: attention, not candidate supply. Do not execute this plan as a latency fix. If revived, it is a concentration fix (cap-4-by-grade, primary = top-reviewer share) against a fresh Eval with no routing changes in the window — not this n=18/28h sample. Lane `01KZY1Q9TW` released.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (musterd note: no writing subagents — ADR 150 / AGENTS.md. Execute inline in the wanderer seat, lane `01KZY1Q9TWMP5PD8E1EJVZHVEC`.)

**Goal:** Fan out the non-risky acceptance ask to the live quiet set (2–4 names, first accept wins) instead of sole-targeting one seat.

**Architecture:** Increment 1 already drops busy agents from `pickReviewCounterpart`. Increment 2 lists that same quiet pool (graded, capped at `MAX_ELIGIBLE`), and when it has 2–4 names the daemon composes one `ask` addressed `to: {kind:'team'}` with `meta.eligible`. Size 1 stays today's directed ask. Size 0 stays the ADR 191 wake path. `owed_reviews` matches eligible names, not only `to_member`. `ELIGIBLE_ACTS` gains `ask`. First accept discharges the rest (ADR 254 any-of, already built). Unnamed seats cannot verdict.

**Tech Stack:** TypeScript monorepo (pnpm), better-sqlite3, vitest, existing `eligibleOf` / `MAX_ELIGIBLE` / `routeEnvelope` roster validation / `anyAnswer` stand-down.

**Spec:** `docs/superpowers/specs/2026-08-12-quiet-set-acceptance-design.md` (increment 2). Increment 1 is already shipped (ADR 260).

**Gate (do not skip):** ADR 260 / the spec pre-register that increment 2 is not implied. Izzo owns lane `01M011HP1E` — the increment-1 Eval on the post-arming window. If that Eval is "attention, not candidate supply" (or increment 1 plus web-low already hits the quiet-bucket 32% on small volume), **stop rather than executing this plan**. Do not write `ELIGIBLE_ACTS` until those numbers are in.

## Global Constraints

- Fan-out is **non-risky, non-exempt** only. Risky lanes stay one live human (ADR 172). Exempt low stays no ask (ADR 234).
- Quiet-set size **2–4** → eligible-set ask. Size **1** → today's directed ask (ADR 254's floor is 2 names; do not invent a singleton set). Size **0** → today's ADR 191 single wake / `no_candidate`. Do not wake-fan-out.
- `reviewer` on the wire stays the **best-grade name** (wire-compat). `eligible: string[]` is added beside it when the set was used.
- Do **not** mark the ask `urgent`. Obligation-class (`lane_review` + `pendingInterrupts` `opts.obligations`) already interrupts each named seat once `ask` is in `ELIGIBLE_ACTS`.
- Do **not** change the ADR 235 submit hint, the 24h sweep, or `review_debt` (ambient visibility, not a pickup path).
- Do **not** edit ADR 254's frozen `## Decision` (it names the three acts). New ADR amends the act list; ADR 254 gets a dated Consequences pointer only.
- Do **not** edit ADR 260's frozen `## Decision`. Dated Consequences note that increment 2 shipped, after the Eval said so.
- `FEATURE_EPOCH` 11 → 12 (older seats cannot parse `ask`+`eligible`). Do **not** bump `PROTOCOL_VERSION` (ADR 254 didn't).
- `pnpm adr:next` only **after** the draft PR exists (ADR 223). Never invent a number. Never Prettier `docs/`.
- Seat trailer on every commit: `Co-authored-by: wanderer <wanderer@revive.musterd>`.
- Stay off `docs/superpowers/specs/2026-08-12-quiet-set-acceptance-design.md` and ADR 260 until izzo's Eval lane (`01M011HP1E`) reports — those files are izzo's read surface. The spec status-line edit is Task 6, after the Eval.

### File map

| File | Role |
| ---- | ---- |
| `packages/protocol/src/envelope.ts` | `ask` ∈ `ELIGIBLE_ACTS` |
| `packages/protocol/src/envelope.test.ts` | `ask` may carry eligible; `handoff` still must not |
| `packages/protocol/src/lanes.ts` | `review.eligible?: string[]` |
| `packages/protocol/src/feature-epoch.ts` | 11 → 12 |
| `SPEC.md` | eligible-set act list includes `ask` |
| `packages/server/src/store/review.ts` | `pickReviewQuietSet` → `ReviewPick[]`; `pickReviewCounterpart` = first or null |
| `packages/server/src/store/review.test.ts` | quiet set of 2; busy third excluded; cap 4; singleton still one |
| `packages/server/src/store/orientation.ts` | `owed_reviews` matches `meta.eligible` |
| `packages/server/src/store/orientation.test.ts` | team-addressed eligible ask appears for each named seat |
| `packages/server/src/transport/http.ts` | compose eligible-set ask when set ≥ 2; ready-row `detail.eligible` |
| `packages/server/src/protocol/route.ts` | unnamed seat cannot `accept` a `lane_review` ask that carries `eligible` |
| `packages/server/src/transport/integration.test.ts` | submit / owed / first-accept / unnamed-refuse / exempt+risky unchanged |
| `docs/decisions/NNN-*.md` | new ADR (number after draft PR) |
| `docs/architecture/02-protocol.md`, `03-server.md` | one-line updates |
| spec + ADR 254/260 Consequences | dated notes, Task 6 only |

---

### Task 1: Protocol — `ask` may carry `meta.eligible`

**Files:**
- Modify: `packages/protocol/src/envelope.ts` (`ELIGIBLE_ACTS`)
- Modify: `packages/protocol/src/envelope.test.ts` (the allow/reject tables)
- Modify: `packages/protocol/src/lanes.ts` (`LaneResultSchema.review`)
- Modify: `packages/protocol/src/feature-epoch.ts`
- Modify: `SPEC.md` (the eligible-set sentence)

**Interfaces:**
- Consumes: existing `ELIGIBLE_ACTS`, `actMetaRules`, `LaneResultSchema`.
- Produces: `ELIGIBLE_ACTS` = `{message, request_help, challenge, ask}`; `review.eligible` optional `string[]`; `FEATURE_EPOCH = 12`.

- [ ] **Step 1: Failing tests**

In `packages/protocol/src/envelope.test.ts`, change the two tables:

```ts
it.each(['message', 'request_help', 'challenge', 'ask'])(
  'allows an eligible set on %s',
  (act) => {
    expect(withEligible(['Lin', 'Ada2'], act).meta).toMatchObject({ eligible: ['Lin', 'Ada2'] });
  },
);

it.each(['handoff', 'accept', 'decline', 'defer', 'steer', 'status_update', 'resolve'])(
  'rejects an eligible set on %s',
  (act) => {
    expect(() => withEligible(['Lin', 'Ada2'], act)).toThrow(/cannot carry meta\.eligible/);
  },
);

it('ELIGIBLE_ACTS includes ask', () => {
  expect([...ELIGIBLE_ACTS].sort()).toEqual([
    'ask',
    'challenge',
    'message',
    'request_help',
  ]);
});
```

Remove the old `ELIGIBLE_ACTS is exactly the three question-shaped acts` assertion (it will fail for the right reason once `ask` is in the set; replacing it is clearer than leaving a wrong name).

In `packages/protocol/src/lanes.ts` tests, if none exist for `LaneResultSchema.review`, add one next to the schema (or in `packages/protocol/src/lanes.test.ts` if that file already covers `LaneResultSchema`):

```ts
it('review.eligible is optional and round-trips', () => {
  const parsed = LaneResultSchema.parse({
    lane: minimalLane,
    warnings: [],
    review: { reviewer: 'gee', eligible: ['gee', 'bo'] },
  });
  expect(parsed.review?.eligible).toEqual(['gee', 'bo']);
});
```

Use whatever `minimalLane` the existing lanes tests already build — do not invent a second lane fixture.

- [ ] **Step 2: Run — they must fail**

```bash
pnpm --filter @musterd/protocol exec vitest run src/envelope.test.ts
```

Expected: `allows an eligible set on ask` FAIL (`cannot carry meta.eligible`). `ELIGIBLE_ACTS includes ask` FAIL (set is the three acts). Do not implement yet.

- [ ] **Step 3: Minimal implementation**

`packages/protocol/src/envelope.ts`:

```ts
export const ELIGIBLE_ACTS: ReadonlySet<Act> = new Set<Act>([
  'message',
  'request_help',
  'challenge',
  'ask',
]);
```

Update the comment above the set: question-shaped acts **plus** the acceptance `ask` (quiet-set increment 2). A `handoff` to two seats is still incoherent.

`packages/protocol/src/lanes.ts` — inside `LaneResultSchema.review`, after `reviewer`:

```ts
      reviewer: z.string().optional(),
      /** Quiet-set increment 2: the named acceptors when the ask was an eligible set (2–4).
       *  Absent on a directed singleton ask and on no-ask paths. `reviewer` stays the
       *  best-grade name for wire-compat. */
      eligible: z.array(z.string().min(1)).min(2).max(4).optional(),
```

`packages/protocol/src/feature-epoch.ts` — bump 11 → 12 and add:

```
// Epoch 12 — quiet-set increment 2: `ask` may carry `meta.eligible`. An epoch-11 seat's
// EnvelopeSchema rejects that combination, so it cannot participate in a fan-out
// acceptance ask. The roster `behind` chip is the cue.
```

`SPEC.md` — the eligible-set sentence currently lists three acts. Change it to include `ask`. Do not rewrite the rest of the paragraph.

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @musterd/protocol exec vitest run src/envelope.test.ts src/lanes.test.ts
```

Expected: PASS. Existing `handoff` rejection still red.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/envelope.ts packages/protocol/src/envelope.test.ts \
  packages/protocol/src/lanes.ts packages/protocol/src/feature-epoch.ts SPEC.md
git commit -m "$(cat <<'EOF'
protocol: ask may carry an eligible set

Quiet-set increment 2: fan-out the acceptance ask without a new recipient
kind. handoff still must not. Epoch 12 — older seats reject ask+eligible.

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 2: Picker returns the quiet set

**Files:**
- Modify: `packages/server/src/store/review.test.ts`
- Modify: `packages/server/src/store/review.ts`

**Interfaces:**
- Consumes: Task 1 (`MAX_ELIGIBLE` already in protocol). Same candidate filter as increment 1 (`pickReviewCounterpart`).
- Produces: `pickReviewQuietSet(db, teamId, lane, worker, presenceTimeoutMs): ReviewPick[]` — graded (`cross_family` then `cross_model`), capped at `MAX_ELIGIBLE`, busy dropped, unknown kept, agents only. `pickReviewCounterpart` becomes `pickReviewQuietSet(...)[0] ?? null` so every existing caller/test stays the singleton.

- [ ] **Step 1: Failing tests**

Append after the increment-1 describe in `packages/server/src/store/review.test.ts`:

```ts
describe('pickReviewQuietSet — quiet-set increment 2', () => {
  const acted = (
    db: ReturnType<typeof seed>['db'],
    team: { id: string },
    actor: string,
    agoMs: number,
  ) =>
    db
      .prepare(
        `INSERT INTO audit (id, team_id, actor, action, target, result, ts, created_at)
         VALUES (?, ?, ?, 'x.did', NULL, 'allow', ?, ?)`,
      )
      .run(`aud-set-${actor}-${String(agoMs)}`, team.id, actor, Date.now() - agoMs, Date.now() - agoMs);

  async function setOf(setup: (h: ReturnType<typeof seed>) => void) {
    const { openLane } = await import('./lanes.js');
    const { pickReviewQuietSet } = await import('./review.js');
    const h = seed();
    agent(h.db, h.team, 'worker', 'claude-opus-5');
    setup(h);
    const lane = openLane(h.db, h.team.id, 'dawn', 'worker', {
      title: 'a change',
      claim: true,
    });
    return pickReviewQuietSet(h.db, h.team.id, lane, 'worker', TIMEOUT);
  }

  it('returns two quiet peers, cross_family before cross_model, not the busy third', async () => {
    const set = await setOf(({ db, team }) => {
      agent(db, team, 'gptbot', 'gpt-5.6-sol');
      agent(db, team, 'dolly', 'claude-opus-4-8');
      agent(db, team, 'busy', 'gpt-5.6-codex');
      acted(db, team, 'gptbot', 180_000);
      acted(db, team, 'dolly', 180_000);
      acted(db, team, 'busy', 5_000);
    });
    expect(set.map((p) => p.reviewer)).toEqual(['gptbot', 'dolly']);
    expect(set[0]?.grade).toBe('cross_family');
    expect(set[1]?.grade).toBe('cross_model');
  });

  it('a single quiet peer is a one-element array, not an eligible set', async () => {
    const set = await setOf(({ db, team }) => {
      agent(db, team, 'gptbot', 'gpt-5.6-sol');
      acted(db, team, 'gptbot', 180_000);
    });
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
  });

  it('pickReviewCounterpart is still the best-grade name (wire-compat)', async () => {
    const { openLane } = await import('./lanes.js');
    const { pickReviewCounterpart, pickReviewQuietSet } = await import('./review.js');
    const h = seed();
    agent(h.db, h.team, 'worker', 'claude-opus-5');
    agent(h.db, h.team, 'gptbot', 'gpt-5.6-sol');
    agent(h.db, h.team, 'dolly', 'claude-opus-4-8');
    const lane = openLane(h.db, h.team.id, 'dawn', 'worker', { title: 'a change', claim: true });
    const one = pickReviewCounterpart(h.db, h.team.id, lane, 'worker', TIMEOUT);
    const set = pickReviewQuietSet(h.db, h.team.id, lane, 'worker', TIMEOUT);
    expect(one?.reviewer).toBe(set[0]?.reviewer);
  });
});
```

- [ ] **Step 2: Run — must fail**

```bash
pnpm --filter @musterd/server exec vitest run src/store/review.test.ts
```

Expected: FAIL (`pickReviewQuietSet` is not exported). Do not implement yet.

- [ ] **Step 3: Implement**

In `packages/server/src/store/review.ts`, import `MAX_ELIGIBLE` from `@musterd/protocol`. Extract the candidate filter currently inside `pickReviewCounterpart` into a local `quietAgentCandidates(...)`. Then:

```ts
export function pickReviewQuietSet(
  db: Database,
  teamId: string,
  lane: Lane,
  worker: string,
  presenceTimeoutMs: number,
): ReviewPick[] {
  const candidates = quietAgentCandidates(db, teamId, worker, presenceTimeoutMs);
  return pickLadderAll(db, teamId, worker, candidates, { agentsOnly: true }).slice(
    0,
    MAX_ELIGIBLE,
  );
}

export function pickReviewCounterpart(
  db: Database,
  teamId: string,
  lane: Lane,
  worker: string,
  presenceTimeoutMs: number,
): ReviewPick | null {
  return pickReviewQuietSet(db, teamId, lane, worker, presenceTimeoutMs)[0] ?? null;
}
```

`pickLadderAll` is `pickLadder` without taking only `graded[0]` — return one `ReviewPick` per graded candidate, same sort (`cross_family` before `cross_model`). Keep `pickLadder` as `pickLadderAll(...)[0] ?? null` if `pickWakeReviewer` still uses it, **or** switch `pickLadder` callers to `pickLadderAll` and delete the singleton helper. Do not change `pickHumanReviewer` or `pickWakeReviewer` policy.

- [ ] **Step 4: Tests pass, including increment 1**

```bash
pnpm --filter @musterd/server exec vitest run src/store/review.test.ts
```

Expected: PASS, including the increment-1 describe and the graded-ladder describe.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/review.ts packages/server/src/store/review.test.ts
git commit -m "$(cat <<'EOF'
server: list the quiet review set, not only the best name

pickReviewCounterpart stays the first of that set so existing routing
callers do not change. Cap MAX_ELIGIBLE; busy agents already dropped.

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 3: `owed_reviews` sees the set

**Files:**
- Modify: `packages/server/src/store/orientation.test.ts`
- Modify: `packages/server/src/store/orientation.ts`

**Interfaces:**
- Consumes: a team-addressed `ask` with `meta.eligible` and `meta.lane_review` (`to_member` NULL).
- Produces: `deriveNext(...).owed_reviews` includes the lane for **each** named seat, and for nobody else.

- [ ] **Step 1: Failing test**

Inside `describe('owed_reviews — the verdicts someone is waiting on from ME (ADR 233)')` in `packages/server/src/store/orientation.test.ts`, next to the existing directed-ask cases:

```ts
  it('an eligible-set lane_review ask is owed by each named seat, not by a busy unnamed one', () => {
    const { db, team, nick, stanley } = seed();
    const { row: izzo } = addMember(db, team, { kind: 'agent', name: 'izzo', role: '' });
    const { row: miley } = addMember(db, team, { kind: 'agent', name: 'miley', role: '' });
    const lane = openLane(db, team.id, 'revive', 'nick', { title: 'nick built this', claim: true });
    updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
    insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'ask-set',
        team: 'revive',
        from: 'nick',
        to: { kind: 'team' },
        act: 'ask',
        body: '[lane] acceptance requested',
        ts: 5_000,
        meta: {
          species: 'approve',
          tier: 'standard',
          lane_review: { lane: lane.id },
          eligible: ['stanley', 'izzo'],
        },
      }),
    );
    expect(deriveNext(db, team.id, 'revive', 'stanley').owed_reviews.map((r) => r.ask_id)).toEqual([
      'ask-set',
    ]);
    expect(deriveNext(db, team.id, 'revive', 'izzo').owed_reviews.map((r) => r.ask_id)).toEqual([
      'ask-set',
    ]);
    expect(deriveNext(db, team.id, 'revive', 'miley').owed_reviews).toEqual([]);
  });
```

`insertMessage` already accepts `toMemberId: null` for team acts (ADR 254 tests in this package). If the helper's signature in this file is the directed-only `askReview`, do not reuse it — insert as above. Import `addMember` if this describe does not already.

- [ ] **Step 2: Run — must fail**

```bash
pnpm --filter @musterd/server exec vitest run src/store/orientation.test.ts
```

Expected: FAIL (`owed_reviews` empty — INNER JOIN on `to_member` drops the row).

- [ ] **Step 3: Fix the query**

In `packages/server/src/store/orientation.ts`, replace the `owed_reviews` SQL. Keep the directed arm. Add the eligible arm. `LEFT JOIN` so `to_member IS NULL` rows survive:

```ts
  const owed_reviews = db
    .prepare<[string, string, string], OwedRow>(
      `SELECT m.id AS ask_id, m.ts AS ts, mf.name AS from_name,
              json_extract(m.meta, '$.lane_review.lane') AS lane_id
         FROM messages m
         JOIN members mf ON mf.id = m.from_member
         LEFT JOIN members mt ON mt.id = m.to_member
        WHERE m.team_id = ?
          AND m.act = 'ask'
          AND json_extract(m.meta, '$.lane_review.lane') IS NOT NULL
          AND (
            mt.name = ?
            OR EXISTS (
              SELECT 1 FROM json_each(json_extract(m.meta, '$.eligible'))
               WHERE json_each.value = ?
            )
          )
        ORDER BY m.ts ASC, m.id ASC`,
    )
    .all(teamId, member, member)
```

Do not drop the existing `flatMap` that skips closed / own lanes. Do not match a bare team ask with no `eligible` — that would make every team-addressed ask look owed.

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @musterd/server exec vitest run src/store/orientation.test.ts
```

Expected: PASS, including every existing directed `owed_reviews` case.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/orientation.ts packages/server/src/store/orientation.test.ts
git commit -m "$(cat <<'EOF'
server: owed_reviews matches eligible names, not only to_member

An eligible-set acceptance ask has to_member NULL. Without this join the
fan-out would vanish from the brief that exists to re-surface it.

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 4: Compose the eligible-set ask; unnamed seats cannot verdict

**Files:**
- Modify: `packages/server/src/transport/http.ts` (`deliverLaneAskAct`, submit block ~2974–3181)
- Modify: `packages/server/src/protocol/route.ts` (reject unnamed `accept`/`decline` of a `lane_review` eligible-set ask **before** insert)

**Interfaces:**
- Consumes: `pickReviewQuietSet` (Task 2), `ELIGIBLE_ACTS` (Task 1), existing `deliverLaneAskAct` / `routeEnvelope(..., daemonComposed: true)`.
- Produces: non-risky submit with quiet-set size ≥ 2 inserts **one** row, `to_kind='team'`, `meta.eligible` = the names, `meta.lane_review` unchanged, ready-row `detail.eligible` + `reviewer` = best-grade. Size 1 unchanged. `applyAcceptanceVerdict` is never reached for an unnamed seat — the send is `forbidden`.

- [ ] **Step 1: Failing integration tests**

In `packages/server/src/transport/integration.test.ts`, in the same `describe` that owns `async function setup()` at line 3640 (ada claude + gee gpt, nick human), add a nested describe. Do **not** change `setup()` — existing tests rely on a singleton peer. Build a three-agent fixture inside the new describe:

```ts
  describe('quiet-set increment 2 — fan-out the acceptance ask', () => {
    async function setupSet() {
      const { nickTok, ada, gee } = await setup();
      await post('/teams/dawn/members', { name: 'bo', kind: 'agent' }, nickTok);
      const teamKey = (ada as { key: string }).key;
      const boAuth: Auth = { key: teamKey, seat: 'bo' };
      await fetch(base + '/teams/dawn/inbox', {
        headers: { ...authHeaders(boAuth), 'x-musterd-model': 'claude-opus-4-8' },
      });
      await post('/teams/dawn/members', { name: 'cy', kind: 'agent' }, nickTok);
      const cyAuth: Auth = { key: teamKey, seat: 'cy' };
      await fetch(base + '/teams/dawn/inbox', {
        headers: { ...authHeaders(cyAuth), 'x-musterd-model': 'gpt-5.6-codex' },
      });
      // cy is live but busy: a work audit inside 120s. gee + bo stay quiet (no work audit → unknown → eligible).
      appendAudit(db, getTeamBySlug(db, 'dawn')!.id, {
        actor: 'cy',
        action: 'x.did',
        target: null,
        result: 'allow',
      });
      return { nickTok, ada, gee, bo: boAuth, cy: cyAuth };
    }

    it('submit with two quiet peers inserts one team ask, eligible length 2, busy third unnamed', async () => {
      const { ada, gee, bo, cy } = await setupSet();
      const lane = await post('/teams/dawn/lanes', { title: 'fan-out', claim: true }, ada);
      const ready = await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      expect(ready.json.review.eligible).toEqual(expect.arrayContaining(['gee', 'bo']));
      expect(ready.json.review.eligible).toHaveLength(2);
      expect(ready.json.review.eligible).not.toContain('cy');
      expect(ready.json.review.reviewer).toBe('gee'); // cross_family beats cross_model

      const geeInbox = await get('/teams/dawn/inbox?unread=1', gee);
      const asks = (geeInbox.json.messages as any[]).filter(
        (m) => m.act === 'ask' && m.meta?.lane_review?.lane === lane.json.lane.id,
      );
      expect(asks).toHaveLength(1);
      expect(asks[0].to).toEqual({ kind: 'team' });
      expect(asks[0].meta.eligible).toEqual(expect.arrayContaining(['gee', 'bo']));
    });

    it('both named seats see the lane in owed_reviews; the busy third does not', async () => {
      const { ada, gee, bo, cy } = await setupSet();
      const lane = await post('/teams/dawn/lanes', { title: 'owed', claim: true }, ada);
      await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      const geeNext = await get('/teams/dawn/next', gee);
      const boNext = await get('/teams/dawn/next', bo);
      const cyNext = await get('/teams/dawn/next', cy);
      const owed = (b: { json: { owed_reviews?: { lane: { id: string } }[] } }) =>
        (b.json.owed_reviews ?? []).map((r) => r.lane.id);
      expect(owed(geeNext)).toContain(lane.json.lane.id);
      expect(owed(boNext)).toContain(lane.json.lane.id);
      expect(owed(cyNext)).not.toContain(lane.json.lane.id);
    });

    it('first accept closes the lane and stands the other down; unnamed cannot accept', async () => {
      const { ada, gee, bo, cy } = await setupSet();
      const lane = await post('/teams/dawn/lanes', { title: 'first-wins', claim: true }, ada);
      await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      const geeInbox = await get('/teams/dawn/inbox?unread=1', gee);
      const ask = (geeInbox.json.messages as any[]).find(
        (m) => m.act === 'ask' && m.meta?.lane_review?.lane === lane.json.lane.id,
      );

      const cyTry = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: ulid(),
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'cy',
            to: { kind: 'team' },
            act: 'accept',
            body: 'not mine',
            meta: { in_reply_to: ask.id },
            ts: Date.now(),
          },
        },
        cy,
      );
      expect(cyTry.status).toBe(403);

      const ok = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: ulid(),
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'gee',
            to: { kind: 'team' },
            act: 'accept',
            body: 'exercised',
            meta: { in_reply_to: ask.id },
            ts: Date.now(),
          },
        },
        gee,
      );
      expect(ok.status).toBe(201);

      const board = await get('/teams/dawn/lanes', ada);
      expect(
        (board.json.lanes as { id: string; state: string }[]).find((l) => l.id === lane.json.lane.id)
          ?.state,
      ).toBe('done');

      const boInbox = await get('/teams/dawn/inbox', bo);
      expect(boInbox.json.discharged?.some((d: { id: string; by: string }) => d.id === ask.id && d.by === 'gee')).toBe(
        true,
      );
    });

    it('risky and exempt paths still do not fan out', async () => {
      const { nickTok, ada, gee } = await setupSet();
      const risky = await post(
        '/teams/dawn/lanes',
        { title: 'risky', claim: true, risk: ['prod'] },
        ada,
      );
      const riskyReady = await patchLane(risky.json.lane.id, { state: 'ready_for_review' }, ada);
      expect(riskyReady.json.review.eligible).toBeUndefined();
      expect(riskyReady.json.review.reviewer).toBe('nick');

      const low = await post(
        '/teams/dawn/lanes',
        { title: 'web-low', claim: true, stakes: 'low', surface_globs: ['packages/web/**'] },
        ada,
      );
      const lowReady = await patchLane(low.json.lane.id, { state: 'ready_for_review' }, ada);
      expect(lowReady.json.review.acceptance_exempt || lowReady.json.review.reviewer).toBeTruthy();
      if (lowReady.json.review.acceptance_exempt) {
        expect(lowReady.json.review.eligible).toBeUndefined();
      }
    });
  });
```

Fix `setupSet` so `bo`'s key is ` (ada as { key: string }).key ` — do not fetch `/health` for the key. `getTeamBySlug` is already imported. `appendAudit` is already imported.

The exempt assertion is loose because the 1-in-5 sample can pull a `low` lane back onto the normal path. If `acceptance_exempt` is true, there must be no `eligible`. If sampled-in, it may fan out — that is correct. Do not pin the draw.

- [ ] **Step 2: Run — must fail**

```bash
pnpm --filter @musterd/server exec vitest run src/transport/integration.test.ts -t "quiet-set increment 2"
```

Expected: FAIL (`review.eligible` undefined; ask is directed to gee only).

- [ ] **Step 3: Compose + gate**

`deliverLaneAskAct` in `packages/server/src/transport/http.ts` — add an optional eligible set. When present, address the team and put the names on meta:

```ts
function deliverLaneAskAct(
  ctx: Ctx,
  team: TeamRow,
  from: MemberRow,
  to: string,
  body: string,
  meta: Record<string, unknown>,
  eligible?: string[],
): void {
  try {
    const env = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: from.name,
      to: eligible && eligible.length >= 2 ? { kind: 'team' } : { kind: 'member', name: to },
      act: 'ask',
      body,
      meta: eligible && eligible.length >= 2 ? { ...meta, eligible } : meta,
    });
    routeEnvelope(ctx, team, from, env, undefined, true);
  } catch {
    /* advisory only — the lane verb already succeeded */
  }
}
```

Submit block: after exemption, call `pickReviewQuietSet` for non-risky non-exempt. `peerPick = quietSet[0] ?? null` (same as today for the wake/human fallback). When composing the ask, if `lane.risk.length === 0 && quietSet.length >= 2 && !wakeQueued`:

```ts
deliverLaneAskAct(ctx, team, member, quietSet[0]!.reviewer, body, meta, quietSet.map((p) => p.reviewer));
review = {
  reviewer: quietSet[0]!.reviewer,
  eligible: quietSet.map((p) => p.reviewer),
  route: quietSet[0]!.route,
  grade: quietSet[0]!.grade,
  tier: 'standard',
  ...
};
```

Ready-row `detail` (the `pick` branch) gains `eligible: string[]` beside `reviewer` when the set was used. Singleton / wake / risky / exempt rows omit it.

`priorOwnerNotice`: if **any** name in the set is a prior owner, include the notice (second-person; each named seat reads it). Do not drop them from the set.

In `packages/server/src/protocol/route.ts`, **before** `insertMessage`, if `env.act` is `accept` or `decline` and `meta.in_reply_to` names a message:

```ts
const replied = ctx.db
  .prepare<[string, string], { meta: string | null }>(
    'SELECT meta FROM messages WHERE team_id = ? AND id = ?',
  )
  .get(team.id, String(env.meta?.['in_reply_to']));
if (replied?.meta) {
  const parsed = JSON.parse(replied.meta) as Record<string, unknown>;
  if (parsed['lane_review'] != null) {
    const names = eligibleOf(parsed);
    if (names && !names.includes(sender.name)) {
      throw new MusterdError(
        'forbidden',
        `seat "${sender.name}" is not in the eligible set for this acceptance ask`,
      );
    }
  }
}
```

This MUST run before insert. ADR 254 `anyAnswer` treats the first accept from **anyone** as discharge — an unnamed insert would stand the real acceptors down without being allowed to verdict. Do not silently no-op after insert.

Do not tighten directed (no-eligible) asks here. Spec increment 2 is the set.

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @musterd/server exec vitest run src/transport/integration.test.ts src/store/review.test.ts src/store/orientation.test.ts
```

Expected: PASS, including the existing ADR 202 / ADR 235 / exempt describes.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/transport/http.ts packages/server/src/protocol/route.ts \
  packages/server/src/transport/integration.test.ts
git commit -m "$(cat <<'EOF'
server: fan out the acceptance ask to the quiet set

One team-addressed ask, meta.eligible, first accept wins. A seat that
was not named cannot verdict — anyAnswer would otherwise discharge the set.

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 5: Draft PR, then the ADR + docs

**Files:**
- Create: `docs/decisions/NNN-quiet-set-acceptance-fanout.md` (NNN from `pnpm adr:next` **after** the draft PR)
- Modify: `docs/architecture/02-protocol.md` (eligible-set act list, one line)
- Modify: `docs/architecture/03-server.md` (`review.ts` and `orientation.ts` tree lines)
- Modify: `docs/decisions/254-eligible-sets.md` — dated **Consequences** note only (Decision stays frozen)
- Modify: `docs/decisions/260-live-acceptance-pick-skips-busy-agents.md` — dated Consequences note that increment 2 shipped because the Eval said so
- Modify: `docs/superpowers/specs/2026-08-12-quiet-set-acceptance-design.md` — status line only, and only after izzo's Eval lane has reported

**Interfaces:**
- Consumes: Tasks 1–4 behaviour.
- Produces: an accepted ADR whose Decision is: at `lane_submit`, a non-risky non-exempt quiet set of 2–4 becomes one eligible-set `ask`; `ask` ∈ `ELIGIBLE_ACTS`; unnamed seats cannot verdict.

- [ ] **Step 1: Fast gates, draft PR (ADR 223 — number is not free until this exists)**

```bash
pnpm typecheck && pnpm format:check
git fetch origin main && git rebase origin/main
git push -u origin HEAD
gh pr create --draft --title "Quiet-set increment 2: fan out the acceptance ask" --body "$(cat <<'EOF'
## Summary
- Non-risky `lane_submit` with 2–4 live quiet peers sends one `ask` to `{kind:team}` with `meta.eligible`.
- `ask` joins `ELIGIBLE_ACTS`. First accept discharges the rest. Unnamed seats get 403.
- `owed_reviews` matches eligible names. `reviewer` stays the best-grade name.
- Singleton / empty / risky / exempt / wake paths unchanged.
- ADR number reserved in the next commit (ADR 223).

## Test plan
- [x] `pnpm --filter @musterd/protocol exec vitest run src/envelope.test.ts`
- [x] `pnpm --filter @musterd/server exec vitest run src/store/review.test.ts src/store/orientation.test.ts src/transport/integration.test.ts -t "quiet-set"`
- [ ] Increment-1 Eval (izzo `01M011HP1E`) said fan-out is the lever — do not merge if it said stop.

EOF
)"
```

- [ ] **Step 2: Reserve the number and write the ADR (no Prettier on `docs/`)**

```bash
pnpm adr:next
```

Use the printed NNN. Write `docs/decisions/NNN-quiet-set-acceptance-fanout.md`:

```md
# NNN — Quiet-set acceptance fan-out

- Status: accepted
- Date: 2026-08-14
- Owner: wanderer
- Relates to: ADR 254 (eligible sets — this adds `ask` to the act list), ADR 260 (increment 1; this is increment 2), ADR 188 / 253 (graded agents-only live pick), ADR 202 (only a named seat can verdict), ADR 225 (obligation-class `lane_review`), ADR 233 (`owed_reviews`)
- Amends: ADR 254 rule 3 — `ask` may carry `meta.eligible`. ADR 254's Decision text stays frozen; this ADR is the amendment.

## Context

Increment 1 (ADR 260) stopped sole-targeting a busy live agent. The remaining miss, when more than one quiet peer is live, is still one name plus ADR 202: everyone else who could have judged is structurally unable to.

## Problem

Naming one quiet seat recreates the inbox-and-wait path whenever that seat is the wrong one of two. `@team` is measured diffusion. Ambient `review_debt` cannot pick up an ask routed elsewhere.

## Decision

At `lane_submit`, for a non-risky non-exempt lane, take the live quiet agent set (ADR 260 filter, ADR 188 grade, cap `MAX_ELIGIBLE`).

- Size 2–4: one `ask` (`species: approve`, `lane_review`) addressed `to: {kind:'team'}` with `meta.eligible`. `ask` is in `ELIGIBLE_ACTS`. First `accept`/`decline` discharges the rest. A seat not in the set who answers the ask is `forbidden`.
- Size 1: today's directed ask.
- Size 0: today's ADR 191 wake / `no_candidate`.
- Risky and exempt paths unchanged.

`LaneResult.review.reviewer` remains the best-grade name. `review.eligible` is present only when the set was used. `owed_reviews` matches `json_extract(meta,'$.eligible')` as well as `to_member`. The ask is obligation-class, not `urgent`.

## Consequences

A team with two quiet cross-model peers no longer sole-targets one of them. Duplicate verdicts on the same ask are a stand-down failure (reopen above 1.3, same as ADR 254). Epoch 12: older seats reject `ask`+`eligible`.

## Observability & Evaluation

**Traces.** `meta.eligible` on the ask; ready-row `detail.eligible`.

**Eval.** Pre-registered in the quiet-set spec: (1) ≤10m confirm among quiet-set routes, jumped routes dropped by join; (2) uncensored age-at-close; (3) duplicate verdicts ~1.0; (4) ask volume after web-low; (5) is increment 1's wake-cost read, not this ADR's.
```

Dated note at the **end of** ADR 254 `## Consequences` (not in Decision): increment 2 (ADR NNN) added `ask` to the act list; the Decision's three-act sentence is historical.

Dated note at the **end of** ADR 260 `## Consequences`: increment 2 shipped as ADR NNN after the increment-1 Eval (link izzo's numbers / lane `01M011HP1E`).

`docs/architecture/03-server.md` `review.ts` line: after the ADR 260 clause, add "returns the quiet set for fan-out (ADR NNN) when 2–4". `orientation.ts` line: `owed_reviews` matches eligible names (ADR NNN).

`docs/architecture/02-protocol.md`: one sentence under the envelope meta notes that `ask` may carry `meta.eligible` (ADR NNN).

Spec status line → `increment 2 shipped (ADR NNN)`.

- [ ] **Step 3: Fast gates, mark ready, auto-merge**

```bash
pnpm typecheck && pnpm format:check
git add docs/decisions/NNN-quiet-set-acceptance-fanout.md docs/decisions/254-eligible-sets.md \
  docs/decisions/260-live-acceptance-pick-skips-busy-agents.md \
  docs/architecture/02-protocol.md docs/architecture/03-server.md \
  docs/superpowers/specs/2026-08-12-quiet-set-acceptance-design.md
git commit -m "$(cat <<'EOF'
docs: ADR NNN — quiet-set acceptance fan-out

Refs ADR-NNN

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
git push
gh pr ready
gh pr merge <n> --squash --auto --delete-branch
```

Do not poll CI.

---

## Self-review (spec coverage)

| Spec increment 2 requirement | Task |
| ---------------------------- | ---- |
| `ask` ∈ `ELIGIBLE_ACTS`; `handoff` still must not | 1 |
| `review.eligible?: string[]`; `reviewer` = best-grade | 1, 4 |
| Quiet set 2–4 → one team ask, `meta.eligible` | 2, 4 |
| Size 1 → directed; size 0 → wake | 4 (untouched branches) |
| Busy seat not named | 2 |
| `owed_reviews` matches eligible names | 3 |
| Interrupt obligation-class, not urgent | 4 (no `urgent` flag; `lane_review` already obligation) |
| First accept wins / stand-down | 4 (ADR 254 `anyAnswer` + `discharged`) |
| Unnamed cannot `accept` | 4 (pre-insert `forbidden`) |
| Exempt + risky unchanged | 4 |
| ADR + protocol in the same PR | 5 |
| Stop if Eval says attention-not-supply | Gate at top — do not execute until izzo reports |

No ADR 254 increment 2 (wake-one-hold-rest). No open pickup. No re-routing in-flight asks. No roles-as-eligible-set (record, do not build).
