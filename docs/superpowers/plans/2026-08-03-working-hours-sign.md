# Working-hours Sign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional recurring Team/Member working-hours schedules with Member-over-Team inheritance and render the Team schedule as a data-driven magical office sign.

**Architecture:** `@musterd/protocol` owns the validated `WorkingHoursSchema`. SQLite stores nullable JSON schedule values on `teams` and `members`; durable roster files remain the source of truth for file-backed Teams. The roster endpoint returns the Team schedule plus each Member's effective schedule, and `OfficeScene` paints the Team sign from that projection.

**Tech Stack:** TypeScript, Zod, SQLite via better-sqlite3, TOML seat files, React, Canvas2D, Vitest.

## Global Constraints

- Working hours are optional and informational; schedule enforcement and automatic Presence changes remain out of scope.
- A Member schedule replaces the Team schedule wholesale; no field-level merge.
- Use `America/Los_Angeles` for revive's Pacific schedule; do not guess a local timezone.
- Validate all external schedule input through shared Zod schemas.
- No new runtime dependency, font, or backdrop-filter; reuse existing canvas font and palette tokens.
- The office render loop must remain suspended when the panel is hidden and reduced-motion must draw a static sign.
- Write tests first and observe the expected failure before production implementation.

---

### Task 1: Protocol working-hours contract

**Files:**
- Create: `packages/protocol/src/working-hours.ts`
- Modify: `packages/protocol/src/member.ts`
- Modify: `packages/protocol/src/seatfile.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/working-hours.test.ts`
- Test: `packages/protocol/src/seatfile.test.ts`

**Interfaces:**
- Produces `WorkingDaySchema`, `WorkingHoursSchema`, `type WorkingDay`, and `type WorkingHours`.
- `MemberSchema` gains optional `working_hours`.
- `TeamFileSchema` and `SeatFileSchema` gain optional `working_hours` using the shared schema; serializers emit deterministic TOML.

- [ ] **Step 1: Write failing schema tests** for the valid revive schedule, all weekday keys, empty/duplicate days, invalid `HH:mm`, end-before-start, and invalid IANA timezone values.
- [ ] **Step 2: Run `pnpm --filter @musterd/protocol exec vitest run src/working-hours.test.ts`** and confirm failure because the schema/module is absent.
- [ ] **Step 3: Implement the shared schema** with canonical weekday validation, strict 24-hour times, IANA timezone validation using `Intl.DateTimeFormat`, and optional protocol/file fields.
- [ ] **Step 4: Add TOML round-trip tests** proving Team and seat schedules serialize and parse without drift, then run the focused protocol tests.
- [ ] **Step 5: Run `pnpm --filter @musterd/protocol test`** and confirm the protocol package remains green.

