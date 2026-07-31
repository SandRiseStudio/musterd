# Graded Review Ladder + Two-Review Risky Lanes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Per this machine's
> CLAUDE.md, no subagent dispatch — the lane owner implements inline.)

**Goal:** Reviews route on a graded model spectrum (cross_family > cross_model, never same_model),
every close records the grade it achieved, and risky lanes require peer review then human review.

**Architecture:** One new pure helper in `@musterd/protocol` (`reviewGrade` + model-ID
normalization); `pickReviewCounterpart` becomes a ladder returning the achieved grade; the
`lane.ready_for_review` and `lane.closed` audit rows carry the grade; a risky lane's human ask is
composed when the peer's accept lands (route-time hook), not at ready time.

**Tech Stack:** TypeScript, zod, better-sqlite3, vitest. Spec:
`docs/superpowers/specs/2026-07-31-graded-review-ladder-design.md`. ADR 188 (verify number free at
PR time).

## Global Constraints

- Never a wedge: every existing transition stays legal; degradations are recorded, not blocked.
- Unknown model ⇒ ineligible for routing and ungraded at close (ADR 158: say nothing over false).
- `verified` keeps its exact current meaning (closer ≠ owner). The grade rides beside it.
- Risky-lane human requirement (ADR 172) is unchanged in *strength* — only sequenced after peer.
- Gates: `pnpm build` before `pnpm typecheck` (phantom .d.ts errors otherwise); `pnpm lint` after
  build; run vitest from repo root only.
- Branch `ryder/graded-review-ladder` (spec already committed on it). Tasks 1–4 = PR A;
  Task 5 = PR B; ADR lands in PR A.

---

### Task 1: `reviewGrade` + model-ID normalization (protocol)

**Files:**
- Modify: `packages/protocol/src/model.ts` (beside `modelFamily`, ~line 57)
- Test: `packages/protocol/src/model.test.ts`

**Interfaces:**
- Consumes: `modelFamily(model)`, `MODEL_UNKNOWN` (existing).
- Produces: `type ReviewGrade = 'cross_family' | 'cross_model' | 'same_model'`;
  `normalizeModelId(model: string | null | undefined): string` (returns `MODEL_UNKNOWN` for
  empty/unknown); `reviewGrade(workerModel, reviewerModel): ReviewGrade | null` (null when either
  side is unknown); `REVIEW_GRADES` const tuple for zod enums downstream.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/protocol/src/model.test.ts (new describe)
