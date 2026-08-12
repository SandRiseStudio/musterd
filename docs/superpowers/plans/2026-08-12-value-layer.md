# Value Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (musterd note: no writing subagents — execute inline in the stanley seat, lane `01KZW10CV7XE855CEBE8THGZYR`.)

**Goal:** Shipped goals carry a human-written outcome note; claiming a lane can link it to a goal in one call; lanes stuck in acceptance become visible board facts.

**Architecture:** Everything is advisory and derived, riding the existing message-replay design: the outcome is a `message` act to `@team` with `meta.goal_outcome`, replayed by `listGoals` beside `defer`/`steer`; the ship nudge is computed before/after in the lane PATCH close path and appended to the closer's response; `stale_acceptance` is a new warning kind derived from the `lane.ready_for_review` audit row. No new tables, no stored goal state, no daemon-initiated wakes.

**Tech Stack:** TypeScript monorepo (pnpm), zod schemas in `@musterd/protocol`, better-sqlite3 store, vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-value-layer-design.md` (approved by nick 2026-08-12).

## Global Constraints

- Advisory only: no hard gates, no directed wakes, `owner: null` on the new warning.
- Outcome text: trimmed, 1–**280** chars (`story` stays 140).
- `ACCEPTANCE_STALE_MS = 12 * 60 * 60 * 1000` (12 h), exported constant.
- `team_next` review-debt list: cap **3**, oldest first.
- `FEATURE_EPOCH` 10 → 11 (`packages/protocol/src/feature-epoch.ts:60`) — one bump for the whole arc, in the final task.
- Per-seat throughput metrics are an anti-goal — do not add any.
- Build order trap: run `pnpm -r build` before any typecheck (protocol `.d.ts` phantoms); `pnpm lint` is separate from `format:check`; format with `pnpm exec prettier --write <files>` only.
- Rebase over wanderer's `lane_update accepts goal_id` merge before touching `packages/mcp/src/tools/lanes.ts`.
- Never edit the web package (miley's surface).

---

### Task 1: Protocol — outcome schemas, warning kind, staleness constant, review-debt brief field

**Files:**
- Modify: `packages/protocol/src/goals.ts`
- Modify: `packages/protocol/src/lanes.ts` (warning kind ~line 247; `NextBriefSchema` ~line 450; response schema for lane PATCH)
- Test: colocated `*.test.ts` if present for these files; otherwise schema behavior is exercised by Task 2/3 store tests (protocol has no test harness of its own — verify with `ls packages/protocol/src/*.test.ts` and don't create one if absent).

**Interfaces:**
- Produces: `GoalOutcomeSchema` (`{goal_id: string; outcome: string}` with outcome `z.string().trim().min(1).max(280)`), `GoalOutcomeMetaSchema` (`{goal_outcome: GoalOutcomeSchema}`), `Goal.outcome?: {text: string; by: string; at: number}`, `LaneWarningSchema.kind` member `'stale_acceptance'`, `ACCEPTANCE_STALE_MS`, `NextBriefSchema.review_debt?: Array<{id: string; title: string; owner: string | null; waited_ms: number}>`, and `notices: z.array(z.string()).optional()` on the lane PATCH response schema (the one `client.updateLane` parses — find it via `grep -n "warnings" packages/protocol/src/lanes.ts` around the lane response shapes).

- [ ] **Step 1: Add outcome schemas + Goal.outcome to `packages/protocol/src/goals.ts`**

```ts
/** A goal outcome note (value-layer design): what shipped, for a user — evidence, not a slogan. */
export const GoalOutcomeSchema = z.object({
  goal_id: z.string().min(1),
  outcome: z.string().trim().min(1).max(280),
});
export type GoalOutcome = z.infer<typeof GoalOutcomeSchema>;

/** `meta.goal_outcome` on a team-visible `message` act — replayed by listGoals like defer/steer. */
export const GoalOutcomeMetaSchema = z.object({ goal_outcome: GoalOutcomeSchema });
export type GoalOutcomeMeta = z.infer<typeof GoalOutcomeMetaSchema>;
```

And inside `GoalSchema` (after `story`):

```ts
  /** Latest outcome note (value-layer design): what changed for a user — derived, provenance free. */
  outcome: z.object({ text: z.string(), by: z.string(), at: z.number().int() }).optional(),
