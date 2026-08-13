# Quiet-set acceptance increment 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (musterd note: no writing subagents — ADR 150 / AGENTS.md. Execute inline in the wanderer seat, lane `01KZ9FNC6VQ8NJH7R2KAMCV5D1`.)

**Goal:** Live acceptance pick drops busy agents, so `lane_submit` does not sole-target a mid-turn seat.

**Architecture:** `pickReviewCounterpart` already filters live non-owner non-service agents and runs the ADR 188 ladder. Add one more predicate: an agent whose newest *work* audit is younger than 120s is ineligible. Null pick still falls through to the existing ADR 191 wake / `no_candidate` path in `http.ts` — do not touch that caller. `pickHumanReviewer` stays presence-only.

**Tech Stack:** TypeScript monorepo (pnpm), better-sqlite3 store, vitest, existing `resolveQuiescence` / `lastActionByActor` in `packages/server/src/store/quiescence.ts`.

**Spec:** `docs/superpowers/specs/2026-08-12-quiet-set-acceptance-design.md` (increment 1 only). Increment 2 (eligible-set `ask`) is out of scope.

## Global Constraints

- Drop **busy agents only**. `unknown` (no work-audit in lookback) degrades to today's presence-only behaviour (ADR 173) — do not treat "no evidence" as busy.
- Do **not** quiet-filter `pickHumanReviewer`. A busy nick on a risky lane still beats `human_review_missed`.
- Do **not** change `ELIGIBLE_ACTS`, `owed_reviews`, submit hints, or the wake path.
- Occupancy attestation is not work. `attach()` writes `occupancy.model_attested` with `actor = member.name` at now; if the picker used raw `lastActionByActor`, every existing ladder test would go null and every freshly-claimed seat would be ineligible for 120s. Exclude that action from the picker's busy read. Wake-pool `lastActionByActor` stays unfiltered (ADR 219).
- Busy line is `QUIESCENCE_DEFAULT_QUIET_AFTER_MS` (120_000), same as the wake pool's `seat_quiet` fact.
- No protocol schema change, no `FEATURE_EPOCH` bump.
- `pnpm adr:next` for the ADR number at write time — never invent one. Push the branch as a draft PR before writing the ADR (ADR 223).
- Never Prettier `docs/`. Seat trailer on every commit: `Co-authored-by: wanderer <wanderer@revive.musterd>`.
- Build order: `pnpm --filter @musterd/server exec vitest run src/store/review.test.ts` is the loop; `pnpm typecheck && pnpm format:check` before push.

### File map

| File | Role |
| ---- | ---- |
| `packages/server/src/store/review.test.ts` | New describe: busy live agent loses; only-busy live pool → null; unknown still eligible; human picker unchanged |
| `packages/server/src/store/quiescence.ts` | Optional `excludeActions` on `lastActionByActor` so the picker can omit `occupancy.model_attested` without a second query shape |
| `packages/server/src/store/quiescence.test.ts` | One test that excludeActions omits the named action |
| `packages/server/src/store/review.ts` | Busy filter inside `pickReviewCounterpart` |
| `docs/decisions/NNN-*.md` | Short ADR: live pick drops busy agents |
| `docs/architecture/03-server.md` | One-line update on the `review.ts` tree line |
| `docs/superpowers/specs/2026-08-12-quiet-set-acceptance-design.md` | Dated note that increment 1 is the live pick filter (no Decision rewrite of other ADRs) |

---

### Task 1: Failing tests — busy live agent is not the acceptor

**Files:**
- Modify: `packages/server/src/store/review.test.ts` (append a new `describe` after the graded-ladder block, ~line 423)
- Modify: `packages/server/src/store/quiescence.test.ts` (one `excludeActions` case next to existing `lastActionByActor` tests)

**Interfaces:**
- Consumes: existing `seed()`, `agent()`, `TIMEOUT`, `openLane`, `pickReviewCounterpart`, `pickHumanReviewer`, `addMember`, `attach`, `appendAudit` (from `./audit.js`).
- Produces: the behavioural contract Task 2 must satisfy. No new exports yet. Helper `acted(db, team, actor, agoMs)` inserts an `x.did` audit row at `Date.now() - agoMs`, same shape as the ADR 219 helper in this file (~line 187).