describe('reviewGrade (ADR 188) — the diversity spectrum', () => {
  it('normalizeModelId strips a trailing date stamp and nothing else', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol'); // no date — untouched
    expect(normalizeModelId('  Claude-Opus-5 ')).toBe('claude-opus-5');
    expect(normalizeModelId('')).toBe(MODEL_UNKNOWN);
    expect(normalizeModelId(null)).toBe(MODEL_UNKNOWN);
  });

  it('grades the spectrum: family beats model beats identity', () => {
    expect(reviewGrade('claude-opus-5', 'gpt-5.6-sol')).toBe('cross_family');
    expect(reviewGrade('claude-opus-5', 'claude-opus-4-8')).toBe('cross_model');
    expect(reviewGrade('claude-opus-5', 'claude-fable-5')).toBe('cross_model');
    expect(reviewGrade('claude-opus-5', 'claude-opus-5')).toBe('same_model');
  });

  it('a date-stamped ID is the same model, not a different one', () => {
    expect(reviewGrade('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe('same_model');
  });

  it('unknown on either side grades nothing — null, never a guess', () => {
    expect(reviewGrade('claude-opus-5', null)).toBeNull();
    expect(reviewGrade(undefined, 'claude-opus-5')).toBeNull();
    expect(reviewGrade('unknown', 'claude-opus-5')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/protocol/src/model.test.ts`
  Expected: FAIL, `normalizeModelId is not defined`.

- [ ] **Step 3: Implement in model.ts**

```ts
/** The review-diversity spectrum (ADR 188): how decorrelated the reviewer is from the worker. */
export const REVIEW_GRADES = ['cross_family', 'cross_model', 'same_model'] as const;
export type ReviewGrade = (typeof REVIEW_GRADES)[number];

/**
 * Canonical model identity (ADR 188): trimmed, lowercased, with one trailing date stamp removed —
 * `claude-haiku-4-5-20251001` is the same MODEL as `claude-haiku-4-5`, just pinned. No other
 * inference: two IDs that differ after this are different models, full stop.
 */
export function normalizeModelId(model: string | null | undefined): string {
  if (!model) return MODEL_UNKNOWN;
  const normalized = model.normalize('NFC').trim().toLowerCase();
  if (normalized === '' || normalized === MODEL_UNKNOWN) return MODEL_UNKNOWN;
  return normalized.replace(/-\d{8}$/, '');
}

/**
 * Grade a worker/reviewer pairing, or null when either side cannot prove what it runs — an
 * ungradeable pairing is ineligible for routing and ungraded at close (ADR 158 posture).
 * Decorrelation is a spectrum: cross_family (claude→gpt) is the ideal, cross_model
 * (opus-5→opus-4.8) is accepted, same_model proves nothing and is never routed.
 */
export function reviewGrade(
  workerModel: string | null | undefined,
  reviewerModel: string | null | undefined,
): ReviewGrade | null {
  const worker = normalizeModelId(workerModel);
  const reviewer = normalizeModelId(reviewerModel);
  if (worker === MODEL_UNKNOWN || reviewer === MODEL_UNKNOWN) return null;
  if (modelFamily(worker) !== modelFamily(reviewer)) return 'cross_family';
  return worker === reviewer ? 'same_model' : 'cross_model';
}
```

- [ ] **Step 4: Run to verify pass**, then `pnpm -C packages/protocol build` (downstream tasks
  import from dist).
- [ ] **Step 5: Commit** — `feat(protocol): reviewGrade + model-ID normalization (ADR 188)`

---

### Task 2: The picker ladder

**Files:**
- Modify: `packages/server/src/store/review.ts` (`ReviewPick`, `pickReviewCounterpart`; add
  `latestAttestedModel`-based `memberModel`)
- Test: `packages/server/src/store/review.test.ts`

**Interfaces:**
- Consumes: `reviewGrade`, `ReviewGrade` from `@musterd/protocol` (Task 1);
  existing `latestAttestedModel` (private), `hasLivePresence`, `listMembers`.
- Produces: `ReviewPick` gains `grade: ReviewGrade | 'human'` — `'human'` for the risk route and
  for a human counterpart (cross-family by construction, but named honestly);
  `pickReviewCounterpart` signature unchanged otherwise. Ladder: risky → live human only
  (unchanged). Non-risky → live human first (`grade: 'human'`), else best grade among live agents:
  every `cross_family` candidate beats every `cross_model` one; `same_model`/null never picked.

- [ ] **Step 1: Failing tests** (extend existing describe; `agent()` helper attaches with a model)

```ts
describe('pickReviewCounterpart — graded ladder (ADR 188)', () => {
  it('cross_model is now routable: opus-5 worker, opus-4.8 reviewer', () => {
    const { db, team } = seed();
    agent(db, team, 'worker', 'claude-opus-5');
    agent(db, team, 'dolly', 'claude-opus-4-8');
    const lane = { risk: [] } as unknown as Lane;
    const pick = pickReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT)!;
    expect(pick).toMatchObject({ reviewer: 'dolly', grade: 'cross_model' });
  });

  it('cross_family beats cross_model when both are live', () => {
    const { db, team } = seed();
    agent(db, team, 'worker', 'claude-opus-5');
    agent(db, team, 'dolly', 'claude-opus-4-8');
    agent(db, team, 'gptbot', 'gpt-5.6-sol');
    const lane = { risk: [] } as unknown as Lane;
    const pick = pickReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT)!;
    expect(pick).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
  });

  it('same_model is never routed — two opus-5 seats still find no candidate', () => {
    const { db, team } = seed();
    agent(db, team, 'worker', 'claude-opus-5');
    agent(db, team, 'twin', 'claude-opus-5');
    const lane = { risk: [] } as unknown as Lane;
    expect(pickReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT)).toBeNull();
  });

  it('an unattested live seat stays ineligible (null grade ≠ a grade)', () => {
    const { db, team } = seed();
    agent(db, team, 'worker', 'claude-opus-5');
    agent(db, team, 'mist'); // live, no model
    const lane = { risk: [] } as unknown as Lane;
    expect(pickReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`grade` missing / cross_model currently unroutable).
- [ ] **Step 3: Implement.** In `ReviewPick` add `grade: ReviewGrade | 'human'`. Risk branch:
  returned pick gains `grade: 'human'`. Non-risky branch replaces the family-difference loop:

```ts
  const workerModel = (() => {
    const w = listMembers(db, teamId).find((x) => x.name === worker);
    return w ? latestAttestedModel(db, w.id) : null;
  })();
  // Humans first (cross-family by construction), then best grade. Sort is stable, so among equal
  // grades the roster order stands — no new tie-break policy is being invented here.
  const graded = candidates
    .map((m) => ({
      m,
      grade:
        m.kind === 'human'
          ? ('human' as const)
          : reviewGrade(workerModel, latestAttestedModel(db, m.id)),
    }))
    .filter((c) => c.grade === 'human' || c.grade === 'cross_family' || c.grade === 'cross_model')
    .sort(
      (a, b) =>
        ['human', 'cross_family', 'cross_model'].indexOf(a.grade as string) -
        ['human', 'cross_family', 'cross_model'].indexOf(b.grade as string),
    );
  const best = graded[0];
  if (!best) return null;
  return {
    reviewer: best.m.name,
    route: 'cross_family', // wire-compat: route keeps its two values; grade carries the new truth
    grade: best.grade,
    reviewer_family: memberFamily(db, best.m),
  };
```

  Keep `route: 'cross_family' | 'human_admin'` untouched (existing consumers switch on it);
  the grade is the new, finer field.

- [ ] **Step 4: Run review.test.ts — all pass, including the pre-existing ADR 172 cases.**
- [ ] **Step 5: Commit** — `feat(review): picker routes on the graded ladder (ADR 188)`

---

### Task 3: Grade on the ready row

**Files:**
- Modify: `packages/server/src/transport/http.ts` (ready edge, ~line 2432 detail block, and the
  `lane_review` ask meta + `review` response object)
- Test: `packages/server/src/transport/integration.test.ts` (existing ready-edge cases)

**Interfaces:**
- Consumes: `pick.grade` (Task 2).
- Produces: `lane.ready_for_review` detail gains `review_grade: pick.grade` when routed; the ask's
  `meta.lane_review` gains `grade`; the verb response's `review` object gains `grade`. No change
  to the no-candidate / posture shapes.

- [ ] **Step 1: Failing test** — in the integration ready-edge test, attach the reviewer with
  `claude-opus-4-8` against a `claude-opus-5` worker and assert
  `r.detail.review_grade === 'cross_model'` on the audit row and `grade` in the ask meta.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — in the detail spread:
  `...(pick ? { reviewer: pick.reviewer, route: pick.route, review_grade: pick.grade } : { no_candidate: true })`,
  add `grade: pick.grade` inside `lane_review`, and `grade: pick.grade` in the `review` response.
- [ ] **Step 4: Run integration.test.ts — pass.**
- [ ] **Step 5: Commit** — `feat(http): ready row + review ask carry the achieved grade (ADR 188)`

---

### Task 4: Grade at the close edge + ADR 188

**Files:**
- Modify: `packages/server/src/transport/http.ts` (close edge, the `lane.closed` detail, ~2570)
- Create: `docs/decisions/188-graded-review-ladder.md`
- Test: `packages/server/src/transport/integration.test.ts`

**Interfaces:**
- Consumes: `reviewGrade` (Task 1); existing `workerFamily`; needs seat models at close — add
  `export function memberModelByName(db, teamId, name): string | null` to review.ts (wraps
  `listMembers` find + `latestAttestedModel`; presence-only, deliberately — ADR 187's split).
- Produces: on every verified close, `lane.closed.detail.review_grade: ReviewGrade | null`
  (null when either model is unattested at close — recorded as absent, and
  `review_grade_unknown: true` written so absence stays countable, ADR 173).

- [ ] **Step 1: Failing test** — counterpart-confirm case: worker attests `claude-opus-5`,
  closer attests `claude-opus-4-8` ⇒ close row has `verified: true, review_grade: 'cross_model'`;
  same-model twin ⇒ `review_grade: 'same_model'`; closer unattested ⇒ no `review_grade`,
  `review_grade_unknown: true`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** in the close-edge detail, beside `reviewer_family`:

```ts
  ...(verified
    ? (() => {
        const g = reviewGrade(
          memberModelByName(ctx.db, team.id, ownerAtClose!),
          memberModelByName(ctx.db, team.id, member.name),
        );
        return g ? { review_grade: g } : { review_grade_unknown: true };
      })()
    : {}),
```

- [ ] **Step 4: Run integration.test.ts + full suite — pass.**
- [ ] **Step 5: Write ADR 188** — Context = the 17-row table (12 no_candidate / 4 mislabeled
  timeouts / 1 same-family confirm, catch rate 0/17, dolly-was-live binding-constraint finding);
  Decisions 1–4 from the spec verbatim; What-does-not-change; Observability & Evaluation answering
  Traces (graded ready/close rows, baseline table stays queryable) / Eval (direct assertion, no
  dataset — mechanical) / Experiment (pre-registered: no_candidate rate 16/17 collapses with any
  second model live; grade-vs-catch-rate analysis deferred to a later ADR 056 pass). Run
  `pnpm obs-evals:check`, `pnpm adr-numbers:check`, prettier the doc.
- [ ] **Step 6: Commit** — `feat(review): close edge derives review_grade + ADR 188` — then PR A:
  gates (build, typecheck, lint, vitest, coverage, format:check, vocab, obs-evals), push,
  `gh pr create`, `gh pr merge --squash --auto --delete-branch`.

---

### Task 5: Two-review risky lanes — peer first, human gated (PR B)

**Files:**
- Modify: `packages/server/src/transport/http.ts` (ready edge risky branch),
  `packages/server/src/protocol/route.ts` (accept-detection hook)
- Test: `packages/server/src/transport/integration.test.ts` (through-DB, per ADR 103 practice)

**Interfaces:**
- Consumes: Tasks 1–3 shapes (`lane_review` ask meta with `grade`), existing ask machinery
  (`deliverLaneAskAct`), `reviewRouting` (audit.ts:363) for the close edge.
- Produces: risky ready edge routes the PEER ask first (ladder, tier `standard`), recording
  `human_required: true, human_ask: 'gated'` on the ready row. When an `accept` lands whose
  `meta.in_reply_to` resolves to a message carrying `meta.lane_review` for a lane that is still
  `ready_for_review` and risky, the daemon composes the HUMAN ask (tier `blocking`, body carries
  the peer's accept text) to a live human, and audits `lane.review_peer_confirmed
  { lane, peer, grade, human_ask_fired: boolean }`. Close edge extends detail with
  `peer_review: ReviewGrade | 'none'` and keeps `human_review_missed` exactly as derived today.

- [ ] **Step 1: Failing integration test** — risky lane, live opus-4.8 peer + live human `nick`:
  ready ⇒ ask goes to the PEER (not the human, asserting the inversion of today's behavior);
  peer sends `accept` reply ⇒ a `blocking` ask to `nick` appears with the peer's text in the body
  and a `lane.review_peer_confirmed` audit row; nick confirms via `lane_resolve` ⇒ close row has
  `verified: true, peer_review: 'cross_model'`, no `human_review_missed`.
- [ ] **Step 2: Second failing test, the degradations** — (a) no peer candidate: human ask fires
  immediately at ready (the requirement that exists is not gated behind a stage that cannot
  happen); (b) peer confirmed but no human live: `lane.review_peer_confirmed` records
  `human_ask_fired: false`, and an owner self-close records `human_review_missed` +
  `peer_review: 'cross_model'`.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement.** Ready edge risky branch: pick via ladder among agents (humans
  excluded from stage one — they are stage two); ask tier `standard`; detail records
  `human_required: true, review_grade, human_ask: 'gated'`; no peer candidate ⇒ today's human-first
  ask fires unchanged with `human_ask: 'immediate'`. In route.ts, after the model-stamp block:
  an `accept` whose replied-to message carries `meta.lane_review` looks up the lane; if risky and
  still `ready_for_review`, compose the human ask (live human found ⇒ `deliverLaneAskAct` with
  tier `blocking`, body = peer's accept body truncated to 500 chars) and audit
  `lane.review_peer_confirmed`. Close edge: read the newest `lane.review_peer_confirmed` row for
  the lane ⇒ `peer_review: <its grade>`, else `'none'` (only written when the lane is risky).
- [ ] **Step 5: Full suite + gates, commit** —
  `feat(review): risky lanes take two reviews — peer first, human gated (ADR 188)` — PR B, same
  merge loop. Update lane + status_update; `team_memory_save` at wrap-up.

## Self-review

Spec coverage: Decision 1 → Task 1; Decision 2 → Tasks 2–3 (prediction lands in ADR, Task 4);
Decision 3 → Task 5; Decision 4 → Task 4. Type consistency: `grade: ReviewGrade | 'human'` on
ReviewPick; audit fields `review_grade` (ready + close), `peer_review`, `human_ask`,
`lane.review_peer_confirmed` — each named identically in the task that writes and the task that
reads it. No placeholders remain.
