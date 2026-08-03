# Cell E1 Delivery Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Skiff cookoff to 12 tickets and run the approved E1 delivery-curve experiment across solo, coordinated D, and uncoordinated C3 arms.

**Architecture:** Keep the fixture repository and its hidden scoring branch separate from the musterd design/runbook repository. Add T9–T12 to the visible fixture artifact and hidden acceptance suites, then make the scoring checkout replay each integration commit to produce attempted, currently-green, and green-without-W3 curves. Update the manifest and runbook only after the offline scorer and a no-spend smoke replay pass.

**Tech Stack:** TypeScript, framework-free Skiff HTTP router, Vitest, Git commit history, `musterd archaeology`, SQLite audit rows, Claude Code CLI, and musterd Goals/Lanes.

## Global Constraints

- Preserve T1–T8 `TASKS.md` wording and existing hidden-suite behavior byte-for-byte.
- Add exactly four second-wave tickets: T9 patron ledger view, T10 patron filter, T11 vessel filter, and T12 patron summary.
- Keep D and C3 identical in model, harness, permissions, fixture, ticket text, merge mechanic, and actor attribution; vary only the coordination medium.
- D retains the ADR 150 lane-ownership and action-to-ask enforcement policy; controls do not receive musterd gates.
- Keep predicate set v1, W1–W4 precedence, intervention codes I1–I6, token accounting, and acceptance guardrail unchanged.
- Use one ticket-tagged commit subject prefix (`T1:` through `T12:`) as the attempt marker in every arm.
- Use a 90-minute safety cap only as censoring; never convert it into an outcome threshold.
- Use a pre-launch audit watermark and the `audit` table; never score inherited probe/prior-run rows.
- Do not add a runtime dependency without an ADR; do not expose hidden acceptance suites to agent seats.
- E2 is deferred: do not run it or alter E1 based on an E2 result.

---

## File Map

### Fixture repository: `/Users/nick/cookoff-scenario`

- Modify `TASKS.md`: append the approved T9–T12 ticket text without changing T1–T8.
- Modify `SPEC.md`: define the four second-wave endpoint/filter contracts and exact response/error behavior.
- Modify `src/schema.ts`: add typed query parsing and patron-summary response shapes while preserving existing request parsing contracts.
- Modify `src/store.ts`: add canonical patron selection and filtered/summary reads without changing booking order or stored fares.
- Modify `src/router.ts`: route T9–T12 and preserve existing `/ledger`, `/ledger/summary`, and `/crossings` behavior.
- Create `acceptance/T9.test.ts` through `acceptance/T12.test.ts`: hidden tests on the scoring branch only; agents never receive these files.
- Modify `scoring.config.json`: map T9–T12 suites and update actor/config metadata without changing predicate set v1 or exclude globs.
- Modify `score.ts`: add commit-by-commit curve scoring while preserving the existing four-metric report.
- Modify `OPERATOR.md`: document curve inputs, ticket-tagged commit subjects, and the scorer invocation.

### musterd repository: `/Users/nick/agents-ryder`

- Modify `docs/design/cookoff-scenario-repo.md`: replace the eight-ticket fixture description with the approved 12-ticket description and suite count.
- Modify `docs/design/cookoff-cell-runbook.md`: add 12-ticket seeding, ticket-tagging instructions, curve capture, watermark scoring, D/C3 parity, and machine-control steps.
- Modify `docs/design/cookoff-run-manifest.md`: add the E1 arm matrix, fixed interleaving, 90-minute censoring cap, load/swap/concurrency fields, and gate-event reporting.
- Modify `docs/design/cookoff-measurement.md` only where the approved curve definitions need implementation-facing text; do not change W1–W4 predicate semantics.
- Add a sequential ADR only when implementation reveals a protocol/schema/dependency deviation; choose the number from fresh `origin/main` and update the affected docs in the same commit.

---

### Task 1: Freeze the expanded fixture contract

**Files:**
- Modify: `/Users/nick/cookoff-scenario/TASKS.md`
- Modify: `/Users/nick/cookoff-scenario/SPEC.md`
- Test: `/Users/nick/cookoff-scenario/test/baseline.test.ts`

**Interfaces:**
- Consumes: existing Skiff `Ledger`, `Crossing`, fare, and endpoint contracts.
- Produces: normative T9–T12 request/response/error text that hidden suites and implementation tasks consume.

- [ ] **Step 1: Append T9–T12 to `TASKS.md`**

Use exactly:

```text
T9 — Patron ledger view
Add GET /ledger/patron/:patronId, returning that patron's crossings in booking order. Establish one canonical patron-selection helper.

T10 — Patron ledger filter
Add ?patronId= filtering to GET /ledger, with unknown/empty query values rejected clearly.

T11 — Vessel ledger filter
Add ?vessel= filtering to GET /ledger, preserving existing ordering and response shape.

T12 — Patron ledger summary
Add GET /ledger/summary/patrons, returning { patronId, count, fareTotal } rows sorted by patron ID and summing fares already stored in the ledger without repricing.
```

