# Goals Front Door Implementation Plan

> **For agentic workers:** this plan is executed inside musterd lane
> 01KZVTD99RNZT082JJB0CSCA34 by its owner (or a seat it is handed off to) — one task at a
> time, in order, on branch `miley/goals-front-door`. Steps use checkbox (`- [ ]`) syntax
> for tracking. Do not dispatch anonymous writing subagents (see ~/.claude/CLAUDE.md).

**Goal:** Goals get mechanical consequences (a `no_goal` lane warning, a `story` field,
goal-first `team_next`, a close-time nudge) and the web board defaults to a goals-grid
front door (mission cards with per-goal runways).

**Architecture:** Additive protocol changes (one enum value, one optional field) flow
through the existing declared-Goal seam (message-log projection, no new tables). The server
emits the new warning from the existing `laneWarnings` site. The web grid is a new view in
`Board.tsx` fed entirely by data the board page already fetches (`lanes` + `report.goals`);
all layout logic lives in a pure module so it is testable under the repo's node-only vitest.

**Tech Stack:** zod schemas in `@musterd/protocol`, better-sqlite3 store + node http in
`@musterd/server`, MCP tools in `@musterd/mcp`, React 18 + TanStack Router + plain CSS in
`packages/web`. Tests: vitest (node env, `.test.ts` only — **no component tests**; extract
logic to pure modules).

**Spec:** `docs/superpowers/specs/2026-08-12-goals-front-door-design.md`. The visual
reference is `.superpowers/brainstorm/78712-1786565615/content/top-level-layout-v5.html`.

## Global Constraints

- THE GIT LOOP: work on `miley/goals-front-door` (branched from fresh main); PR;
  `gh pr merge --squash --auto --delete-branch`; never merge locally.
- Build the whole repo (`pnpm -r build`) before `pnpm -r typecheck` — protocol `.d.ts`
  phantoms otherwise. `pnpm lint` and `pnpm format:check` are separate gates. Format only
  your own files: `pnpm exec prettier --write <files>` (never `pnpm format`).
- `pnpm vocab:check` gates new docs — no banned structural nouns (epic/milestone/sprint) in <!-- vocab:ok -->
  the ADR.
- `pnpm perf:check` (ADR 151 byte budgets) must stay green after the web tasks.
- Warning stays advisory everywhere: `no_goal` must never fail a verb.
- Copy rules from the design: header title **"What's being worked on"**; ungrouped card
  title **"Not on a goal yet"**; zone labels **backlog · working · review · shipped 🏁**;
  no scrolling ticker.
- All web animation CSS-only; `prefers-reduced-motion` disables movement.
- `FEATURE_EPOCH` bumps 9 → 10 exactly once (Task 1).

---

### Task 1: Protocol — `story`, `no_goal`, epoch 10

**Files:**

- Modify: `packages/protocol/src/goals.ts` (GoalDeclareMetaSchema :19, GoalSchema :31,
  DeclareGoalSchema :59)
- Modify: `packages/protocol/src/lanes.ts` (LaneWarningSchema :239)
- Modify: `packages/protocol/src/feature-epoch.ts` (:58)
- Create: `packages/protocol/src/goals.test.ts`

**Interfaces:**

- Produces: `GoalStorySchema` (exported; `z.string().trim().min(1).max(140)`),
  `story?: string` on `GoalDeclareMetaSchema.goal` / `DeclareGoalSchema`,
  `story: z.string().optional()` on `GoalSchema`; `'no_goal'` in `LaneWarningSchema.kind`;
  `FEATURE_EPOCH = 10`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/src/goals.test.ts
import { describe, expect, it } from 'vitest';
import { DeclareGoalSchema, GoalDeclareMetaSchema, GoalSchema } from './goals.js';
import { LaneWarningSchema } from './lanes.js';

