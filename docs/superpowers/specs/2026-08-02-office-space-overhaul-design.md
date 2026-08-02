# Office Space overhaul — design

**Date:** 2026-08-02 · **Owner:** miley · **Status:** approved by nick (brainstorm session, visual companion)

Five changes to the `/live` office scene, decided together in one design pass: a 20-desk floor plan,
compact enamel-pin nameplates, a washi-taped cork pin board, a smaller unpin-and-float board overlay,
and the reception/nook/meeting downsizing that pays for the desks. Every visual decision below was
picked from rendered mockups (`.superpowers/brainstorm/*/content/`), not described in the abstract.

## Why

- The roster is heading past 12 seats; the room supports exactly 12 desks and already feels tight.
- The reception desk (2026-07-30) landed ~5 logical units from pod 2's rug — furniture nearly
  touching, no room for the characters to breathe.
- The wall "agile board" still reads as a whiteboard (marker tray, eraser, slab face) and sits ~6
  units off a window.
- Clicking it opens `BoardOverlay` at ~92% of the frame, which reads as navigation to a separate
  page — nick reported it *as* navigation. The size is the bug.
- Nameplates are the office's densest DOM; at 20 members today's collapsed width will collide.
- The huddle (three poufs + low table, room centre) never earned its floor space.

## 1 · Floor plan — 20 desks, mixed species

**Chosen: "mixed studio" (plan B) with mixed facing (option C).** Not a pod grid.

Desk inventory (20):

| Cluster | Seats | Notes |
| --- | --- | --- |
| Quad pod (top-left) | 4 | existing pod machinery |
| Quad pod (centre) | 4 | existing pod machinery |
| Duo pod (mid-left) | 2 | pod machinery, size-parameterised |
| Duo pod (upper-centre) | 2 | pod machinery, size-parameterised |
| Front duo | 2 | pod machinery |
| **Back-wall bench** | 4 | **new species** — long shared counter |
| **Window desks** | 2 | **new species** — standalone desk |