### Task 2: Persist Team and Member schedules

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrations.ts`
- Modify: `packages/server/src/store/rows.ts`
- Modify: `packages/server/src/store/teams.ts`
- Modify: `packages/server/src/store/members.ts`
- Test: `packages/server/src/db/db.test.ts`
- Test: `packages/server/src/store/working-hours.test.ts`

**Interfaces:**
- `TeamRow.working_hours` and `MemberRow.working_hours` are nullable JSON strings.
- `createTeam` accepts an optional parsed `workingHours` value.
- `addMember` and the existing member update path accept an optional `workingHours` value.
- Store helpers parse malformed JSON defensively and return `null`.

- [ ] **Step 1: Add failing migration/store tests** asserting latest-schema columns exist, Team schedules persist, Member schedules persist, and a Member override wins over the Team schedule while an absent override inherits.
- [ ] **Step 2: Run the focused server tests** and confirm failure on missing columns/helpers.
- [ ] **Step 3: Add the forward migration** for nullable `teams.working_hours` and `members.working_hours`, keeping the v1 schema text unchanged and referencing ADR 204.
- [ ] **Step 4: Implement row types, JSON parse/write helpers, and create/update plumbing** with shared `WorkingHoursSchema` validation at the boundary.
- [ ] **Step 5: Run `pnpm --filter @musterd/server exec vitest run src/db/db.test.ts src/store/working-hours.test.ts`** and confirm green.

### Task 3: Durable roster and effective roster projection

**Files:**
- Modify: `packages/server/src/projection/load.ts`
- Modify: `packages/server/src/projection/reconcile.ts`
- Modify: `packages/server/src/projection/serialize.ts`
- Modify: `packages/server/src/transport/http.ts`
- Modify: `packages/web/src/live/client.ts`
- Modify: `packages/web/src/live/useLiveStream.ts`
- Test: `packages/server/src/projection/reconcile.test.ts`
- Test: `packages/server/src/transport/integration.test.ts`
- Test: `packages/web/src/live/client.test.ts`

**Interfaces:**
- Durable `team.toml` schedule maps to `teams.working_hours`; durable `seats/<name>.toml` schedule maps to `members.working_hours`.
- `GET /teams/:slug` returns `team.working_hours` and Member summaries with effective `working_hours`.
- Web live state carries `teamWorkingHours: WorkingHours | null` alongside the roster.

- [ ] **Step 1: Write failing reconcile and HTTP tests** for TOML preservation, Team schedule response, and Member override/inheritance in the public roster.
- [ ] **Step 2: Run the focused server/web tests** and confirm failure because schedule fields are absent.
- [ ] **Step 3: Update reconcile/load/serialize** to preserve optional schedules as the file-backed source of truth.
- [ ] **Step 4: Add effective schedule resolution**: `member.working_hours ?? team.working_hours`, while returning the Team default separately.
- [ ] **Step 5: Parse the HTTP response through a small client schema/type boundary** and update `useLiveStream` backfill/refetch state.
- [ ] **Step 6: Run the focused server integration and web client tests** and confirm green.

### Task 4: Render the working-hours sign

**Files:**
- Modify: `packages/web/src/live/OfficeScene.tsx`
- Modify: `packages/web/src/live/office-scene/types.ts`
- Modify: `packages/web/src/live/office-scene/layout.ts`
- Modify: `packages/web/src/live/office-scene/render.ts`
- Modify: `packages/web/src/live/office-scene/index.ts`
- Modify: `packages/web/src/routes/live.tsx`
- Modify: `packages/web/src/routes/office-preview.tsx`
- Test: `packages/web/src/live/office-scene/workingHours.test.ts`
- Test: `packages/web/src/live/office-scene/layout.test.ts`

**Interfaces:**
- `OfficeData.teamWorkingHours?: WorkingHours | null` is the only data input for the sign.
- A pure formatter returns weekday label, 12-hour time range, and timezone display label.
- `renderScene` receives the optional schedule and paints nothing when absent.

- [ ] **Step 1: Write failing formatter/layout tests** for Monday–Friday output (`MON–FRI`, `11:00 AM–3:00 PM`, `PACIFIC TIME`), split-day labels, and no-schedule omission.
- [ ] **Step 2: Run the focused web tests** and confirm failure because the formatter/sign does not exist.
- [ ] **Step 3: Implement the pure formatter** with `Intl.DateTimeFormat` timezone labels and no hardcoded Team text or hours.
- [ ] **Step 4: Add the canvas sign painter** using existing palette/font tokens, a pale-oak frame, mustard marker, weekday dots, small stars, and a bounded glow driven by the existing scene clock.
- [ ] **Step 5: Add the sign anchor to layout and pass Team schedule through live and preview data**; use an explicit preview fixture rather than a production fallback.
- [ ] **Step 6: Ensure reduced-motion skips the glow animation and existing suspension still prevents rAF work when collapsed.**
- [ ] **Step 7: Run focused office-scene tests and visually verify `/office-preview` at normal and narrow sizes.**

### Task 5: Seed revive and finish verification

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (v30 initial `revive` Team schedule seed)
- Modify: `docs/architecture/01-data-model.md`
- Modify: `docs/architecture/08-web.md`
- Modify: `SPEC.md`
- Test: existing server/protocol/web suites

- [ ] **Step 1: Add a failing fixture assertion** that Team `revive` resolves the approved Monday–Friday Pacific schedule.
- [ ] **Step 2: Seed the schedule in the canonical durable Team representation** and update the authoritative architecture/spec docs to reference ADR 204 without duplicating implementation details.
- [ ] **Step 3: Run `pnpm --filter @musterd/protocol test`, `pnpm --filter @musterd/server test`, and `pnpm exec vitest run packages/web/src/live/`.**
- [ ] **Step 4: Run `pnpm -r build`, `pnpm -r lint`, and `pnpm test`; inspect the CSS/perf budget and confirm no new dependency or font was added.
- [ ] **Step 5: Run `git diff --check` and report any environment limitation separately from code failures.

## Self-review checklist

- Protocol, persistence, durable files, inheritance, public projection, formatter, painter, and revive seed each have a dedicated task.
- No task relies on a placeholder name or unspecified helper; every cross-task interface is named.
- The Team sign reads only `teamWorkingHours`; Member overrides are never rendered as Team copy.
- The plan explicitly preserves schedule storage without enforcement and covers reduced motion, hidden-panel suspension, responsive layout, and malformed persisted JSON.