- [ ] **Step 2: Specify exact endpoint behavior in `SPEC.md`**

Define:

```text
GET /ledger/patron/:patronId       -> 200 { crossings: Crossing[] }
GET /ledger?patronId=<non-empty>  -> 200 { crossings: Crossing[] }
GET /ledger?vessel=<valid-class>  -> 200 { crossings: Crossing[] }
GET /ledger/summary/patrons       -> 200 { summary: [{ patronId, count, fareTotal }] }
```

State that patron results preserve ledger insertion order, vessel filtering accepts only the three existing vessel classes, unknown/empty filter values return `400 { errors: string[] }`, and patron summaries use stored fare values and ascending patron IDs. State how combined `patronId` + `vessel` filters behave: apply both filters conjunctively while retaining the existing response shape.

- [ ] **Step 3: Run the visible baseline before implementation**

Run: `cd /Users/nick/cookoff-scenario && CI=true corepack pnpm test`

Expected: the existing baseline tests pass; no T9–T12 behavior is implemented yet.

- [ ] **Step 4: Commit the fixture contract**

```bash
cd /Users/nick/cookoff-scenario
git add TASKS.md SPEC.md
git commit -m "docs: specify Skiff second-wave ledger tickets"
```

### Task 2: Implement T9 canonical patron selection

**Files:**
- Modify: `/Users/nick/cookoff-scenario/src/store.ts`
- Modify: `/Users/nick/cookoff-scenario/src/router.ts`
- Modify: `/Users/nick/cookoff-scenario/src/schema.ts`
- Test: `/Users/nick/cookoff-scenario/acceptance/T9.test.ts`

**Interfaces:**
- Consumes: `Crossing`, `Ledger.all()`, and the T9 route contract.
- Produces: `Ledger.byPatron(patronId: string): Crossing[]` and the `/ledger/patron/:patronId` route.

- [ ] **Step 1: Write hidden T9 tests**

Cover: two patrons with interleaved bookings, booking-order preservation, an empty result, URL decoding, and no mutation of the ledger. Keep the suite on the scoring branch only.

- [ ] **Step 2: Run T9 and confirm it fails**

Run: `cd /Users/nick/cookoff-scenario && pnpm exec vitest run acceptance/T9.test.ts`

Expected: FAIL because the route and canonical selector do not exist.

- [ ] **Step 3: Implement the minimal selector and route**

Add `byPatron` as a read-only filter over insertion-ordered `all()` results. Route-decode the path parameter, return `{ crossings }`, and do not reprice or create records.

- [ ] **Step 4: Run T9 and the baseline**

Run: `cd /Users/nick/cookoff-scenario && pnpm exec vitest run acceptance/T9.test.ts && CI=true corepack pnpm test`

Expected: T9 passes and all visible baseline tests pass.

- [ ] **Step 5: Commit with the attempt marker**

```bash
git add src/store.ts src/router.ts src/schema.ts
git commit -m "T9: add patron ledger view"
```

### Task 3: Implement T10 and T11 query filters as the deliberate collision pair

**Files:**
- Modify: `/Users/nick/cookoff-scenario/src/schema.ts`
- Modify: `/Users/nick/cookoff-scenario/src/store.ts`
- Modify: `/Users/nick/cookoff-scenario/src/router.ts`
- Test: `/Users/nick/cookoff-scenario/acceptance/T10.test.ts`
- Test: `/Users/nick/cookoff-scenario/acceptance/T11.test.ts`

**Interfaces:**
- Consumes: T9's `Ledger.byPatron` selector and existing `Req`/`Res` route types.
- Produces: typed `parseLedgerQuery(raw: string | undefined): { patronId?: string; vessel?: VesselClass } | { errors: string[] }` and conjunctive ledger filtering.

- [ ] **Step 1: Write hidden T10 and T11 tests**

T10 must test patron filtering, empty/unknown patron values, and unchanged response shape. T11 must test each vessel class, invalid vessel values, ordering, and conjunction with `patronId`.

- [ ] **Step 2: Run both suites and confirm failure**

Run: `cd /Users/nick/cookoff-scenario && pnpm exec vitest run acceptance/T10.test.ts acceptance/T11.test.ts`

Expected: FAIL because `GET /ledger` ignores query strings and has no query parser.

- [ ] **Step 3: Implement the shared query parser**

Parse with `URLSearchParams`, reject unknown keys and empty values, validate `vessel` against `VESSEL_CLASSES`, and return structured errors without throwing. Keep `GET /ledger` with no query unchanged.

- [ ] **Step 4: Implement conjunctive filtering**