Facing (decides the room's legibility):

- **Bench sitters face the wall** — backs to the room, monitors against the wall. Heads-down focus
  work, the honest hot-desk read.
- **Window desks face the room** — the two loners are fully visible, like earned corner offices.
- Pods keep the existing rule: exactly one cluster oriented so a pair of faces points at the camera.

Removed / downsized to pay for it:

- **Huddle: removed entirely** (`HUDDLES`, `HUDDLE_POUFS`, `HUDDLE_TABLE`, its rug and leisure spots).
- **Break nook: keeps the kitchenette run** (fridge · counter/machine/sink · cooler — the ADR 086
  errands anchor to them) **and the couch; drops both armchairs; rug shrinks** (~192 → ~110 radius).
  `NOOK_SPOTS` re-placed on the smaller rug.
- **Meeting: shorter table, 4 chairs, smaller rug**, tucked into the front-right corner.
- **Reception: smaller front desk** (roughly hall-table proportions again, deliberately — it is no
  longer trying to match workstation scale) + receptionist, and a **waiting nook of two chairs and
  an end table**. Check-in marks stay on the walk path, `CHECK_IN_S` unchanged. Clear bare-floor
  band between the reception rug and the nearest cluster rug — rugs never touch.

Engineering notes:

- Bench + window desk each need: a painter variant in `render.ts`, a nav footprint in `nav.ts`
  (solid rects matching what is drawn), seat/monitor/keyboard anchors compatible with
  `skeleton.ts`'s `DESK_REACH`, and inclusion in `DESK_SLOTS`-equivalent seat assignment.
- Wall space audit before placing the bench: windows, printer, bookshelves and the pin board all
  hold back-wall claims; `layout.test.ts` collision guards extend to the new pieces.
- All existing invariants keep holding: no rug overlap, every seat walkable (`nav.test.ts`), no
  stand point on furniture, `MIN_SPOT_GAP` between neighbouring seat/stand points.
- Exact coordinates are implementation work, iterated against the tests and the rendered room —
  the mockups fix the *arrangement*, not the numbers.

## 2 · Nameplates — compact, enamel-pin treatment

**Chosen anatomy (nick's spec):**

- Collapsed: `status dot · name · provider icon` — icon on the RIGHT of the name. No chevron (the
  whole plate is the click target; it already was).
- Expanded: `status dot · name │ provider icon · model │ harness │ role` — a divider appears after
  the name, the icon moves right of that divider, then model, divider, harness, divider, role.
- The leading status dot STAYS (chosen over carrying status on the icon ring): status remains at
  the left edge where scanning starts.
- All data survives: nothing shown today is dropped. Broadcast variant keeps icon + short model,
  no toggle, as now.

**Chosen treatment: enamel pin** (over letterpress and lantern-glass):

- The provider icon becomes a domed enamel badge: colour-filled, radial-gradient dome, specular
  highlight across its top half (a `::after` cap), seated into the plate with a shadow under it.
- The status dot gets the same glossy bead (white ring + inner highlight + slight self-glow).
- Plate stock keeps the warm paper language (`--lc-paper*`), with a soft top sheen and the
  two-part drop/seat shadow already in `Live.css`.
- Metrics tighten: padding ~8→5, icon 14→11px, rules/gaps roughly halved. Target ≥30% narrower
  collapsed — at 20 members, collapsed width is what decides plate collisions.
- Expansion animates width/opacity only. No blur/backdrop-filter anywhere (broadcast capture
  constraint). AA contrast on the paper stock re-checked for any ink that moves.

Files: `office-scene/index.ts` (`syncLabels` DOM order), `Live.css` (plate block ~939–1175),
`presenceLabel.ts` untouched (`plateDetailParts` already yields model/harness/role in order).

## 3 · Wall board — washi-taped cork, thin pale-oak frame

**Chosen: frameless-cork-with-washi-tape treatment, plus a THIN pale-oak frame** (nick: "I like the
pale oak but make the frame thin").

- Face: warm cork speckle (seeded dot texture, canvas-painted — no image assets).
- Frame: pale oak, LIGHTER than the cork — a bright edge catching the window light so the cork
  reads as the dark field and the notes stay the loudest thing. Thin profile: ~3 logical units of
  frame, a 1-unit lit top edge, and a soft inner shadow where cork meets frame.
- Notes: same six columns, tones (`WALLBOARD_TONES`), sticky order, seeded jitter and "+N"
  overflow badge as today — but each note is held by a small tinted **washi-tape tab** at its top
  edge (tape colour = column cap colour at ~75% alpha, with a lighter sheen line), replacing the
  darker header strip. Notes keep their seeded skew; add a soft drop shadow onto the cork.
- **Marker tray, pens and eraser: deleted** (`whiteboardTray` and its call site removed).
- **Position: slides right.** `WALL_BOARD.tc` 0.87 → so the board's left edge sits ~22 logical
  units off the window's right edge (today ~6), keeping a similar clearance to the wall's end.
  `layout.test.ts` wall-collision guards verify the new slot.
- Hover (on `/live`): the existing `.lc-boardspot` hotspot gains a visible affordance — the board
  lifts ~1.5 units, brightens, and picks up a warm glow. Canvas side stays static; the lift is on
  the DOM hotspot layer so the rAF loop doesn't repaint for hover.

## 4 · Board overlay — smaller, unpin & float

**Chosen: "unpin & float" at 62%** (over a 48% calm glide and a hinged swing-down).

- **Size: ~62% of the viewport** (clamped: min usable board width, max a comfortable reading width
  ~1100px), centred. The office stays visible on all sides — that alone kills the "separate page"
  read. Today's `BoardOverlay` opens at ~92%.
- **Open:** the panel flies from the wall board's rect (`boardAnchor` already hands it over),
  scaling up while tilting ~-4°, with a slight overshoot (~1.03 scale, +0.6°) before settling
  square. One transform+opacity animation, ~620ms, custom cubic-bezier with mild bounce. The scrim
  is a warm radial dim (browner near the board's corner), not neutral black.
- **Close:** the same motion reversed, back into the wall. Scrim click, Escape and re-click all
  close (existing `shouldDismiss` / `ESCAPE_SCOPES` machinery).
- **Material:** the overlay chrome picks up the same thin pale-oak frame + cork language as the
  wall object, so the glance and the close-up are the same board. The `Board` component inside is
  unchanged.
- `prefers-reduced-motion`: plain cross-fade at final size, no travel, no tilt.
- Existing a11y stays: focus trap, `inert` page, zoom-from-origin transform math
  (`boardOverlayMath.ts` — the origin-rect zoom generalises; the tilt/overshoot layers on top).

## 5 · Constraints (all sections)

- **No blur / backdrop-filter anywhere** — paints on the 1920×1080 broadcast capture; a
  backdrop-filter is a per-frame GPU readback forever.
- Animations on transform + opacity only; the office rAF loop still suspends when hidden.
- No new dependencies; no new fonts; canvas painters read type via `canvasFont.ts` tokens.
- `pnpm perf:check` budgets hold — this is CSS + canvas-paint + layout-data work; nothing here
  justifies a raise.
- Tests: `layout.test.ts` / `nav.test.ts` extended for the new furniture; `boardOverlayMath` tests
  extended for the size clamp; vitest from repo root.

## Error handling

Nothing here adds I/O or new failure modes. The board overlay keeps its existing behaviours: lane
data absent → empty columns with caps (wall) / empty board (overlay); `onBoardClick` without a rect
falls back to a centre-origin open.

## Out of scope

- Any `Board.tsx` internals (ryder's ADR 169 territory; we only re-chrome its container).
- Roster/team semantics of >12 members (seat assignment beyond desks — overflow strip and nook
  caps already handle spill; bumping caps is a follow-up if wanted).
- The `/board` standalone page.
- Broadcast-specific tuning beyond "nothing regresses".

## Sequencing (implementation plan will detail)

1. Wall board re-skin + slide + tray deletion (self-contained paint).
2. Overlay resize + choreography (DOM/CSS, no canvas).
3. Nameplates (DOM/CSS).
4. Floor plan (layout data + two new painters + nav + tests) — the big one, last, likely its own
   PR series: downsize/remove first, then new species, then desk count.
