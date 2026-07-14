# Office Rive character — state-machine & input spec

> ## ⚠️ SUPERSEDED by [ADR 133](../decisions/133-procedural-character-skeleton.md) — 2026-07-13
>
> **The Rive rig is retired.** `character.riv`, `rig.ts`, `rive-rig.ts` and `@rive-app/canvas-advanced`
> are deleted; the office character is now a **procedural skeleton** (`office-scene/skeleton.ts` solves
> 3D joints, `office-scene/character.ts` paints them).
>
> The rig this document specifies was **flat and ungrouped** — as its own as-built notes below record, the
> states are "position-only" keyframes and "whole-cluster translations". With no joint hierarchy there was
> nothing to bend, so walkers glided and nobody ever sat down. Combined with the fact that **the MCP cannot
> export a runtime `.riv`** (see "Remaining", below), every polish pass was gated on a human opening the
> Rive editor — which is why the hair and gesture work below sat "code-side ready, `.riv` side pending"
> indefinitely. ADR 133 has the full reasoning.
>
> Kept for the archaeology. **Nothing below is live.**

Status: superseded (was: draft 2026-07-01) · Owner: web/live · Relates to: ADR 079 (live isometric
office), ADR 133 (supersedes this), Figma `b6zXGHxG9CnCa8tFgpQWx2` frame **07 Character Rig**.