Apply `patronId` through T9's canonical selector, then apply the optional vessel filter while preserving insertion order. Do not alter stored crossings or the response envelope.

- [ ] **Step 5: Run both suites and the full visible baseline**

Run: `cd /Users/nick/cookoff-scenario && pnpm exec vitest run acceptance/T10.test.ts acceptance/T11.test.ts && CI=true corepack pnpm test`

Expected: both suites and baseline pass.

- [ ] **Step 6: Commit the collision pair together**

```bash
git add src/schema.ts src/store.ts src/router.ts
git commit -m "T10: filter ledger by patron and vessel"
```

### Task 4: Implement T12 patron summary

**Files:**
- Modify: `/Users/nick/cookoff-scenario/src/store.ts`
- Modify: `/Users/nick/cookoff-scenario/src/router.ts`
- Modify: `/Users/nick/cookoff-scenario/src/schema.ts`
- Test: `/Users/nick/cookoff-scenario/acceptance/T12.test.ts`

**Interfaces:**
- Consumes: `Ledger.byPatron`, stored `Crossing.fare`, and the T12 response contract.
- Produces: `Ledger.patronSummary(): Array<{ patronId: string; count: number; fareTotal: number }>` and `/ledger/summary/patrons`.

- [ ] **Step 1: Write hidden T12 tests**

Cover multiple patrons, repeated patrons, sorted patron IDs, zero-result `{ summary: [] }`, and proof that changing tariff configuration after booking does not change `fareTotal`.

- [ ] **Step 2: Run T12 and confirm failure**

Run: `cd /Users/nick/cookoff-scenario && pnpm exec vitest run acceptance/T12.test.ts`

Expected: FAIL because the summary route and selector do not exist.

- [ ] **Step 3: Implement stored-fare aggregation**

Aggregate existing ledger rows by `patronId`, count rows, sum each stored `fare`, and sort keys ascending. Return the exact `{ summary }` envelope.

- [ ] **Step 4: Run T12 and the complete visible baseline**

Run: `cd /Users/nick/cookoff-scenario && pnpm exec vitest run acceptance/T12.test.ts && CI=true corepack pnpm test`

Expected: T12 and baseline pass.

- [ ] **Step 5: Commit with the attempt marker**

```bash
git add src/store.ts src/router.ts src/schema.ts
git commit -m "T12: add patron ledger summary"
```

### Task 5: Update hidden-suite mapping and offline scorer

**Files:**
- Modify: `/Users/nick/cookoff-scenario/scoring.config.json`
- Modify: `/Users/nick/cookoff-scenario/score.ts`
- Modify: `/Users/nick/cookoff-scenario/OPERATOR.md`
- Test: `/Users/nick/cookoff-scenario/test/score.test.ts`

**Interfaces:**
- Consumes: `T1:`–`T12:` commit subjects, integration `main` history, hidden suite map, existing archaeology JSON, and Vitest JSON output.
- Produces: existing four-metric score plus a `curves` object containing attempted/current-green/green-without-W3 event series, first-green timestamps, first-all-green timestamp, final status, and regressions.

- [ ] **Step 1: Add T9–T12 suite mappings**

Extend `tickets` with `T9` → `acceptance/T9.test.ts` through `T12` → `acceptance/T12.test.ts`. Keep `predicateSet: "v1"`, kickoff SHA, exclusions, and actors unchanged except for the approved 12-ticket actor metadata needed by the run.

- [ ] **Step 2: Write scorer tests for curve extraction**

Use a temporary Git history with ticket-tagged commits, integration commits, a failing intermediate suite, a later passing suite, a regression, and one W3-classified line. Assert that attempt time is first ticket-tagged commit time, current-green follows each integration commit, regressions are retained, and green-without-W3 excludes only the affected ticket.

- [ ] **Step 3: Run scorer tests and confirm failure**

Run: `cd /Users/nick/cookoff-scenario && pnpm exec vitest run test/score.test.ts`

Expected: FAIL because the curve collector/report does not exist.

- [ ] **Step 4: Implement deterministic curve extraction**

Walk first-parent `main` integration commits from the kickoff SHA in chronological order. For each commit, materialize the delivered tree in a temporary directory, overlay hidden suites, run the per-ticket suite and visible baseline, and record the committer timestamp plus SHA. Find attempts from commit subjects matching `^(T[1-9]|T1[0-2]):`. Associate W3 line classifications with ticket-tagged commits and mark a ticket green-without-W3 only when its current suite passes and its associated W3 count is zero.

- [ ] **Step 5: Preserve the existing score shape and add curves**

Keep headline, guardrail, interventions, tokens, and warnings unchanged. Add a sibling `curves` field; do not replace acceptance pass rate with curve values or collapse curves into a scalar.

- [ ] **Step 6: Run the scorer against the reference solution**