describe('story on Goal (goals-front-door design)', () => {
  it('accepts an optional trimmed story on declare, caps at 140', () => {
    const meta = GoalDeclareMetaSchema.parse({
      goal: { id: 'g1', title: 'Native harness', story: '  the daemon becomes its own harness  ' },
    });
    expect(meta.goal.story).toBe('the daemon becomes its own harness');
    expect(() =>
      DeclareGoalSchema.parse({ id: 'g1', title: 't', story: 'x'.repeat(141) }),
    ).toThrow();
  });
  it('GoalSchema carries story through the read projection', () => {
    const g = GoalSchema.parse({
      id: 'g1',
      title: 't',
      wave: null,
      depends_on: [],
      declared_by: 'nick',
      declared_at: 1,
      status: 'planned',
      epoch: 0,
      story: 'plain words',
    });
    expect(g.story).toBe('plain words');
  });
});

describe('no_goal warning kind', () => {
  it('parses', () => {
    const w = LaneWarningSchema.parse({
      kind: 'no_goal',
      subject: 'L1',
      with: 'g1',
      owner: null,
      detail: 'on no goal — link it: lane_update {goal_id}',
    });
    expect(w.kind).toBe('no_goal');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run packages/protocol/src/goals.test.ts`
      → FAIL (`story` stripped / unknown enum value `no_goal`).

- [ ] **Step 3: Implement.** In `goals.ts`: export
      `export const GoalStorySchema = z.string().trim().min(1).max(140);` and add
      `story: GoalStorySchema.optional()` (doc comment: _"plain-language one-liner for the
      stranger — what this goal means, not its title"_) to the `goal` object in
      `GoalDeclareMetaSchema`, to `DeclareGoalSchema`, and `story: z.string().optional()` to
      `GoalSchema`. In `lanes.ts` add `'no_goal'` to the `kind` enum and extend the
      LaneWarning doc comment (goals-front-door design: _"`no_goal` — a contending lane on no
      goal while the team has unshipped goals; advisory, owner-null, never woken"_). In
      `feature-epoch.ts` set `FEATURE_EPOCH = 10 as const` with a changelog comment block
      (`// Epoch 10 — no_goal lane warning + Goal.story (goals front door). An epoch-9 seat
neither emits nor renders either.`).

- [ ] **Step 4: Run to verify pass** — same command, plus
      `pnpm vitest run packages/server/src/transport/integration.test.ts` (epoch assertion
      imports the constant; confirm still green).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "protocol: Goal.story + no_goal warning kind, epoch 10"`

---

### Task 2: Server + MCP — `story` flows declare → store → projection → render

**Files:**

- Modify: `packages/server/src/store/goals.ts` (GoalAccumulator :30, declaration fold
  :135-147, projection literal :161-171)
- Modify: `packages/server/src/transport/http.ts` (`POST /goals` meta literal :2660)
- Modify: `packages/mcp/src/tools/goals.ts` (inputSchema :51, fmtGoal :14)
- Test: `packages/server/src/store/goals.test.ts` (existing; has a declare-envelope
  helper at :22-41 — extend it)

**Interfaces:**

- Consumes: `GoalStorySchema` / `story` fields from Task 1.
- Produces: `listGoals` projections carry `story`; `team_goal_declare` accepts
  `story?: string`; `fmtGoal` prints `— "story"` when present.

- [ ] **Step 1: Failing test.** In `goals.test.ts`, extend the local declare helper's
      `goal` param type with `story?: string` (it passes the whole object as `meta.goal`
      already), then:

```ts
it('story rides the declaration and re-declaration amends it', () => {
  const { db, team } = seed();
  declare(db, team.id, 1, { id: 'g1', title: 'Auth', story: 'first words' });
  declare(db, team.id, 2, { id: 'g1', title: 'Auth', story: 'better words' });
  const goals = listGoals(db, team.id, 'revive');
  expect(goals[0]!.story).toBe('better words');
});
it('story is absent when never declared', () => {
  const { db, team } = seed();
  declare(db, team.id, 1, { id: 'g1', title: 'Auth' });
  expect(listGoals(db, team.id, 'revive')[0]!.story).toBeUndefined();
});
```

(Use the file's actual helper/seed names — the declare helper is at :22-41.)

- [ ] **Step 2: Run to verify fail** — `pnpm vitest run packages/server/src/store/goals.test.ts`
- [ ] **Step 3: Implement.** `GoalAccumulator` gains `story?: string`; the fold at :135
      sets `story: g.story ?? prior?.story` — wait, no: _a re-declaration replaces the skeleton
      wholesale_ (comment at :143) — so `story: g.story` (undefined clears, latest wins,
      consistent with title/depends_on). Projection literal emits
      `...(g.story !== undefined ? { story: g.story } : {})`. In `http.ts:2660` add
      `story: body.story` to the meta literal. In MCP `goals.ts` add
      `story: z.string().max(140).optional().describe('one plain-language line for outsiders — what this goal means')`
      to the inputSchema, and in `fmtGoal` append `` `${g.story ? ` — "${g.story}"` : ''}`` ``.
- [ ] **Step 4: Run to verify pass** — same command.
- [ ] **Step 5: Commit** — `"server+mcp: Goal.story through declare, store, projection, render"`

---

### Task 3: Server — the `no_goal` warning

**Files:**

- Modify: `packages/server/src/store/lanes.ts` (`laneWarnings` :458, `boardWarnings` :503)
- Modify: `packages/server/src/transport/http.ts` (`POST /lanes` open path :2701)
- Test: `packages/server/src/store/lanes.test.ts`

**Interfaces:**

- Consumes: `listGoals` (store/goals.ts:92), `LANE_CONTENDING_STATES`.
- Produces: `noGoalWarning(lane: Lane, goals: Goal[]): LaneWarning | null` exported from
  `store/lanes.ts`; `laneWarnings` gains an optional trailing param
  `goals?: Goal[]` (precomputed; defaults to `listGoals` internally).

- [ ] **Step 1: Failing tests** (in `lanes.test.ts`, new describe; reuse `seed()` :22 and
      the goal-declare pattern from `goals.test.ts` — import or replicate its envelope helper):

```ts
describe('no_goal warning (goals-front-door design)', () => {
  it('a contending goal-less lane warns when an unshipped goal exists', () => {
    const { db, team } = seed();
    declare(db, team.id, 1, { id: 'g1', title: 'Native harness' });
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'work', claim: true });
    const w = laneWarnings(db, team.id, 'bravo', lane);
    expect(w.some((x) => x.kind === 'no_goal' && x.owner === null && x.with === 'g1')).toBe(true);
  });
  it('never warns: attached lane / no goals declared / only shipped goals / backlog lane', () => {
    const { db, team } = seed();
    // no goals declared:
    const bare = openLane(db, team.id, 'bravo', 'June', { title: 'a', claim: true });
    expect(laneWarnings(db, team.id, 'bravo', bare).some((x) => x.kind === 'no_goal')).toBe(false);
    declare(db, team.id, 1, { id: 'g1', title: 'G' });
    // attached:
    const linked = openLane(db, team.id, 'bravo', 'Cleo', {
      title: 'b',
      goal_id: 'g1',
      claim: true,
    });
    expect(laneWarnings(db, team.id, 'bravo', linked).some((x) => x.kind === 'no_goal')).toBe(
      false,
    );
    // backlog (open, unclaimed) lane does not flag on the board:
    const idle = openLane(db, team.id, 'bravo', 'Cleo', { title: 'c' });
    expect(laneWarnings(db, team.id, 'bravo', idle).some((x) => x.kind === 'no_goal')).toBe(false);
  });
  it('board projection carries it once per lane', () => {
    const { db, team } = seed();
    declare(db, team.id, 1, { id: 'g1', title: 'G' });
    openLane(db, team.id, 'bravo', 'June', { title: 'w', claim: true });
    const lanes = listLanes(db, team.id, 'bravo');
    expect(
      boardWarnings(db, team.id, 'bravo', lanes).filter((w) => w.kind === 'no_goal'),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm vitest run packages/server/src/store/lanes.test.ts`
- [ ] **Step 3: Implement.** In `store/lanes.ts`:

```ts
/** goals-front-door design: advisory nudge — a lane on no goal while goals are in flight.
 *  `with` = the first unshipped goal by wave (a suggestion); owner null = never a directed wake. */
export function noGoalWarning(lane: Lane, goals: Goal[]): LaneWarning | null {
  if (lane.goal_id !== null) return null;
  const unshipped = goals.filter((g) => g.status !== 'shipped');
  if (unshipped.length === 0) return null;
  const suggest = [...unshipped].sort((a, b) => waveRank(a.wave) - waveRank(b.wave))[0]!;
  return {
    kind: 'no_goal',
    subject: lane.id,
    with: suggest.id,
    owner: null,
    detail: `on no goal — ${unshipped.length} in flight; link it: lane_update {goal_id: "${suggest.id}"} (or another)`,
  };
}
```

(export `waveRank` from `store/goals.ts:175`, or duplicate the 3-line rank). In
`laneWarnings`, after the overlap block:
`if (CONTENDING.has(lane.state)) { const w = noGoalWarning(lane, goals ?? listGoals(db, teamId, teamSlug)); if (w) warnings.push(w); }`
— where `goals` is the new optional param. `boardWarnings` computes
`const goals = listGoals(db, teamId, teamSlug);` once and passes it through (change its
inner call to `laneWarnings(db, teamId, teamSlug, lane, goals)`). The dedup key at :514
already yields `no_goal:<lane>:<goal>` — per-lane, correct. **Open path (state `open`,
not contending):** in `http.ts:2701` append the advisory to the response only:
`const openNudge = noGoalWarning(lane, listGoals(ctx.db, team.id, team.slug)); ` and
include it in the 201 body's `warnings` array **after** `deliverLaneWarnings` is called
(the opener sees it in their result; nobody is woken — matches `owner: null` semantics
and the existing comment "all warnings are fresh at open").

- [ ] **Step 4: Run to verify pass**; also `pnpm vitest run packages/server/src/transport/integration.test.ts`.
- [ ] **Step 5: Commit** — `"server: no_goal lane warning — advisory at open/claim, board while contending"`

---

### Task 4: Acceptance backstop — the close-time question

**Files:**

- Modify: `packages/server/src/transport/http.ts` (`acceptanceAskBody` :815, its call site
  :3037-3064, and `priorOwnerNotice` :806 as the pattern)
- Test: `packages/server/src/transport/integration.test.ts` (existing acceptance-ask
  coverage — grep `acceptance requested` there and extend the nearest test)

**Interfaces:**

- Consumes: `lane.goal_id` (in scope at the call site).
- Produces: `acceptanceAskBody(title, opts)` gains `opts.noGoalNotice?: string`; helper
  `noGoalNotice(goalId: string | null): string` (module-local, exported for tests like
  nothing else in http.ts is — keep it local and assert via the integration test instead).

- [ ] **Step 1: Failing test.** In the integration test that asserts the acceptance ask
      body (grep `acceptance requested:`), submit a lane **without** `goal_id` and assert the
      delivered ask body contains `on no goal — if it advanced one, link it` ; submit an
      attached lane and assert it does not.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.** Mirror `priorOwnerNotice`:

```ts
/** goals-front-door design: close-time attribution nudge — appended, never blocking. */
function noGoalNotice(goalId: string | null): string {
  if (goalId !== null) return '';
  return ' This lane is on no goal — if it advanced one, link it (lane_update {goal_id}) before resolving.';
}
```

Thread `noGoalNotice(lane.goal_id)` into `acceptanceAskBody` via a new opts key (same
append position as `overlapNotice`), at the :3037 call site.

- [ ] **Step 4: Run to verify pass** — the integration suite.
- [ ] **Step 5: Commit** — `"server: acceptance ask nudges goal attribution on goal-less lanes"`

---

### Task 5: `team_next` leads with goals

**Files:**

- Modify: `packages/protocol/src/lanes.ts` (NextBriefSchema :384-436)
- Modify: `packages/server/src/store/orientation.ts` (`deriveNext` :68, return :174)
- Modify: `packages/mcp/src/tools/lanes.ts` (`fmtNext` :447-503)
- Test: `packages/server/src/store/orientation.test.ts`

**Interfaces:**

- Produces: `NextBriefSchema` gains `goals: z.array(GoalSchema).default([])` — the team's
  unshipped goals, wave-ordered (`in-flight` before `planned` at equal wave). `.default([])`
  keeps old daemons parseable; the MCP client casts (lanes.ts:453-456), so skew is safe.
  `fmtNext` renders goals first and appends the ungrouped nudge.

- [ ] **Step 1: Failing test** (orientation.test.ts — follow its existing seed/derive
      pattern):

```ts
it('brief leads with unshipped goals, wave-ordered, and up_next puts goal-attached lanes first', () => {
  // declare g2 (wave 2), g1 (wave 1); open lanes: one on g1, one ungrouped, both open
  const brief = deriveNext(db, team.id, 'revive', 'June');
  expect(brief.goals.map((g) => g.id)).toEqual(['g1', 'g2']);
  expect(brief.up_next[0]!.goal_id).toBe('g1'); // attached before ungrouped
});
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.** In `deriveNext`: `const all = listGoals(db, teamId, teamSlug);`
      → `goals: all.filter((g) => g.status !== 'shipped').sort(byWaveThenStatus)`; keep
      `next_goal` as-is; stable-sort `up_next` with attached-first
      (`(a, b) => Number(b.goal_id !== null) - Number(a.goal_id !== null)` before the existing
      ordering). In `fmtNext`: move/lead with a `goals in flight` block (id, title, story,
      status), keep the `next goal` claim hint, and when a served `up_next` lane has
      `goal_id === null` append one line: `  (on no goal — link it: lane_update {goal_id})`.
- [ ] **Step 4: Run to verify pass** — orientation + integration suites.
- [ ] **Step 5: Commit** — `"team_next: brief leads with unshipped goals; goal-attached lanes served first"`

---

### Task 6: Web pure logic — `goalGrid.ts`

**Files:**

- Create: `packages/web/src/live/goalGrid.ts`
- Create: `packages/web/src/live/goalGrid.test.ts`
- Modify (Task 7 removes consumers): none yet.

**Interfaces (Produces — Task 7 renders exactly these):**

```ts
export type RunwayZone = 'backlog' | 'working' | 'review' | 'shipped';
export interface RunwayDot {
  lane: string; // lane id
  zone: RunwayZone;
  x: number; // 0..100, deterministic jitter within the zone band
  kind: 'dot' | 'rider'; // rider = claimed/active (renders the owner avatar)
  tone: 'idle' | 'working' | 'blocked' | 'review' | 'done';
  owner: string | null;
  latest: boolean; // ✨ — most recently resolved done lane
}
export interface GoalCardModel {
  id: string | null; // null = "Not on a goal yet"; undeclared ids keep the raw id
  title: string; // 'Not on a goal yet' for null; raw id for undeclared
  story: string | null; // goal.story ?? fallback ("N lanes · started <rel>") ?? null
  declared: boolean; // false → "declare me" chip
  chip: 'queued' | 'just started' | 'in flight' | 'shipped' | 'lanes';
  dots: RunwayDot[];
  overflow: number; // dots beyond the cap (14) — render "+N"
  counts: { total: number; done: number; blocked: number; review: number };
  lastMoved: { lane: string; title: string; at: number } | null; // ⚡ pill
}
export interface GoalGridModel {
  cards: GoalCardModel[]; // wave-ordered; "Not on a goal yet" last; shipped excluded
  shippedShelf: { id: string; title: string }[];
  pulse: { title: string; at: number } | null; // team-wide latest done lane
}
export function buildGoalGrid(lanes: Lane[], goals: Goal[], now: number): GoalGridModel;
export const RUNWAY_DOT_CAP = 14;
```

Zone mapping (from the design): `open`→backlog · `claimed`/`active`→working (rider) ·
`blocked`→working (tone blocked) · `awaiting_acceptance`/`ready_for_review` (use
`isAwaitingAcceptance`)→review · `done`→shipped · `abandoned` excluded. Jitter:
`x = zoneStart + (hash(laneId) % zoneWidth)` with a small deterministic string hash
(djb2) — stable across renders. Chip: `planned`→`queued`; in-flight with 0 done→
`just started`; else derived status; the null-card uses `'lanes'` (renders the count).

- [ ] **Step 1: Failing tests** (`goalGrid.test.ts`, factories copied from
      `boardWrite.test.ts:16+`): cover — zone mapping incl. `ready_for_review` alias and
      abandoned exclusion; rider vs dot kinds; deterministic x (same input twice → same x);
      overflow past 14 (counts preserved); chip derivation matrix; story fallback; undeclared
      goal id card `declared: false`; "Not on a goal yet" card last and absent when all lanes
      attached; shipped goals in `shippedShelf` not `cards`; `pulse` = max `resolved_at` done
      lane; empty-goals input → `cards` = [] (route falls back to columns, Task 8).
- [ ] **Step 2: Run to verify fail** — `pnpm vitest run packages/web/src/live/goalGrid.test.ts`
- [ ] **Step 3: Implement** `buildGoalGrid` per the interface above.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `"web: goalGrid pure model — zones, jitter, chips, shelf, pulse"`

---

### Task 7: Web components — GoalGrid renders, Board hosts it, swimlanes retire

**Files:**

- Create: `packages/web/src/live/GoalGrid.tsx` (components: `GoalGrid`, `GoalCard`,
  `Runway` — render `GoalGridModel`, no logic of their own)
- Create: `packages/web/src/live/GoalGrid.css` (own file; imported by GoalGrid.tsx —
  Live.css stays untouched except removing dead band styles)
- Modify: `packages/web/src/live/Board.tsx` (view type `'columns' | 'grid'`; replace the
  `view === 'goals'` swimlane branch :259-320 with `<GoalGrid …>`; keep `warned` map)
- Modify: `packages/web/src/live/boardWrite.ts` (+ its test) — delete `groupByGoal` +
  `GoalRow` and their suite (:91-126, tests :150-192)

**Interfaces:**

- Consumes: `buildGoalGrid` (Task 6), `memberAvatar`/`kindOf` (existing, for riders),
  `Goal.story` (Task 2 via `report.goals`).
- Produces: `<GoalGrid lanes={lanes} goals={goals} roster={roster} onOpenGoal={(goalId: string | null) => void} />`;
  `BoardProps.view: 'columns' | 'grid'`; `BoardProps.onOpenGoal?: (goalId: string | null) => void`.

- [ ] **Step 1: Failing check** — `pnpm -r build && pnpm -r typecheck` after changing
      `BoardProps.view` type (board.tsx still passes `'goals'` → compile error is the failing
      state; Task 8 fixes the route, so within this task temporarily map the route's value at
      the call site: pass `view === 'columns' ? 'columns' : 'grid'`).
- [ ] **Step 2: Implement the components.** Visual spec = the v5 mockup file (v3/v4/v5 CSS
      is directly liftable: `.stage` gradient, `.gcard` hover lift/tilt + `peek`, `.runway`
      track/zones/ticks, `.dot` tones (`review` wiggle, `blocked` pulse), `.rider` bob with
      avatar, `.landed` sparkle, shimmer, footer counts + ⚡ pill, dashed `.loose` card,
      shipped shelf as one slim row, header block **"What's being worked on"** + sub
      `<team> team · N goals in flight · M seats at work · updated live` + pulse-line pill).
      Wrap every keyframe usage in
      `@media (prefers-reduced-motion: reduce) { animation: none; }` equivalents. Card click →
      `onOpenGoal(card.id)`; card is a `<button>` (a11y). Observer mode: grid is read-only by
      nature (no write affordances on cards).
- [ ] **Step 3: Verify in the browser** — `pnpm -r build`, restart `vite preview` (ALWAYS
      after build — stale dist otherwise), open `/board`, flip the toggle, check: grid renders
      from live data, hover, reduced-motion via devtools emulation, dark-room sanity on `/live`
      later (Task 9). Console clean.
- [ ] **Step 4: Tests still green** — `pnpm vitest run packages/web` (boardWrite suite
      shrinks; goalGrid suite covers the logic).
- [ ] **Step 5: Commit** — `"web: GoalGrid view replaces goals swimlanes on the board"`

---

### Task 8: Route wiring — grid default, toggle migration, drill-in, deep links

**Files:**

- Modify: `packages/web/src/routes/board.tsx` (view state :97-108, toggle :245-265, Board
  invocation :360-372)
- Test: extend `packages/web/src/live/goalGrid.test.ts` with the small pure helpers below
  (put them in `goalGrid.ts`, not the route, so they're testable)

**Interfaces:**

- Produces (in `goalGrid.ts`):
  `resolveBoardView(stored: string | null, goalCount: number): 'grid' | 'columns'` —
  `'columns'` stored → columns; `'grid'` or legacy `'goals'` stored → grid; nothing
  stored → grid iff `goalCount > 0` else columns.
  `goalFilter(lanes: Lane[], goalId: string | null | undefined): Lane[]` — `undefined` =
  no filter; `null` = goal-less lanes only; id = that goal's lanes.

- [ ] **Step 1: Failing tests** for both helpers (all branches, incl. legacy `'goals'`).
- [ ] **Step 2: Run to verify fail; implement; verify pass.**
- [ ] **Step 3: Wire the route.** `view` state becomes `'grid' | 'columns'` resolved via
      `resolveBoardView(localStorage.getItem(VIEW_KEY), report?.goals.filter(g => g.status !== 'shipped').length ?? 0)`
      (re-resolve when the report first arrives if nothing is stored); `pickView` persists
      `'grid' | 'columns'`. Toggle buttons: **grid | columns** (grid first). Drill-in state:
      `const [goalFocus, setGoalFocus] = useState<string | null | undefined>(searchParams.goal)`;
      `onOpenGoal={(id) => { setGoalFocus(id); pickView('columns'); }}`; columns receive
      `goalFilter(shownLanes, goalFocus)`; a back chip ("← goals") above the columns clears
      `goalFocus` and returns to grid. Deep link: reflect `goalFocus` into `?goal=` (id or
      `none` for null) via router search params, parse on mount.
- [ ] **Step 4: Browser verification** — build, restart preview, walk: default lands on
      grid (team has goals), card click filters columns, back chip returns, `?goal=` deep link
      works, stored legacy `'goals'` value lands on grid, zero-goal team (toggle team or empty
      fixture) defaults to columns. Console clean.
- [ ] **Step 5: Commit** — `"web: board defaults to the goals grid; drill-in + view migration"`

---

### Task 9: `/live` overlay joins

**Files:**

- Modify: `packages/web/src/routes/live.tsx` (add `const report = useReport(cfg, envelopes);`
  beside the existing hooks; pass `goals={report?.goals ?? []}` to `<BoardOverlay …>`)
- Modify: `packages/web/src/live/BoardOverlay.tsx` (accept `goals: Goal[]`; own
  view state defaulting via `resolveBoardView(null, unshippedCount)`; render the same
  toggle; replace the hardcoded `view="columns"` at :160; **delete the omission comment at
  :32-33** — this design resolves that hold)

**Interfaces:**

- Consumes: `resolveBoardView`, `GoalGrid` via `Board`, `useReport` (existing hook).

- [ ] **Step 1: Implement** (no new logic — all pure parts are tested; this is wiring).
- [ ] **Step 2: Browser verification** — build, **restart vite preview**, open `/live`,
      click the wall board: overlay opens on the grid, toggle to columns works, drill-in
      works inside the overlay, reduced motion respected, panel still opens at ~62% (don't
      touch the zoom math). Check `pnpm perf:check` — the overlay lazy chunk grew; stay in
      budget (GoalGrid is already in the board chunk from Task 7).
- [ ] **Step 3: Commit** — `"live: board overlay leads with the goals grid (resolves the 2026-07-31 hold)"`

---

### Task 10: ADR, gates, PR

**Files:**

- Create: `docs/decisions/<next-free-number>-goals-are-the-boards-front-door.md`
  (254 if still free — three live lanes overlap `docs/decisions/**`; check `ls` and the
  open PRs before minting, per the ADR 221 numbering-conflict precedent)

- [ ] **Step 1: Write the ADR.** Status accepted; deciders nick + miley. Decision: goals
      are the board's top level; a goal-less lane is **warned, never refused** (`no_goal`,
      advisory at open/claim, board-visible while contending); `story` on Goal; `team_next`
      goal-first; acceptance nudge; epoch 10. Alternatives rejected: hard gate (garbage
      attachment, against warn-first house style), derived clustering (machine clusters aren't
      intentions), close-time-only (board stays ungrouped while work is in flight). Run
      `pnpm vocab:check`.
- [ ] **Step 2: Full gates, in order** — `pnpm -r build` → `pnpm -r typecheck` →
      `pnpm vitest run` → `pnpm lint` → `pnpm format:check` → `pnpm perf:check`.
- [ ] **Step 3: PR** — push; `gh pr create` (body: spec + ADR links, the four teeth, the
      grid, epoch bump; `🤖 Generated with [Claude Code](https://claude.com/claude-code)`);
      `gh pr merge --squash --auto --delete-branch`. If Bugbot's check never registers,
      comment `bugbot run`.
- [ ] **Step 4: Lane** — `lane_submit` with review notes; after merge + acceptance,
      `lane_resolve`.

**Rollout (post-merge, operational — not a code task):** per spec Part 3 — add stories to
the eight existing goals, declare the running arcs (wake pricing / any-of asks / goals
front door), declare-or-retire `human-ask-stream`, retire `verify-adr111-scratch`, then
link in-flight lanes with `lane_update goal_id` or let the fresh `no_goal` warnings prompt
their owners. The daemon auto-refreshes on merge; never task nick with `service refresh`.

**Expect the warning to be loud on day one.** Attachment on revive is 14 lanes out of ~400,
so nearly every contending lane will carry `no_goal` the moment Task 3 lands. That is the
signal working, not a bug — but confirm before shipping that the board renders a heavily
warned column without visual chaos (the card shows one warning detail, last-wins,
`Board.tsx:124`), and that `deliverLaneWarnings` does not wake anyone for it
(`owner: null` — assert this in Task 3's test).

---

## Self-review notes

- **Spec coverage:** teeth 1b→Task 3, 1a→Tasks 1-2, 1c→Task 4, Part 2→Task 5, Part 3→
  rollout note, Part 4 grid→Tasks 6-8, overlay→Task 9, skew/epoch→Task 1 (+ the web
  strict-parse hazard is moot in-repo: daemon and web bundle ship together, ADR 062
  same-origin), ADR→Task 10. Edge cases from the spec are all in Task 6's test list plus
  Task 8's zero-goal default.
- **Deliberate deviation:** component render (Tasks 7-9) is browser-verified, not
  unit-tested — the repo has no component-test rig (node-only vitest, no jsdom), and the
  established pattern is pure-module extraction, which Tasks 6/8 follow.
- **Type consistency:** `GoalCardModel`/`RunwayDot`/`resolveBoardView`/`goalFilter`
  defined once in Task 6/8 interfaces; Tasks 7-9 consume those exact names.
