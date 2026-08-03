# Working-hours clock companion

Status: approved design (2026-08-03) · Owner: web/live

## Context

The first working-hours sign was large, screen-space typeset, and centered immediately beneath the
office clock. In the live office it overlapped the clock face and read as floating overlay text rather
than a physical object on the wall.

The Team schedule remains the only data source. This change alters presentation only: it neither changes
the working-hours protocol nor Member inheritance.

## Decision

Turn the existing below-clock wall slot into a compact clock companion.

- The clock remains at its current back-right-wall location.
- Remove the small art in the slot below the clock; the schedule owns that slot.
- Paint a small calendar card, sized to the former artwork rather than spanning the wall. It has a warm
  cream paper face, slim oak/brass frame, two binder loops, a mustard header, and a restrained brass-pin
  twinkle.
- Put every line of schedule copy through the existing wall-plane text primitive. Text is therefore
  sheared with the isometric wall, never pasted into screen space.
- Separate the clock and card by a visible gap. Their wall-space bounds must not touch.
- Respect the existing static/reduced-motion posture: the card remains complete without its tiny ambient
  twinkle.

The copy stays derived from `formatWorkingHours`: Team label, grouped weekdays plus localized hours, and
timezone. Member overrides are not displayed on the Team fixture.

## Rendering shape

`workingHoursSign` becomes a calendar-fixture renderer rather than a floating placard. Its geometry is
defined in wall-local units, then projected with the existing `wallPt` / `wallRect` helpers:

1. cast shadow, outer oak/brass frame, and inset paper face;
2. two small binder-loop details on the upper edge;
3. mustard header strip with the Team-hours label;
4. schedule and timezone copy through `wallText`;
5. one subtle, deterministic pin highlight for life.

The drawing remains within `render.ts`; this is a single visual object and does not need a new component
or dependency.

## Verification

- Extend the renderer tests to pin the clock/card wall placement and a non-overlap gap.
- Assert the schedule is emitted via the wall-plane text path rather than raw screen-space `fillText`.
- Run focused web tests, the web build, and the required repository fast gates before opening the PR.
- Inspect `/office-preview` and the daemon-served `/live?team=revive` after the web publisher picks up
  the merge.

## Non-goals

- No protocol, persistence, roster, or schedule-inheritance changes.
- No Member-specific sign or schedule enforcement.
- No new artwork, fonts, runtime dependency, or layout recut.