Run: `cd /Users/nick/cookoff-scenario && node --experimental-strip-types score.ts --delivered reference-solution --json`

Expected: 12 ticket rows, all reference suites passing, the existing non-zero archaeology anchor preserved, and a populated curve object from ticket-tagged reference commits.

- [ ] **Step 7: Commit scorer and operator documentation**

```bash
git add scoring.config.json score.ts OPERATOR.md test/score.test.ts
git commit -m "feat: score Cell E1 delivery curves"
```

### Task 6: Update musterd experiment docs and runbook

**Files:**
- Modify: `/Users/nick/agents-ryder/docs/design/cookoff-scenario-repo.md`
- Modify: `/Users/nick/agents-ryder/docs/design/cookoff-cell-runbook.md`
- Modify: `/Users/nick/agents-ryder/docs/design/cookoff-run-manifest.md`
- Modify: `/Users/nick/agents-ryder/docs/design/cookoff-measurement.md` only for curve definitions

**Interfaces:**
- Consumes: the approved E1 design and validated fixture/scorer contracts.
- Produces: a runbook that an operator can execute without inventing ticket, gate, merge, machine, or scoring rules.

- [ ] **Step 1: Update the fixture description**

Document 12 tickets, T9–T12 roles, twelve hidden suites, and the unchanged Skiff trap taxonomy.

- [ ] **Step 2: Update the per-cell seed instructions**

Change every “8 tickets”/`T1..T8` reference to 12/T1..T12. Add the identical ticket-tagged commit rule, preserve the same TASKS text in D and C3, and document D’s ADR 150 gate policy separately from the controls.

- [ ] **Step 3: Add the E1 manifest matrix**

Record arms, two replicates, fixed interleaving, the 90-minute censoring cap, no-other-workload rule, and launch/completion fields for CPU load, memory pressure, swap, concurrency, versions, SHAs, timestamps, interruptions, and gate events.

- [ ] **Step 4: Add curve scoring instructions**

Document the pre-launch audit watermark, `audit` table, first-parent integration replay, attempted/current-green/green-without-W3 series, regression reporting, and the prohibition on invented deadlines or collapsed scores.

- [ ] **Step 5: Run documentation checks**

Run: `cd /Users/nick/agents-ryder && git diff --check && pnpm vocab:check && pnpm format:check`

Expected: no vocabulary, formatting, or whitespace drift.

- [ ] **Step 6: Commit docs with the implementation reference**

Before committing, compare the implementation with the approved design. If a real protocol/schema/dependency deviation occurred, choose the next free ADR number from fresh `origin/main` and update the affected docs in the same commit. If no deviation occurred, commit the doc updates without inventing an ADR.

### Task 7: Validate the apparatus without model spend

**Files:**
- Modify: `/Users/nick/cookoff-scenario/OPERATOR.md` if validation reveals a reproducible correction
- Create: `/Users/nick/cookoff-run/e-ladder/e1-apparatus-check.md`

**Interfaces:**
- Consumes: reference-solution history, scorer output, musterd daemon health, fixture kickoff SHA, and run manifest fields.
- Produces: a reproducible apparatus report; no paid seat-run.

- [ ] **Step 1: Validate reference scoring**

Run the scorer on the reference solution and assert 12/12 acceptance, a non-zero per-actor archaeology result, twelve ticket rows, and curve output.

- [ ] **Step 2: Validate clean single-branch cell setup**

Clone only fixture `main` at the pinned kickoff SHA into a fresh cell directory. Confirm no `scoring` or `abandoned` refs are present, baseline tests pass, and hidden suites are absent from agent worktrees.

- [ ] **Step 3: Validate audit watermark isolation**

Record the daemon's pre-launch maximum audit ID/timestamp, perform a harmless probe, then confirm the scorer selects only rows after the watermark.

- [ ] **Step 4: Validate D/C3 parity**

Diff the two cell manifests and confirm only the coordination surface and D's musterd gate configuration differ.

- [ ] **Step 5: Record the apparatus result and stop**

Do not launch a paid E1 arm from this task. Record every mismatch, repair it through the deviation protocol, and obtain the spend authorization required by the manifest before the first run.

## Verification Checklist

- [ ] Fixture baseline passes before implementation and after T9–T12.
- [ ] Hidden suites are inaccessible from agent worktrees.
- [ ] Reference solution scores 12/12 with the existing archaeology anchor intact.
- [ ] Curve tests cover first attempt, delayed green, regression, and W3 exclusion.
- [ ] D/C3 manifests are byte-identical except for coordination medium and D gate policy.
- [ ] Audit watermark and `audit` table handling are proven on a no-spend probe.
- [ ] Machine-load and concurrency fields are captured before any paid seat-run.
- [ ] E2 remains deferred and no E1 result is conditioned on it.