> ## ✅ As-built (v1 — 2026-07-01)
>
> The rig below was **built through the Rive Editor MCP** (not by hand) into `character.riv`. A few
> Rive-native choices diverge from the original draft — the authoritative code-side contract is now
> **`packages/web/src/live/office-scene/rig.ts`** (`officeToRig(node, pose) → RigInputs`, unit-tested).
> Reconciliation vs §3/§5:
>
> - **Artboard** `Character` (180×260, feet ≈ (90, 235)). One view model **`Character`** whose
>   **instance values are the input channel** the runtime sets each frame (via the Rive runtime
>   data-binding API), exactly as the MCP set them at authoring time.
> - **Colour is real `color` properties, not a `hue` number:** `accentColor` (torso), `accentDark`
>   (arms, ~0.72× lightness), `skinColor` (head, name-seeded swatch). The code sends `#aarrggbb`
>   (`hslToArgb(memberColor(...))`). Rive's simple databind has no converter, so this is cleaner than
>   hue→HSV in-rig.
> - **`isHuman`/`carry` are not booleans in the rig** — they're **`agentVis` / `humanVis` / `carryVis`
>   numbers (0|1)** bound to shape opacity. The code translates `kind`→agent/human vis and
>   `carry`→carryVis (again, no boolean→opacity converter in databind).
> - **State machine `State`**, driven by **`mode`** (Number): `0 idle · 1 working · 2 walking · 3 away ·
4 help`, all keyframed (position-only, to avoid touching bound props). `facing`/`run` numbers exist
>   but **v1 is front-only** (facing not yet visually distinct; ship S, add E/W-mirror + N later).
> - **Critical runtime note:** data binding is **VM→object**, and VM instance values default to
>   `0`/opaque-black — so the runtime **must set the colour + vis values on load** or the character
>   renders black (learned the hard way in the editor). `rig.ts` supplies exactly those values.
>
> The narrative spec below (hue/isHuman/skinTone) remains the design intent and forward-looking target;
> §3/§5 are superseded by `rig.ts` for what the code actually drives today.
>
> ### Hair variety — code side ready (2026-07-02), `.riv` side pending
>
> **Both hair-colour and hair-style are now code-ready** — each a guarded, drop-in write in `rive-rig.ts`
> that no-ops against the current asset and lights up automatically once the `.riv` exposes the property:
>
> - **Hair colour** — `rig.ts` emits a name-seeded **`hairColor`** (`hairFor(name)`, a 6-swatch palette
>   salted so it doesn't correlate with `skinColor`); `rive-rig.ts` sets it via `setColorIfPresent(...)`.
>   `.riv` step: add a `color` property named exactly **`hairColor`** to the `Character` view model and
>   data-bind it to the `hair` shape's fill (same pattern as `skinColor`→`head · skin`).
> - **Hair style** — `rig.ts` emits a name-seeded **`hairStyle`** number in `0..HAIR_STYLE_COUNT-1`
>   (`hairStyleFor(name)`, currently **`HAIR_STYLE_COUNT = 5`**, salted independently of colour/skin);
>   `rive-rig.ts` sets it via `setNumberIfPresent(...)`. `.riv` step: author `HAIR_STYLE_COUNT` distinct
>   hair shapes soloed on a Number input named exactly **`hairStyle`** (values `0..4`). Keep the count in
>   sync with `HAIR_STYLE_COUNT` in `rig.ts` if the artist adds/removes styles.
>
> Only the two `.riv` authoring steps + a re-export to `public/office/character.riv` remain; no further
> code change is needed once the properties exist.
>
> ### Ambient gesture poses — code side ready (2026-07-03), `.riv` side scaffolded
>
> **In-place ambient gestures (stretch/glance) are code-ready** (ADR 086 Phase 2 tail). When the room is
> quiet, the office scheduler occasionally plays a stationary beat on a seated member (`actors.gestureBeat`),
> which flows through `pose.gesture` → `officeToRig` → a **guarded `setNumberIfPresent(vmi, 'gesture', …)`**
> in `rive-rig.ts` — a no-op against the current asset, lighting up automatically once the `.riv` exposes it.
> The value is `0` none · `1` stretch · `2` glance; it's included in the sprite-cache `spriteKey`, and a
> gesturing member is kept `dirty` (advancing) for the gesture window.
>
> **`.riv` fully authored via the MCP** — only a runtime **export** remains:
>
> - **Input** — a `number` property **`gesture`** on the `Character` view model.
> - **Layer** — a separate **`Gesture`** state-machine layer (overlays `Main`, so the `mode` states are
>   untouched): Any-State → **`none`** / **`stretch`** / **`glance`** on conditions `gesture == 0 / 1 / 2`,
>   entry → `none`.
> - **Animations** — `stretch` = a uniform upper-body reach-up bob (all head/torso/arm shapes rise ~8px
>   together and settle, frame 0 == frame 45 == rest so entry/exit is seamless); `glance` = a subtle
>   head-cluster sideways sway (~5px). Both authored as whole-cluster translations so nothing detaches on
>   the flat ungrouped rig. Subtle by design (a few screen px).
> - **Remaining:** export a runtime `.riv` from the editor over `packages/web/public/office/character.riv`
>   (the MCP can't export). The code then activates with no further change. Verify visually after export.

## Purpose

The live office (`packages/web/src/live/office-scene/`) currently draws each teammate with a **code-drawn
placeholder avatar** (`render.ts` → `avatar()` / `drawActor()`). This document is the contract for the
Rive character that replaces it: the exact **artboard, state machine, and inputs** the artist builds, and
the exact **signals the code will feed** each of them, so the `.riv` and the integration meet in the
middle with no surprises.

One rig, parameterised. Every member — agent or human, any signature colour — is **the same artboard**
driven by inputs. No per-member artboards.

The swap is behind one seam: `drawActor(ctx, fit, pose, node)` in `render.ts`. Everything upstream
(seating, the walk state machine in `actors.ts`, the depth-sorted `renderScene`, presence transitions)
stays exactly as built in M1–M3 and is unaffected.

---

## 1. What the code already knows (the source signals)

Per member, per frame, the scene has these in hand (no new plumbing needed for most):

| Signal        | Type                                 | Source                    | Notes                                                       |
| ------------- | ------------------------------------ | ------------------------- | ----------------------------------------------------------- |
| `name`        | string                               | roster                    | identity; seeds deterministic variety                       |
| `kind`        | `'agent' \| 'human'`                 | `OfficeNode.kind`         | drives the agent/human tell                                 |
| `activity`    | `'offline' \| 'idle' \| 'working'`   | `OfficeNode.activity`     | `working` ⇒ typing                                          |
| `presence`    | `'online' \| 'away' \| 'offline'`    | `OfficeNode.presence`     | `away` ⇒ lounging                                           |
| `color`       | `hsl(H, 68%, 62%)`                   | `memberColor(name, kind)` | **H is the identity hue** (agents 150–280°, humans 320–70°) |
| `pose.dir`    | `'S' \| 'E' \| 'N' \| 'W'`           | `Pose.dir`                | facing (S = toward viewer)                                  |
| `pose.small`  | bool                                 | `Pose.small`              | nook/strip actors render smaller                            |
| `pose.carry`  | bool                                 | `Pose.carry`              | holding a handoff box                                       |
| `pose.bubble` | `'?' \| '!' \| null`                 | `Pose.bubble`             | raised-hand / urgent cue (help hold)                        |

Two signals need a **small addition to the actor system** (see §6): whether the member is **moving**
this frame, and whether the current walk is a **run** (urgent). Both are trivial to expose from the
existing `Walk`/leg data.

`memberColor` reference (from `format.ts`): `hue = kind==='human' ? (320 + t*110)%360 : 150 + t*130`,
fixed `S=68% L=62%`. So the rig only needs the **hue**; saturation/lightness are constant.

---

## 2. Artboard & anatomy

**Artboard:** `Character`. Design at the placeholder's proportions so the swap is 1:1 — the current
avatar spans roughly, in logical px at `fit.scale = 1`:

- overall height ≈ **80** (feet at the pose origin up to the agent antenna tip)
- head ø ≈ **30**, centred ≈ 56 above the feet
- body ≈ **38 wide × 32 tall**, top ≈ 44 above the feet
- shadow: a soft ellipse ≈ **48 × 12** on the floor at the origin

**Origin / anchor:** the artboard origin is the character's **feet centre** (the point the code
projects and depth-sorts on). Everything is drawn **up** from there. This matters — the integration
places the sprite by its feet, not its centre.

**Colour regions (named for runtime tinting):**

- `accent` — shirt/torso + accent trims. Tinted to the member hue at runtime.
- `accentDark` — arms / a shade of accent (the placeholder uses ~0.7× lightness of accent).
- `skin` — head/hands. One of a small `skinTone` set (not tied to hue).
- `hair` — human hair (a `hair` set); for agents this region is hidden.
- fixed accessories keep their own colours (agent LED `#74e08a`, visor `#2e3a38`).

**Agent vs human tell** (must read at a glance, bird's-eye, ~40px tall):

- **agent** — antenna + glowing LED node above the head, a visor bar across the face (front only), a
  small chest LED. No hair.
- **human** — hair cap, simple face (two eyes, front only). No antenna/visor/LED.

Keep the silhouette blocky and flat-shaded to match the code-drawn desks/furniture (no gradients,
no outlines — the office reads as flat iso solids).

---

## 3. Inputs (the contract)

State-machine inputs the artist exposes; the code sets these every frame. **Names and ranges are
normative** — the integration will reference them literally.

| Input      | Rive type | Range / values   | Meaning                                                            |
| ---------- | --------- | ---------------- | ------------------------------------------------------------------ |
| `mode`     | Number    | `0..4` (see §4)  | primary state: idle / working / walking / away / help              |
| `facing`   | Number    | `0..3` → S,E,N,W | which way the character faces                                      |
| `run`      | Boolean   | —                | modifies `walking`: fast cadence (urgent help)                     |
| `carry`    | Boolean   | —                | overlay: holding a box at chest (valid in idle & walking)          |
| `isHuman`  | Boolean   | —                | tell: human (hair/face) vs agent (antenna/LED/visor)               |
| `hue`      | Number    | `0..360`         | tints the `accent` / `accentDark` regions (H of the member colour) |
| `skinTone` | Number    | `0..(S-1)`       | picks a skin swatch; seeded from the name (stable)                 |
| `hair`     | Number    | `0..(K-1)`       | picks a hair style/colour (human only); seeded from the name       |

Notes:

- **Colour via `hue`.** Prefer a single `hue` number that the rig maps to `accent` (H, S=68, L=62)
  and `accentDark` (H, S=68, L≈43). If the runtime you target supports data-bound colour inputs
  cleanly, a `color` input is acceptable — but `hue` keeps the `.riv` renderer-agnostic and matches
  `memberColor` exactly. State which you built.
- **`skinTone` / `hair` counts** (`S`, `K`) are the artist's call (suggest `S=4`, `K=5`). Publish the
  final counts back into this doc so the code's `hash(name) % S` matches the available swatches.
- **Facing E/W may be a mirror.** If the rig only draws S, N, E, set `facing=3` (W) = E mirrored on X;
  note it so the integration can `scaleX(-1)` instead if you'd rather not bake W.
- **`bubble` stays in code.** The `?`/`!` speech bubble is drawn by the canvas overlay (it's a semantic
  cue, not part of the body). The rig's `help` state supplies the **raised-hand pose**; the glyph floats
  above via existing code. So there is **no `bubble` input** — just make `mode=help` a clear "arm up,
  attentive" pose.

---

## 4. State machine

One state machine, `State` (blended locomotion + overlays). Primary states are selected by the `mode`
number; `run` and `carry` are modifier layers.

`mode` enum:

| `mode` | State       | Loop?               | Look                                                                                                               |
| ------ | ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `0`    | **idle**    | loop                | seated/standing at rest; slow breathing, occasional glance. The steady state for a present-but-not-working member. |
| `1`    | **working** | loop                | seated, hands typing; subtle focus. (Desk + monitor are drawn by the code; the character just types.)              |
| `2`    | **walking** | loop                | locomotion cycle across the floor. Cadence normal; `run=true` → faster, longer stride.                             |
| `3`    | **away**    | loop                | relaxed lounge pose (at the break nook); mug/idle sway optional.                                                   |
| `4`    | **help**    | loop or 1-shot→hold | standing, **arm raised**, attentive — the "I need a hand" hold. Pairs with the code-drawn `?`/`!` bubble.          |

Modifier layers (independent, blend over the base state):

- **`carry`** — a box held at chest + arms forward; valid over `idle` and `walking` (the handoff walk
  carries out, drops, walks back empty). Keep the legs/gait from the base state; just change the arms.
- **`run`** — over `walking` only; faster cycle. Ignore elsewhere.

Transitions: the code sets `mode`/`run`/`carry` directly each frame — the state machine only needs
**immediate transitions on input change** (no timed conditions, no exit-time gating). Blend times ≤
~120 ms so a walk→idle settle looks natural but stays responsive. Do **not** auto-advance between
states inside Rive; the code is the sole driver.

`facing` changes should be immediate (snap or ≤80 ms). The office has no in-between diagonal facings.

Reduced-motion: the code freezes drivers (see §6). No separate Rive "static" state needed — a paused
instance on its idle frame is the reduced-motion presentation.

---

## 5. Code → input mapping (exact)

This is the precise derivation the integration performs each frame, per member, from the signals in §1.
`H` = hue parsed from `node.color`.

```
isHuman  = node.kind === 'human'
hue      = parseHslHue(node.color)              // the H in hsl(H,68%,62%)
skinTone = hash(name) % S
hair     = hash(name) % K                       // only read by the rig when isHuman
facing   = { S:0, E:1, N:2, W:3 }[pose.dir]
carry    = pose.carry
run      = pose.run                             // NEW (see §6): true on an urgent-help leg
mode     =
    pose.away        ? 3 /* away    */          // presence 'away' / placement === nook
  : pose.bubble != null ? 4 /* help */          // the help "hold" leg (arm up + code bubble)
  : pose.moving      ? 2 /* walking */          // NEW: mid-walk travel leg
  : activity==='working' ? 1 /* working */
  :                    0 /* idle */
```

Priority order matters: **away > help > walking > working > idle**. `carry` and `run` are set
independently of `mode`.

`hash(name)` is the same FNV-ish hash already used by `seating.ts`/`memberColor` (`h = h*31 + c`), so
skin/hair are stable per person across sessions and reloads — the same guarantee seats/colours have.

`pose.small` maps to a uniform **scale** on the sprite (nook/strip actors at ~0.72×), applied by the
integration when it draws, **not** a Rive input.

---

## 6. What the code adds to drive it (small, known)

The rig needs three booleans the placeholder didn't: `moving`, `run`, and `away`. All derivable from
state the actor system already has:

- **`moving`** — the member has an active walk **and** is on a _travel_ leg (not the hold leg).
  `actors.ts` already distinguishes legs; expose it on the pose.
- **`run`** — the active walk was built `urgent` (help, urgent tier). Tag the `Walk` at build time and
  copy it onto the pose.
- **`away`** — `node.presence === 'away'` (or the placement is `nook`). Available in `index.ts` already.

Concretely: extend `Pose` (types.ts) with `moving: boolean`, `run: boolean` (and either read `away`
from the node at draw time or add it too). `posesNow()` sets them from the current leg; home poses set
them false. No change to seating, mapping, or the transition logic. This is a ~20-line change landed
**with** the Rive integration, not before.

---

## 7. Integration contract (runtime)

**Recommended runtime: `@rive-app/canvas-advanced` (WASM, manual advance).** Rationale: the office is a
**single depth-sorted canvas** (walkers must occlude / be occluded by desks — M2/M3). We therefore need
each character drawn **into our own `ctx` at a specific depth**, not as an independent auto-playing DOM
canvas. The advanced runtime lets us `advance(dt)` each artboard and draw it where/when we choose.

Per member, the integration owns a lightweight `Rig`:

- one **artboard instance** + **state-machine instance** of `Character` (all sharing one loaded `.riv`
  and one WASM runtime);
- set inputs from §5 each frame, `advance(dt)`, then composite into the scene at the member's projected
  **feet** position, scaled by `fit.scale × (pose.small ? 0.72 : 1) × dpr`, inside the existing
  depth-sorted item loop in `renderScene` (replacing the `drawActor` body). Depth key stays
  `depth(pose.lx, pose.ly)` so occlusion is unchanged.

Lifecycle & perf (must-haves):

- **Instance pooling** keyed by member name; create on first appearance, dispose on exit (after the
  walk-out completes — the same moment the ghost drops in `actors.ts`).
- **Pause when idle.** The scene already runs the RAF loop only while walks/cues are in flight and
  blits a static buffer at rest. Working/idle breathing would force the loop to run forever — so at
  rest, **bake one Rive frame into the static buffer** (advance once, draw, stop). Only run continuous
  Rive advance during active frames. (If we later want always-on breathing, it's a deliberate perf
  trade recorded then — not the default.)
- **Reduced-motion:** don't advance; draw the idle frame once. Mirrors today's behaviour.
- **DPR / resize:** re-derive draw scale from `fit.scale`; no per-instance canvas resize needed with the
  advanced renderer (we draw into the main canvas).
- **Fallback:** if the `.riv` (or WASM) fails to load, keep the current code-drawn `drawActor` — it stays
  in the tree as the graceful fallback, exactly like today's `.catch()` degrade.

Asset serving: `packages/web/public/office/character.riv`, served same-origin (ADR 062 `serveStatic`);
`.wasm` MIME already correct. Import via `public/` (no bundler change).

---

## 8. Export / handoff checklist (artist)

- [ ] Artboard **`Character`**, origin at **feet centre**, sized to the §2 proportions.
- [ ] State machine **`State`** with inputs exactly: `mode` (Number 0–4), `facing` (Number 0–3),
      `run` (Bool), `carry` (Bool), `isHuman` (Bool), `hue` (Number 0–360), `skinTone` (Number 0–S−1),
      `hair` (Number 0–K−1). Names/case verbatim.
- [ ] Five `mode` states (idle, working, walking, away, help) + `carry` and `run` modifier layers, all
      driven **only** by inputs (no internal timers/auto-advance).
- [ ] `hue` tints `accent` (H,68,62) and `accentDark` (H,68,~43); publish final `S`,`K` counts here.
- [ ] Agent vs human tell legible at ~40px; four facings (or S/N/E + documented W-mirror).
- [ ] Flat-shaded to match the code-drawn office (no gradients/outlines).
- [ ] Export a **single `.riv`** (one artboard), delivered to `public/office/character.riv`.

## 9. Open questions

1. Final `skinTone` (`S`) and `hair` (`K`) counts — pick, then update §3/§5.
2. `hue` number input vs data-bound `color` — confirm which the built `.riv` uses.
3. W facing: mirrored E, or drawn? (Affects whether the code applies `scaleX(-1)`.)
4. Working "typing" — is the character's desk/keyboard drawn by the code (as now) or included in the
   working state? Recommend **code keeps the desk**; the rig only animates the body.