```

Also add to `DeclareGoalSchema`? **No** — outcome never rides declaration (the wholesale-replace footgun is the reason this exists). Add a `PostGoalOutcomeSchema` for the HTTP body:

```ts
/** Body for `POST /teams/:slug/goals/outcome` — thin sugar over a `message` act to `@team`. */
export const PostGoalOutcomeSchema = GoalOutcomeSchema;
```

- [ ] **Step 2: Add warning kind + constant + brief field to `packages/protocol/src/lanes.ts`**

In `LaneWarningSchema.kind` enum, after `'no_goal'`:

```ts
    'stale_acceptance',
```

Near the state constants (beside `isAwaitingAcceptance`, ~line 113):

```ts
/** value-layer design: a lane in awaiting_acceptance longer than this warns `stale_acceptance`. */
export const ACCEPTANCE_STALE_MS = 12 * 60 * 60 * 1000;
```

In `NextBriefSchema` (beside `goals`):

```ts
  /** Oldest lanes waiting on acceptance (cap 3) — review debt surfaced as candidate work. */
  review_debt: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        owner: z.string().nullable(),
        waited_ms: z.number().int().nonnegative(),
      }),
    )
    .optional(),
```

On the lane PATCH response schema (`{lane, warnings}` shape):

```ts
  /** Advisory lines appended to this caller's result only (e.g. the ship nudge) — never a wake. */
  notices: z.array(z.string()).optional(),
```

- [ ] **Step 3: Build protocol and typecheck**

Run: `pnpm -r build && pnpm typecheck` (whole repo — the phantom-`.d.ts` trap). Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/goals.ts packages/protocol/src/lanes.ts
git commit -m "protocol: goal outcome signal, stale_acceptance warning kind, review_debt brief field (value-layer)"
```

---

### Task 2: Store — outcome replay in `listGoals`

**Files:**
- Modify: `packages/server/src/store/goals.ts`
- Test: `packages/server/src/store/goals.test.ts` (exists — extend; if the filename differs, find it with `ls packages/server/src/store/*.test.ts`)