- [ ] **Step 1: Add the picker describe with four cases**

Append after the graded-ladder `describe` (`pickReviewCounterpart — graded ladder`), before `pickWakeReviewer`:

```ts
describe('pickReviewCounterpart — drops busy live agents (quiet-set inc 1)', () => {
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
      .run(`aud-${actor}-${String(agoMs)}`, team.id, actor, Date.now() - agoMs, Date.now() - agoMs);

  async function pick(setup: (h: ReturnType<typeof seed>) => void) {
    const { openLane } = await import('./lanes.js');
    const { pickReviewCounterpart } = await import('./review.js');
    const h = seed();
    agent(h.db, h.team, 'worker', 'claude-opus-5');
    setup(h);
    const lane = openLane(h.db, h.team.id, 'dawn', 'worker', {
      title: 'a change',
      claim: true,
    });
    return pickReviewCounterpart(h.db, h.team.id, lane, 'worker', TIMEOUT);
  }

  it('a live busy cross-family seat loses to a quiet cross-model seat', async () => {
    const p = await pick(({ db, team }) => {
      agent(db, team, 'gptbot', 'gpt-5.6-sol');
      agent(db, team, 'dolly', 'claude-opus-4-8');
      acted(db, team, 'gptbot', 5_000); // busy
      acted(db, team, 'dolly', 180_000); // quiet (≥ 120s)
    });
    expect(p).toMatchObject({ reviewer: 'dolly', grade: 'cross_model' });
  });

  it('a team of only-busy live agents finds no live candidate (wake / no_candidate is the caller)', async () => {
    const p = await pick(({ db, team }) => {
      agent(db, team, 'gptbot', 'gpt-5.6-sol');
      acted(db, team, 'gptbot', 5_000);
    });
    expect(p).toBeNull();
  });

  it('unknown (no work audit) stays eligible — occupancy attestation is not work', async () => {
    // agent() calls attach(), which writes occupancy.model_attested as actor=name at now.
    // If the picker treats that as work, this is null and every ladder test above breaks.
    const p = await pick(({ db, team }) => agent(db, team, 'gptbot', 'gpt-5.6-sol'));
    expect(p).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
  });

  it('pickHumanReviewer still returns a live human who acted seconds ago', async () => {
    const { pickHumanReviewer } = await import('./review.js');
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    const { row } = addMember(db, team, { kind: 'human', name: 'nick', role: '' });
    attach(db, row.id, 'cli', 'conn-nick');
    acted(db, team, 'nick', 5_000);
    expect(pickHumanReviewer(db, team.id, 'ada', TIMEOUT)).toMatchObject({
      reviewer: 'nick',
      grade: 'human',
    });
  });
});
```

Do **not** change the existing graded-ladder tests. The `unknown stays eligible` case is the regression that keeps them green.

- [ ] **Step 2: Run the new tests — they must fail**

Run:

```bash
pnpm --filter @musterd/server exec vitest run src/store/review.test.ts
```

