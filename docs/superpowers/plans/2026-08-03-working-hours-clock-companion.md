# Working-hours Clock Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the oversized working-hours placard with a compact, wall-plane calendar fixture beneath the office clock.

**Architecture:** Keep the existing `WorkingHours` projection and `formatWorkingHours` copy unchanged. Define the calendar fixture's shared wall-local geometry in `layout.ts`, then have `render.ts` paint its shadow, oak/brass frame, cream paper, binder loops, mustard header, wall-plane copy, and a reduced-motion-safe pin highlight at that location. The former under-clock cairn print is removed from `ART` so the slot has one occupant.

**Tech Stack:** TypeScript, React, Canvas2D, Vitest.

## Global Constraints

- This is presentation only: do not change the working-hours protocol, persistence, Team/Member inheritance, or API projection.
- The Team schedule remains the only data source; Member overrides are never rendered on this fixture.
- Place every schedule string with the existing `wallText` primitive; no raw screen-space schedule `fillText` calls.
- Keep the clock at the existing back-right-wall location and leave a visible gap between its and the card's wall-space bounds.
- Remove the small under-clock artwork, keep all other layout unchanged, and add no dependency, font, or new artwork.
- Paint a warm cream paper face, slim oak/brass frame, two binder loops, mustard header, and restrained deterministic brass-pin twinkle.
- The fixture is complete with static/reduced motion; the existing hidden-panel suspension behavior must remain unchanged.
- Follow TDD: every production rendering change begins with a focused failing test and its expected failure.

---

### Task 1: Calendar fixture geometry and renderer

**Files:**
- Modify: `packages/web/src/live/office-scene/layout.ts`
- Modify: `packages/web/src/live/office-scene/layout.test.ts`
- Modify: `packages/web/src/live/office-scene/render.ts`
- Modify: `packages/web/src/live/office-scene/render.test.ts`

**Interfaces:**
- Produces `WORKING_HOURS_CALENDAR`, exported from `layout.ts`, with the right-wall index and wall-local `{ tc, uc, w, h }` geometry.
- `drawWalls` reads that geometry when calling `workingHoursSign`; schedule copy still comes solely from `formatWorkingHours(schedule)`.
- Existing `wallText` remains the only schedule-text path.

- [ ] **Step 1: Add failing geometry tests** in `layout.test.ts` which import `WORKING_HOURS_CALENDAR`, assert it is on wall `1`, stays inside the wall, has a non-overlapping positive gap beneath the clock (`tc: 0.52`, radius `27.5 / FLOOR`, `uc: 0.62`), and that no `ART` item occupies the fixture bounds.

- [ ] **Step 2: Run the focused layout test and confirm the expected missing-export failure.** Run `pnpm exec vitest run packages/web/src/live/office-scene/layout.test.ts`; it must fail because `WORKING_HOURS_CALENDAR` does not exist.

- [ ] **Step 3: Add a failing renderer test** in `render.test.ts` which renders a Team schedule and records canvas calls. It must assert that `TEAM WORKING HOURS`, the formatted weekday/time line, and the timezone line are produced only after the wall-plane transform path; it must also assert a reduced-motion/static render is deterministic for the same clock value.

- [ ] **Step 4: Run the focused renderer test and confirm it fails because the current sign uses screen-space schedule text.** Run `pnpm exec vitest run packages/web/src/live/office-scene/render.test.ts`; it must fail on the schedule-copy transform assertion.

- [ ] **Step 5: Implement the minimal geometry and renderer.** Replace the former right-wall `cairn` artwork below the clock with `WORKING_HOURS_CALENDAR` in `layout.ts`; set its bounds within the old artwork-scale slot and clear of the clock. In `workingHoursSign`, derive `left`, `right`, `bottom`, and `top` from that geometry and paint, in order: cast shadow; slim oak/brass outer frame; inset cream paper; two binder loops; mustard header; schedule copy with `wallText`; and a small brass pin whose alpha is deterministic from `t`. Use existing palette/font helpers only, preserve `formatWorkingHours` as the copy source, and render no fixture when it returns `null`. Make the pin's static/reduced-motion value independent of animation.

- [ ] **Step 6: Run focused tests and confirm they pass.** Run `pnpm exec vitest run packages/web/src/live/office-scene/layout.test.ts packages/web/src/live/office-scene/render.test.ts` and expect PASS.

- [ ] **Step 7: Inspect the preview and commit the completed task.** Run `pnpm --filter @musterd/web build`, inspect `/office-preview` at normal and narrow viewport widths, and confirm the card is a separate readable fixture under the clock. Commit only the four implementation/test files with message `fix(web): render working-hours calendar companion`.

## Self-review checklist

- The schedule remains Team-only presentation data, with no protocol or persistence change.
- The clock and card have a tested wall-space gap, and the removed art no longer occupies the card's slot.
- Every fixture string uses `wallText` and is therefore sheared to the wall plane.
- The card has all five specified material details and stays complete when motion is reduced.
- Focused tests and the web build pass, with no new dependency or font.