**Interfaces:**
- Consumes: `GoalOutcomeMetaSchema`, `Goal.outcome` (Task 1).
- Produces: `listGoals` rows carry `outcome` when a `meta.goal_outcome` signal names the goal; latest-by-ts wins; signals before declaration replay via the existing `pending` queue; outcome **survives re-declaration** (it lives outside the skeleton accumulator's replace).

- [ ] **Step 1: Write the failing tests**

Follow the file's existing test helpers (it already builds a db and inserts message rows for declarations/defers — mirror that setup exactly). Cases:

```ts
describe('goal outcome replay (value-layer)', () => {
  it('attaches the latest outcome with provenance', () => {
    declareGoal(db, 'g1', 'title');                       // existing helper pattern
    sendTeamMessage(db, 'izzo', { goal_outcome: { goal_id: 'g1', outcome: 'users can now X' } }, t1);
    sendTeamMessage(db, 'miley', { goal_outcome: { goal_id: 'g1', outcome: 'users can now X and Y' } }, t2);
    const g = listGoals(db, teamId, slug).find((g) => g.id === 'g1')!;
    expect(g.outcome).toEqual({ text: 'users can now X and Y', by: 'miley', at: t2 });
  });
  it('queues an outcome that arrives before its declaration', () => {
    sendTeamMessage(db, 'izzo', { goal_outcome: { goal_id: 'g2', outcome: 'early note' } }, t1);
    declareGoal(db, 'g2', 'title');                       // declared after
    expect(listGoals(db, teamId, slug).find((g) => g.id === 'g2')!.outcome?.text).toBe('early note');
  });
  it('outcome survives a wholesale re-declaration of the skeleton', () => {
    declareGoal(db, 'g3', 'title', { story: 's' });
    sendTeamMessage(db, 'izzo', { goal_outcome: { goal_id: 'g3', outcome: 'note' } }, t1);
    declareGoal(db, 'g3', 'new title');                   // no story, no outcome — story clears
    const g = listGoals(db, teamId, slug).find((g) => g.id === 'g3')!;
    expect(g.story).toBeUndefined();
    expect(g.outcome?.text).toBe('note');                 // the footgun test
  });
  it('ignores malformed goal_outcome meta', () => {
    declareGoal(db, 'g4', 'title');
    sendTeamMessage(db, 'izzo', { goal_outcome: { goal_id: 'g4' } }, t1); // no outcome text
    expect(listGoals(db, teamId, slug).find((g) => g.id === 'g4')!.outcome).toBeUndefined();
  });
});
```

(Adapt helper names to the file's actual ones — copy from the neighbouring `story`/`defer` tests.)

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @musterd/server test -- goals` — expect the new cases FAIL (outcome undefined).

- [ ] **Step 3: Implement replay in `listGoals`**

In `GoalAccumulator`, outcomes ride beside the accumulator, not inside the skeleton replace. Add a parallel map + extend `applySignal`-style handling in the message branch:

```ts
// beside `byId`
const outcomes = new Map<string, { text: string; by: string; at: number }>();
const pendingOutcomes: { goalId: string; text: string; by: string; at: number }[] = [];
```

In the `row.act === 'message'` path, before the `GoalDeclareMetaSchema` parse attempt, try the outcome shape (a message row carries either meta — both parses are cheap):

```ts
    const rawMeta = JSON.parse(row.meta);            // reuse the existing try/catch structure
    const asOutcome = GoalOutcomeMetaSchema.safeParse(rawMeta);
    if (asOutcome.success) {
      const o = asOutcome.data.goal_outcome;
      const rec = { text: o.outcome, by: row.from_name, at: row.ts };
      if (byId.has(o.goal_id)) outcomes.set(o.goal_id, rec); // ts-ascending scan: latest wins
      else pendingOutcomes.push({ goalId: o.goal_id, ...rec });
      continue;
    }
```

After the pending-signal replay loop:

```ts
  for (const p of pendingOutcomes)
    if (byId.has(p.goalId)) outcomes.set(p.goalId, { text: p.text, by: p.by, at: p.at });
```

(Pending list is ts-ordered, so the last surviving set is the latest — same rule.) In the final projection, beside `story`:

```ts
    ...(outcomes.has(g.id) ? { outcome: outcomes.get(g.id)! } : {}),
```

- [ ] **Step 4: Run tests — expect PASS** — `pnpm --filter @musterd/server test -- goals`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/goals.ts packages/server/src/store/goals.test.ts
git commit -m "server: goal outcome notes replay in listGoals — latest wins, survives re-declaration"
```

---

### Task 3: Store — `stale_acceptance` warning

**Files:**
- Modify: `packages/server/src/store/lanes.ts` (beside `noGoalWarning`, ~line 466)
- Test: `packages/server/src/store/lanes.test.ts` (the `no_goal` matrix at ~line 577 is the template)

**Interfaces:**
- Consumes: `ACCEPTANCE_STALE_MS`, `isAwaitingAcceptance` (protocol), audit rows (`action = 'lane.ready_for_review'`, `target = lane.id`, `ts`).
- Produces: `staleAcceptanceWarning(db, teamId, lane, now): LaneWarning | null`, wired into `laneWarnings` (and therefore `boardWarnings`).

- [ ] **Step 1: Write the failing tests** (mirror the `no_goal` matrix setup — real db, real audit rows):

```ts
describe('stale_acceptance (value-layer)', () => {
  it('warns once a lane has waited past the threshold', () => {
    const lane = mkLane({ state: 'awaiting_acceptance' });
    insertAudit(db, teamId, { action: 'lane.ready_for_review', target: lane.id, ts: now - ACCEPTANCE_STALE_MS - 1 });
    const w = staleAcceptanceWarning(db, teamId, lane, now);
    expect(w).toMatchObject({ kind: 'stale_acceptance', subject: lane.id, owner: null });
  });
  it('stays silent under the threshold', () => {
    const lane = mkLane({ state: 'awaiting_acceptance' });
    insertAudit(db, teamId, { action: 'lane.ready_for_review', target: lane.id, ts: now - 1000 });
    expect(staleAcceptanceWarning(db, teamId, lane, now)).toBeNull();
  });
  it('never warns for a non-waiting state', () => {
    expect(staleAcceptanceWarning(db, teamId, mkLane({ state: 'claimed' }), now)).toBeNull();
  });
  it('falls back to updated_at when no audit row exists, and clamps clock skew', () => {
    const lane = mkLane({ state: 'awaiting_acceptance', updated_at: now + 5000 }); // future — skew
    expect(staleAcceptanceWarning(db, teamId, lane, now)).toBeNull();
  });
});
```

(Use the file's real lane-factory and audit helpers; the legacy `ready_for_review` state must also warn — add one case with that state string.)

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @musterd/server test -- lanes` — FAIL: `staleAcceptanceWarning` not defined.

- [ ] **Step 3: Implement**

```ts
/** value-layer design: review debt made visible — a lane waiting on acceptance past the threshold.
 *  Advisory like `no_goal`: owner null, never a directed wake. Entry time = the latest
 *  `lane.ready_for_review` audit row; falls back to `updated_at` for pre-audit lanes. */
export function staleAcceptanceWarning(
  db: Database,
  teamId: string,
  lane: Lane,
  now: number,
): LaneWarning | null {
  if (!isAwaitingAcceptance(lane.state)) return null;
  const row = db
    .prepare<[string, string], { ts: number }>(
      `SELECT ts FROM audit
        WHERE team_id = ? AND action = 'lane.ready_for_review' AND target = ?
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(teamId, lane.id);
  const entered = row?.ts ?? lane.updated_at;
  const waited = now - entered;
  if (waited < ACCEPTANCE_STALE_MS) return null; // covers clock skew: negative never emits
  const hours = Math.floor(waited / 3_600_000);
  return {
    kind: 'stale_acceptance',
    subject: lane.id,
    with: lane.id,
    owner: null,
    detail: `waiting ${hours}h for acceptance — pick it up: team_next shows it, or accept/decline per the acceptance ask`,
  };
}
```

Wire into `laneWarnings` (new branch, independent of the `CONTENDING` gate — verify with `grep -n "LANE_CONTENDING_STATES" packages/protocol/src/lanes.ts` whether awaiting states are members; either way this branch is explicit):

```ts
  const stale = staleAcceptanceWarning(db, teamId, lane, Date.now());
  if (stale) warnings.push(stale);
```

For testability, thread `now` through: give `laneWarnings` an optional trailing `now = Date.now()` parameter and pass it down.

- [ ] **Step 4: Run tests — expect PASS.** Also run the full lanes suite — the existing warning-matrix tests must stay green (no lane in those fixtures should be awaiting past threshold; if any fixture trips it, pin its `updated_at` fresh rather than weakening the assert).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/lanes.ts packages/server/src/store/lanes.test.ts
git commit -m "server: stale_acceptance warning — review debt as a board fact (12h, advisory)"
```

---

### Task 4: Transport — `POST /goals/outcome` + ship nudge on close

**Files:**
- Modify: `packages/server/src/transport/http.ts` (goals routes ~line 2657; lane PATCH close path — anchor: the `lane.closed` audit write)
- Test: the transport/route test file covering the goals routes (find with `grep -rln "'/goals'" packages/server/src/**/*.test.ts`)

**Interfaces:**
- Consumes: `PostGoalOutcomeSchema`, `GoalOutcomeMeta` shape, `deriveGoalStatus`, `lanesForGoal` (store), `notices` response field (Task 1).
- Produces: `POST /teams/:slug/goals/outcome` → `201 {goal}`; lane PATCH response gains `notices: [shipNudge]` when the close flips the lane's goal to `shipped`.

- [ ] **Step 1: Write the failing route tests** (mirror the existing `POST /goals` test):

```ts
it('POST /goals/outcome records a note and the goal projection carries it', async () => {
  await declareGoal('g1');
  const res = await post('/teams/t/goals/outcome', { goal_id: 'g1', outcome: 'users can now X' });
  expect(res.status).toBe(201);
  expect(res.body.goal.outcome.text).toBe('users can now X');
});

it('closing the last lane on a goal appends the ship nudge to the closer result', async () => {
  await declareGoal('g2');
  const lane = await openLane({ goal_id: 'g2', claim: true });
  const res = await patchLane(lane.id, { state: 'done', /* …the close shape the suite already uses… */ });
  expect(res.body.notices?.[0]).toContain('team_goal_outcome');
  expect(res.body.notices?.[0]).toContain('g2');
});

it('closing a lane while the goal still has live lanes appends no nudge', async () => {
  await declareGoal('g3');
  const a = await openLane({ goal_id: 'g3', claim: true });
  await openLane({ goal_id: 'g3', claim: true });
  const res = await patchLane(a.id, { state: 'done', /* … */ });
  expect(res.body.notices).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the route** (directly after the `POST /goals` block, same envelope pattern):

```ts
      // value-layer design: a goal outcome note — an ordinary message act carrying meta.goal_outcome,
      // replayed by listGoals. Never a re-declaration (outcome must survive skeleton replacement).
      if (method === 'POST' && rest === '/goals/outcome') {
        const { team, member } = authTouch(ctx, slug, req);
        const body = parseOrBadRequest(PostGoalOutcomeSchema, await readJson(req));
        const env = makeEnvelope({
          id: ulid(),
          team: team.slug,
          from: member.name,
          to: { kind: 'team' },
          act: 'message',
          body: `[goal] outcome — ${body.goal_id}: ${body.outcome}`,
          meta: { goal_outcome: { goal_id: body.goal_id, outcome: body.outcome } },
        });
        routeEnvelope(ctx, team, member, env);
        const goal = listGoals(ctx.db, team.id, team.slug).find((g) => g.id === body.goal_id);
        if (!goal) return sendJson(res, 201, { goal: null }); // pre-declaration note: queued, honest
        return sendJson(res, 201, { goal });
      }
```

- [ ] **Step 4: Implement the ship nudge in the lane PATCH close path**

In the branch that lands a terminal close (where `lane.closed` is audited), around the state application:

```ts
        // value-layer design: derive the goal's status before and after this close; when the close
        // flips it to shipped, the CLOSER's own result carries the outcome nudge — appended, never
        // blocking, never a wake. A goal that ships without an outcome stays visibly outcome-less.
        const goalId = existing.goal_id; // the pre-patch lane row the handler already loaded
        const shippedBefore =
          goalId !== null &&
          deriveGoalStatus(lanesForGoal(ctx.db, team.id, team.slug, goalId)) === 'shipped';
        // …existing close application runs here…
        const notices: string[] = [];
        if (goalId !== null && !shippedBefore) {
          const after = deriveGoalStatus(lanesForGoal(ctx.db, team.id, team.slug, goalId));
          if (after === 'shipped')
            notices.push(
              `goal "${goalId}" just shipped — say what changed for a user: ` +
                `team_goal_outcome {goal_id: "${goalId}", outcome: "…"}`,
            );
        }
```

And spread `...(notices.length ? { notices } : {})` into the PATCH's `sendJson` payload.

- [ ] **Step 5: Run the route tests — expect PASS. Then the whole server suite** — `pnpm --filter @musterd/server test`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/transport/http.ts <test file>
git commit -m "server: POST /goals/outcome + ship nudge on the closing seat's result (value-layer)"
```

---

### Task 5: Orientation — `review_debt` in the brief

**Files:**
- Modify: `packages/server/src/store/orientation.ts` (deriveNext; `up_next` goal-sort is at ~line 78)
- Test: the orientation/next test file (`ls packages/server/src/store/orientation*.test.ts`)

**Interfaces:**
- Consumes: `isAwaitingAcceptance`, the `lane.ready_for_review` audit lookup (reuse `staleAcceptanceWarning`'s query — extract a small shared `acceptanceEnteredAt(db, teamId, lane)` helper in `store/lanes.ts` if duplication itches).
- Produces: `NextBrief.review_debt` — up to 3 oldest awaiting lanes `{id, title, owner, waited_ms}`, present only when non-empty.

- [ ] **Step 1: Failing test**

```ts
it('brief lists the 3 oldest awaiting-acceptance lanes as review debt', () => {
  const old1 = mkAwaiting({ enteredAgoMs: 30 * 3600_000 });
  const old2 = mkAwaiting({ enteredAgoMs: 20 * 3600_000 });
  const old3 = mkAwaiting({ enteredAgoMs: 10 * 3600_000 });
  mkAwaiting({ enteredAgoMs: 1000 });                     // 4th, freshest — capped out
  const brief = deriveNext(db, teamId, slug, 'stanley');
  expect(brief.review_debt!.map((r) => r.id)).toEqual([old1.id, old2.id, old3.id]);
});
it('review_debt is absent when nothing waits', () => {
  expect(deriveNext(db, teamId, slug, 'stanley').review_debt).toBeUndefined();
});
```

- [ ] **Step 2: Run — FAIL.** — [ ] **Step 3: Implement** in `deriveNext`:

```ts
  const waiting = lanes
    .filter((l) => isAwaitingAcceptance(l.state))
    .map((l) => ({ lane: l, entered: acceptanceEnteredAt(db, teamId, l) }))
    .sort((a, b) => a.entered - b.entered)
    .slice(0, 3)
    .map(({ lane, entered }) => ({
      id: lane.id,
      title: lane.title,
      owner: lane.owner_seat,
      waited_ms: Math.max(0, now - entered),
    }));
  // …spread into the returned brief:
  ...(waiting.length ? { review_debt: waiting } : {}),
```

- [ ] **Step 4: Run — PASS**, full suite green. — [ ] **Step 5: Commit** (`server: review debt in the orientation brief — 3 oldest awaiting lanes`).

---

### Task 6: MCP — `team_goal_outcome`, claim-time `goal_id`, notices + review-debt rendering

**Files:**
- Modify: `packages/mcp/src/tools/goals.ts`, `packages/mcp/src/tools/lanes.ts` (lane_claim ~line 120; brief renderer ~line 470), `packages/mcp/src/client.ts` (new `goalOutcome` method beside `declareGoal` ~line 443)
- Test: the MCP tools test files beside them

**Interfaces:**
- Consumes: `POST /goals/outcome`, `notices` on the lane PATCH response, `review_debt` on the brief.
- Produces: MCP tool `team_goal_outcome {goal_id, outcome}`; `lane_claim {id, goal_id?}`; rendered notices/review-debt lines (what a person SEES — asserted, per ryder's #759 lesson).

- [ ] **Step 1: Failing tests** — three renderings:

```ts
it('team_goal_outcome round-trips and renders the note', /* mock client.goalOutcome, assert text contains the outcome */);
it('lane_claim passes goal_id through to updateLane', /* spy: updateLane called with {owner_seat, goal_id} */);
it('the brief renders review debt lines with age', /* brief fixture with review_debt → expect /waiting \d+h/ */);
it('lane_resolve renders notices from the response', /* response {lane, warnings, notices:['goal "g" just shipped…']} → rendered text contains it */);
```

- [ ] **Step 2: Run — FAIL.** — [ ] **Step 3: Implement**

`client.ts`:

```ts
  goalOutcome(body: { goal_id: string; outcome: string }): Promise<{ goal: Goal | null }> {
    return this.post(`/teams/${this.team}/goals/outcome`, body);   // mirror declareGoal's shape
  }
```

`tools/goals.ts` (after `team_goal_declare`):

```ts
  server.registerTool(
    'team_goal_outcome',
    {
      description:
        'Record what a shipped goal changed for a user — one plain sentence of evidence, shown ' +
        'beside the goal wherever it renders. Anyone may amend by recording a new note; the latest wins.',
      inputSchema: {
        goal_id: z.string().describe('the goal this note is about'),
        outcome: z.string().max(280).describe('what changed for a user — evidence, not a slogan'),
      },
    },
    async (args) => {
      try {
        const { goal } = await client.goalOutcome(args);
        return textResult(goal ? `outcome recorded\n${fmtGoal(goal)}` : 'outcome recorded (goal not yet declared — queued)');
      } catch (err) {
        return errorResult(err);
      }
    },
  );
```

`fmtGoal` gains the outcome line (beside the story rendering): `` g.outcome ? `\n    ⇒ ${g.outcome.text} — ${g.outcome.by}` : '' ``.

`tools/lanes.ts` — `lane_claim` (this is the file wanderer touched; **rebase first**):

```ts
      inputSchema: {
        id: z.string().describe('lane id'),
        goal_id: z.string().optional().describe('link the lane to a goal as you take it (one call)'),
      },
```

and pass through: `client.updateLane(args.id, { owner_seat: client.member, ...(args.goal_id ? { goal_id: args.goal_id } : {}) })`.

`laneResult` (or the resolve/update call sites): append `notices` lines when the response carries them. Brief renderer, before `up next`:

```ts
  if (b.review_debt?.length) {
    lines.push(`\n⧗ review debt — waiting on any seat's acceptance:`);
    for (const r of b.review_debt)
      lines.push(`  ${r.id} "${r.title}" — waiting ${Math.floor(r.waited_ms / 3_600_000)}h`);
  }
```

- [ ] **Step 4: Run — PASS**; full MCP suite green. — [ ] **Step 5: Commit** (`mcp: team_goal_outcome, claim-time goal link, review-debt + ship-nudge rendering`).

---

### Task 7: CLI — `goal outcome`, `lane claim --goal`

**Files:**
- Modify: `packages/cli/src/commands/goal.ts` (+ `goal.test.ts`), `packages/cli/src/commands/lane.ts` (+ `lane.test.ts`)

**Interfaces:**
- Consumes: `POST /goals/outcome`; lane PATCH with `goal_id`.
- Produces: `musterd goal outcome <id> "<text>"`; `musterd lane claim <id> --goal <goal-id>`.

- [ ] **Step 1: Failing tests** — mirror `goal declare --story`'s test (it just landed in #767 — copy its structure): outcome subcommand posts the body and prints the recorded note; `lane claim --goal` sends `goal_id` in the patch.
- [ ] **Step 2: Run — FAIL.** — [ ] **Step 3: Implement**, following the exact argument-parsing pattern `goal.ts` uses for `declare`.
- [ ] **Step 4: Run — PASS.** — [ ] **Step 5: Commit** (`cli: goal outcome + lane claim --goal (value-layer)`).

---

### Task 8: Epoch, ADR, gates, PR

**Files:**
- Modify: `packages/protocol/src/feature-epoch.ts:60` (`10` → `11`, with a dated comment line following the file's convention)
- Create: `docs/decisions/<next-free-number>-shipped-goals-carry-evidence.md` — condense the spec's Decisions + rejected alternatives into the house ADR format (copy 256's structure); check the next free number at write time (`ls docs/decisions | tail`)

- [ ] **Step 1: Bump epoch + write the ADR.**
- [ ] **Step 2: Full gates, in order:** `pnpm -r build && pnpm typecheck && pnpm -r test && pnpm lint && pnpm format:check` (format only my changed files with prettier if it complains).
- [ ] **Step 3: Commit** (`value-layer: epoch 11 + ADR`), push, open PR per the git loop:

```bash
git push -u origin stanley/value-layer-spec
gh pr create --title "Value layer: outcome notes on shipped goals, claim-time linking, stale-acceptance visibility" --body "…(spec + ADR summary, lane id, goal value-layer)…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --squash --auto --delete-branch
```

(If Bugbot never registers, comment `bugbot run`.)

- [ ] **Step 4: musterd close-out:** `lane_update {goal_id: 'value-layer'}` on lane `01KZW10CV7XE855CEBE8THGZYR` (works once wanderer's fix is merged — it's in this same file's history by then), `lane_submit` after merge, `team_send status_update`, and hand the rendering surface to miley: `team_send {act:'handoff'}`-shaped message naming `Goal.outcome`, `notices`, `review_debt`, and outcome-less shipped goals as the four things the grid may now render.
- [ ] **Step 5: Dogfood immediately:** write real outcome notes on today's shipped goals (`goals-front-door`, `harness-residency`, `human-ask-stream`) — the reading of those three lines is the review gate for whether the mechanism earns its place.

---

## Self-review notes

- Spec coverage: §1 claim-linking → Task 6; §2 outcome signal → Tasks 1/2/4/6/7; §3 ship nudge → Task 4; §4 stale_acceptance + team_next → Tasks 3/5/6; §5 epoch → Task 8; non-goals respected (no web edits, no per-seat metrics, no gates).
- The `stale_acceptance` warning's repair text deliberately names no exact call syntax beyond `team_next` (spec §4's pinned-wording rule) — the acceptance ask itself carries the accept/decline contract.
- Line-number anchors are as of `6640f81e` and drift with wanderer's merge — anchor by the quoted code, not the number.
