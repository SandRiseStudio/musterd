# Office presence chrome — nameplates, work cues, whiteboard

**Date:** 2026-07-30  
**Approved by:** nick (in-session)  
**Owner:** miley  
**Surface:** `packages/web` (`/live` + `/broadcast` office panel)  
**Related:** [2026-07-24 office floor as roster](./2026-07-24-office-floor-as-roster-design.md) (desk nameplates / retire RosterPanel — **out of this pass**), [2026-07-24 broadcast overlay](./2026-07-24-broadcast-overlay-design.md) (OfficeOverlay — demoted here)

## Problem

The office panel currently shows three overlapping answers to “who’s here / what are they on”:

1. **Bottom WHO’S IN noticeboard** (`OfficeBoard`) — named roster rail under the room.
2. **OfficeOverlay reel** — cycling name + lane title card.
3. **Wall color-chip pinboard** — canvas cork with presence-colored tags + `N/M`.

Nick’s constraints: no standalone bottom rail; whatever we ship lives **in the office space panel** (in the room or the white space around it). The glance job is richer than presence alone: who’s here, harness, model, role (when set), what they’re working on, and progress.

## Decision

Split **identity** (on the person) from **work** (hybrid cue, with an in-panel stack as fallback). Replace the wall roster pinboard with **set dressing**: a white dry-erase board drawn with musterd-orange marker ink — not data.

### Jobs

| Concern | Home |
| --- | --- |
| Who’s here | Floor avatars + posture dots |
| Harness · model · role | Compact floating nameplate (present members) |
| What they’re on + progress | Hybrid always-on cue + hover; fallback to in-panel stack |
| Full roster / governance | Side ROSTER tab (unchanged) |
| Wall object | Whiteboard set dressing (no roster claim) |

### Out

- Bottom `OfficeBoard` / WHO’S IN cork rail — **delete** from `/live`.
- Wall color-chip pinboard as a roster signal — **replace** with whiteboard (below).
- OfficeOverlay reel as the primary `/live` work UI — **remove or hide** on `/live`. Broadcast may keep a passive lower-third if needed.
- Desk nameplates for offline seats, coat-peg overflow, retiring `RosterPanel` — deferred to the floor-as-roster design.
- Real % progress — not on the wire; progress = lane state.
- Implementing the role system — render `role` only when non-empty.

---

## 1 · Identity nameplates

**Who:** every **present** member (working / idle / away-but-attached). Offline seats stay unlabeled in this pass; side ROSTER covers them.

**Implementation home:** existing DOM floating labels (`.lc-gl-label` in `office-scene/index.ts`), not canvas plaques.

**Shape:**

```
● stanley
  cursor · opus 5
```

- Line 1: posture dot + name (unchanged).
- Line 2: live presence `surface · model` (ADR 101 model attestation).
- Role: only when non-empty — short third line, or suffix on line 2 if it still fits.

**Compactness:**

- UI-only short display maps for harness/model (`claude-code` → `claude`, long model ids → readable short labels). Full strings in `title` / hover.
- Truncate with ellipsis before the label grows wider than ~a desk.
- Hover/focus expands **identity only**: full surface, full model id, role, optional workspace — **not** the lane title.

**Not on the nameplate:** lane title, progress, governance chips (`admin` / `wakeable` / etc.).

**Data:** no protocol change. Read `presences[]` (surface, model) and `MemberSummary.role`.

---

## 2 · Work + progress (hybrid → fallback A)

**Audience:** present members who have something on (in-flight lane and/or status line). Idle-with-nothing stays quiet on the floor.

### Hybrid (ship first)

**Always-on cue** — under the identity block, only when there is a title:

```
● stanley
  cursor · opus 5
  lane_handoff promises…
```

- Truncate ~28–36 chars + ellipsis.
- Mark status-only lines (`said`) so they are not confused with a claimed lane.
- Progress: tiny state chip from lane state (`claimed` / `active` / `blocked` / `ready_for_review` → short labels like `active` / `blocked` / `review`). No % bar.
- Derive titles/state from existing `roomEntries` / lane board (`workingOn.ts`).

**Hover/focus (full work read):** full lane title or status body; lane state + `+N` more in-flight lanes; source (lane vs `said`); optional one-line blocked detail.

**Gate to fallback:** if always-on work lines clutter the floor at dogfood density (many simultaneous workers), stop painting the always-on work line. Identity line 2 stays. Switch to fallback A.

### Fallback A

- Compact stack in the white space under/beside the room.
- **Present & working only** — one row: name · title · progress.
- Not a full roster; not the WHO’S IN cork board.
- Avatar hover detail may remain.

### Broadcast

- Identity nameplate (name + harness · model [+ role]) on both `/live` and `/broadcast`.
- Hybrid work cue: `/live` with hover; `/broadcast` prefers always-on truncated lines (no hover), or a passive overlay lower-third if truncated lines are too dense on stream.
- Speech bubbles on acts remain ephemeral event chrome, not the standing “what are they on” surface.

---

## 3 · Wall whiteboard (set dressing)

Replace the cork color-chip pinboard painter with a **whiteboard** on the same wall slot.

| Part | Treatment |
| --- | --- |
| Board surface | **White** (slight warm/off-white OK so it sits in the room’s light — not cork beige) |
| Frame | Wood/aluminum rim consistent with other wall objects |
| Marker ink | **Musterd orange** — brand accent (`mustard-500` / `--lc-accent-bright` ≈ `#e1ad01`, or a dry-erase tint of the same hue). Diagram, shapes, and any fake label text use this ink only |
| Content | Fake architecture-diagram scribbles: boxes, arrows, cloud/cylinder glyphs, short nonsense labels — **not** live roster data, not `N/M`, not member colors |

**Rules:**

- Static set dressing baked with the still layer (roster changes must not redraw it for data).
- No claim to be a presence index. No interactive hit target required for v1.
- Keep the portrait/tall geometry constraint already documented for this wall (iso shear); composition is shapes and short strokes that read at `/live` fitted scale (~0.5×).

---

## 4 · Removals and keep list

**Delete / demote**

- `OfficeBoard` + `.lc-notice*` band under the room on `/live`.
- Color-chip pinboard roster painter → whiteboard painter.
- `OfficeOverlay` as primary `/live` work UI (remove/hide; broadcast optional).

**Keep**

- Side ROSTER + STREAM tabs.
- Ask banner / top chrome.
- Floor avatars + posture dots.
- Act speech bubbles.

---

## 5 · Success check

- Glance: who’s in the room without a bottom rail.
- Present people show harness · model without opening ROSTER.
- Working people show a truncated “on what” + state; hover gives the full read.
- Wall reads as a cool white dry-erase board with orange marker diagrams — never as a roster.
- If the floor feels crowded, flip to fallback A without redesigning identity.

## 6 · Perf

`packages/web` perf contract applies. Prefer extending DOM labels over per-frame canvas text. Whiteboard belongs on the baked still layer. No new runtime dependencies. Measure if label DOM or hover chrome moves byte budgets.

## 7 · Implementation sketch (not a plan)

1. Short-label helpers + nameplate identity line(s) + hover identity expand.
2. Hybrid work cue + hover work card; feature flag or easy kill-switch for fallback A.
3. Swap wall pinboard painter → whiteboard; delete `OfficeBoard` wiring.
4. Demote/remove `OfficeOverlay` on `/live`; confirm `/broadcast` orientation.
5. Visual pass on `/office-preview` + `/live`; decide hybrid vs A by eye at dogfood density.