Expected: the first two new cases FAIL (gptbot still wins / gptbot still picked). The third currently PASSES (no filter yet — that's fine; it becomes the regression). The fourth currently PASSES (human picker untouched).

If the first case fails with `reviewer: 'gptbot'` you are in the right place. Do not implement yet.

- [ ] **Step 3: Commit the failing tests**

```bash
git add packages/server/src/store/review.test.ts
git commit -m "$(cat <<'EOF'
test: live acceptance pick must skip a busy agent

Quiet-set increment 1: a mid-turn cross-family seat is the 273-minute path.
Occupancy attestation must not count as work, or every attach looks busy.

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 2: Filter busy agents in `pickReviewCounterpart`

**Files:**
- Modify: `packages/server/src/store/quiescence.ts` (`lastActionByActor`, ~line 69)
- Modify: `packages/server/src/store/quiescence.test.ts`
- Modify: `packages/server/src/store/review.ts` (`pickReviewCounterpart`, ~line 313)

**Interfaces:**
- Consumes: `lastActionByActor`, `resolveQuiescence`, `QUIESCENCE_DEFAULT_QUIET_AFTER_MS` (already imported in `review.ts`).
- Produces: `lastActionByActor(db, teamId, { excludeActions?: string[] })` — when `excludeActions` is set, those `action` values are omitted from the MAX. Default / omitted ⇒ today's unfiltered map (wake pool unchanged). `pickReviewCounterpart` still returns `ReviewPick | null`.

- [ ] **Step 1: Failing test for `excludeActions`**

Inside the existing `describe('lastActionByActor (per-seat read for the roster + wake pool, ADR 219)')` in `packages/server/src/store/quiescence.test.ts` (it already has `seed()` + fake timers). `lastActionByActor` is already imported. Add:

```ts
it('excludeActions omits those rows from the newest-work map', () => {
  vi.useFakeTimers();
  try {
    const { db, team } = seed();
    const now = 10_000_000;
    vi.setSystemTime(now - 60_000);
    appendAudit(db, team.id, { actor: 'ada', action: 'x.did', target: null, result: 'allow' });
    vi.setSystemTime(now);
    appendAudit(db, team.id, {
      actor: 'ada',
      action: 'occupancy.model_attested',
      target: 'ada',
      result: 'allow',
    });
    const all = lastActionByActor(db, team.id, { now });
    const work = lastActionByActor(db, team.id, {
      now,
      excludeActions: ['occupancy.model_attested'],
    });
    expect(all.get('ada')).toBe(now);
    expect(work.get('ada')).toBe(now - 60_000);
  } finally {
    vi.useRealTimers();
  }
});
```

Run:

```bash
pnpm --filter @musterd/server exec vitest run src/store/quiescence.test.ts
```

Expected: FAIL (`excludeActions` is not on the opts type, so vitest/tsc rejects it, or both maps equal `now` if the extra field is ignored).

- [ ] **Step 2: Add `excludeActions` to `lastActionByActor`**

In `packages/server/src/store/quiescence.ts`, change the signature and SQL:

```ts
export function lastActionByActor(
  db: Database,
  teamId: string,
  opts: { now?: number; lookbackMs?: number; excludeActions?: string[] } = {},
): Map<string, number> {
  const now = opts.now ?? Date.now();
  const lookback = opts.lookbackMs ?? QUIESCENCE_LOOKBACK_MS;
  const exclude = opts.excludeActions ?? [];
  const rows =
    exclude.length === 0
      ? db
          .prepare<[string, number], { actor: string; last_ts: number }>(
            `SELECT a.actor AS actor, MAX(a.ts) AS last_ts
               FROM audit a
              WHERE a.team_id = ? AND a.ts > ?
              GROUP BY a.actor`,
          )
          .all(teamId, now - lookback)
      : db
          .prepare<[string, number, ...string[]], { actor: string; last_ts: number }>(
            `SELECT a.actor AS actor, MAX(a.ts) AS last_ts
               FROM audit a
              WHERE a.team_id = ? AND a.ts > ?
                AND a.action NOT IN (${exclude.map(() => '?').join(', ')})
              GROUP BY a.actor`,
          )
          .all(teamId, now - lookback, ...exclude);
  return new Map(rows.map((r) => [r.actor, r.last_ts]));
}
```

If better-sqlite3 typing of the spread bind is ugly, bind with a single JSON list via `json_each` **only if** the `NOT IN (?)` spread fails types — prefer the spread, it matches how the rest of the store does variable IN-lists. Keep `actor IS NOT NULL` out of the SQL unless tests show a null-actor group; today's query already groups by actor and the picker looks up by name.

Run the quiescence test. Expected: PASS.

- [ ] **Step 3: Filter busy agents in `pickReviewCounterpart`**

`lastActionByActor` and `resolveQuiescence` / `QUIESCENCE_DEFAULT_QUIET_AFTER_MS` are already imported in `review.ts`. Replace the candidate filter in `pickReviewCounterpart` with:

```ts
export function pickReviewCounterpart(
  db: Database,
  teamId: string,
  lane: Lane,
  worker: string,
  presenceTimeoutMs: number,
): ReviewPick | null {
  const lastWork = lastActionByActor(db, teamId, {
    excludeActions: ['occupancy.model_attested'],
  });
  const now = Date.now();
  const candidates = listMembers(db, teamId).filter((m) => {
    if (m.name === worker || m.observer || m.kind === 'service') return false;
    if (!hasLivePresence(db, m.id, presenceTimeoutMs)) return false;
    // Quiet-set inc 1: a live agent mid-turn is not an acceptor. `unknown` (no work
    // audit in lookback) degrades to presence-only — same as before this filter.
    // Agents only: a human in this list is dropped by pickLadder({agentsOnly:true})
    // anyway, but do not mark humans busy here so a future caller cannot empty
    // the human path by accident.
    if (m.kind === 'agent') {
      const actedAt = lastWork.get(m.name);
      if (
        actedAt !== undefined &&
        resolveQuiescence(actedAt, now, QUIESCENCE_DEFAULT_QUIET_AFTER_MS).state === 'busy'
      ) {
        return false;
      }
    }
    return true;
  });

  return pickLadder(db, teamId, worker, candidates, { agentsOnly: true });
}
```

Update the file-level comment on `pickReviewCounterpart` (the numbered precedence list at the top of `review.ts`, item 2) so it says live **and not busy** (quiescence 120s, work-audit, unknown kept). Do not rewrite the ADR 188 / 253 sentences.

Leave `pickHumanReviewer` and `pickWakeReviewer` untouched. Leave `http.ts` untouched — null pick already wakes.

- [ ] **Step 4: Run both suites**

```bash
pnpm --filter @musterd/server exec vitest run src/store/review.test.ts src/store/quiescence.test.ts
```

Expected: PASS, including the four new picker cases and the existing graded-ladder / ADR 172 / ADR 219 describes.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/quiescence.ts packages/server/src/store/quiescence.test.ts packages/server/src/store/review.ts packages/server/src/store/review.test.ts
git commit -m "$(cat <<'EOF'
fix: live acceptance pick skips a busy agent

hasLivePresence was treating heads-down as reachable. Drop agents whose
newest work audit is inside 120s; occupancy attestation is not work.

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
```

---

### Task 3: ADR + docs, then draft PR

**Files:**
- Create: `docs/decisions/NNN-live-acceptance-pick-skips-busy-agents.md` (NNN from `pnpm adr:next` **after** the draft PR exists)
- Modify: `docs/architecture/03-server.md` (the `review.ts` tree line)
- Modify: `docs/superpowers/specs/2026-08-12-quiet-set-acceptance-design.md` (status line only)
- Modify: `docs/design/the-standing-acceptor.md` — already points at the spec; no further edit unless the pointer is missing

**Interfaces:**
- Consumes: Task 2 behaviour (busy agents dropped, unknown kept, humans unfiltered).
- Produces: an accepted ADR whose Eval is the 10-minute hit rate on post-web-low routed submits.

- [ ] **Step 1: Push a draft PR so `adr:next` can see the number (ADR 223)**

```bash
git fetch origin main && git rebase origin/main
git push -u origin HEAD
gh pr create --draft --title "Live acceptance pick skips a busy agent" --body "$(cat <<'EOF'
## Summary
- `pickReviewCounterpart` drops live agents whose newest *work* audit is inside 120s (quiet-set increment 1).
- Occupancy attestation is excluded so a claim/attach does not look like heads-down work.
- `pickHumanReviewer` unchanged. Wake / `no_candidate` fallback unchanged.
- ADR number reserved in the next commit.

## Test plan
- [x] `pnpm --filter @musterd/server exec vitest run src/store/review.test.ts src/store/quiescence.test.ts`
- [ ] After land: 10-minute confirm rate on post-arming, non-exempt, live-routed submits (Eval in the ADR)

EOF
)"
```

- [ ] **Step 2: Reserve the number and write the ADR**

```bash
pnpm adr:next
```

Use the printed NNN. Write `docs/decisions/NNN-live-acceptance-pick-skips-busy-agents.md` **without running Prettier on it**:

```md
# NNN — Live acceptance pick skips a busy agent

- Status: accepted
- Date: 2026-08-12
- Owner: wanderer
- Relates to: ADR 188 (graded live pick), ADR 191 (wake when live pick is null), ADR 219 (quiescence already marks busy *offline* seats unspendable), ADR 253 (agents-only live pick), quiet-set spec increment 1

## Context

`pickReviewCounterpart` filters candidates with `hasLivePresence`. On revive, live usually means heads-down. Named live accepts hit the 10-minute bar 24% of the time; busy named agents eventually confirm ~80% at mean 273 minutes. ADR 219 already refuses to *wake* a busy seat. The live pick still targets them.

## Problem

Presence is not reachability. Sole-targeting a mid-turn agent plus ADR 202 (only the named seat can `accept`) is the 273-minute path.

## Decision

The live agent pick drops a candidate when `resolveQuiescence` on their newest work audit is `busy` (line = `QUIESCENCE_DEFAULT_QUIET_AFTER_MS`, 120s). `unknown` (no work audit in lookback) stays eligible. `occupancy.model_attested` is not work. `pickHumanReviewer` is not filtered. A null live pick still takes the ADR 191 wake path.

## Consequences

A team whose every live cross-model agent is mid-turn will wake an offline seat (or `no_candidate`) instead of asking the busy one. Increment 2 (eligible-set fan-out) is not implied; measure first.

## Observability & Evaluation

**Traces.** None new. The ready-row still records `reviewer` + `route` + `grade`. A wake that used to be a live pick is already visible as `wake_queued`.

**Eval.** Dataset: `lane.ready_for_review` joined to `lane.closed` on revive, **after** `stakes_defaults packages/web/**=low` was armed, non-exempt, `wake_queued` false. Metric: counterpart confirm in ≤10 minutes. Baseline: 24% (14-day live named, mixed denominator). Exclude known jumped-route closes by hand.

**Experiment.** None. Observational before/after on the live log. If the rate does not move and stalls are attention-while-quiet, do not build increment 2 from this ADR.
```

- [ ] **Step 3: Update the architecture tree line and spec status**

In `docs/architecture/03-server.md`, the `review.ts` line, after "pickReviewCounterpart is agents-only (ADR 253)", add "and drops busy agents (ADR NNN, quiescence 120s, unknown kept)".

In the spec header, change status to: `increment 1 implementing (ADR NNN); increment 2 not started`.

- [ ] **Step 4: Fast gates, mark the PR ready, auto-merge**

```bash
pnpm typecheck && pnpm format:check
git add docs/decisions/NNN-live-acceptance-pick-skips-busy-agents.md docs/architecture/03-server.md docs/superpowers/specs/2026-08-12-quiet-set-acceptance-design.md
git commit -m "$(cat <<'EOF'
docs: ADR NNN — live acceptance pick skips a busy agent

Refs ADR-NNN

Co-authored-by: wanderer <wanderer@revive.musterd>
EOF
)"
git push
gh pr ready
gh pr merge <n> --squash --auto --delete-branch
```

Replace NNN and `<n>` with the real values. Do not poll CI.

---

## Self-review (spec coverage)

| Spec increment 1 requirement | Task |
| ---------------------------- | ---- |
| Drop busy live agents (120s) | 2 |
| Keep unknown (not "no evidence" ⇒ busy) | 1 (regression) + 2 |
| Do not filter `pickHumanReviewer` | 1 (explicit test) + 2 (untouched fn) |
| Null pick → existing wake / no_candidate | 2 (http.ts untouched) |
| No eligible-set / no `ask` on `ELIGIBLE_ACTS` | all tasks omit it |
| No 10-minute self-close / ADR 235 | omitted |
| Occupancy attestation ≠ work | 1 + 2 `excludeActions` |
| Eval / ADR | 3 |

No increment 2 work in this plan.
