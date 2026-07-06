# Design

> Visual system for the musterd web surface. Derives from `docs/design/brand.md` +
> `packages/web/src/styles/tokens.css` (mustard accent, Inter + JetBrains Mono) and extends them into
> one language across every page (`/`, `/live`, `/approvals`, `/audit`). Reference feel: a **warm
> isometric office at dusk** — a co-work floor you look down into, where agents and humans share desks,
> a lounge, and huddle spaces. Rendered as a living Canvas2D/Rive scene; the rest of the app is the
> same building's other rooms. (Supersedes the prior "dusk observatory / three.js constellation" system.)

> **Status (2026-07-06):** the two-theme token layer is in place (`tokens.css`), but **dark is still the
> active default** — light is opt-in via `:root[data-theme="light"]` until the office scene and landing
> hero are light-mode-ready. Light becomes the default at that point. Light token values below are
> provisional pending a contrast pass.

## Theme

An **inhabited warm interior**, not a cold cosmos. The constellation said _vast, autonomous, alone_;
the office says _warm, together, at work_ — which is the product (team, not swarm). A twilight sky sits
behind the floor; the floor itself is warm terracotta wood under a soft day-cycle wash. Light = presence,
warmth = recency. The scene is ambient and alive (people walk, hand off, gather); the surrounding chrome
is a calm warm console so dense rows stay legible.

**Two themes, light by default.** The default is a **warm daylight office** — cream walls, a sun-warmed
terracotta floor, ink text. **Dark** (the dusk values below) is the opt-in theme. Both are first-class
and every surface must read in each; the scene re-tunes its floor, walls, sky, and day-cycle wash per
theme. Components and the canvas read only semantic tokens (`--floor`, `--wall`, `--ink`, `--sky`),
never raw hex, so a theme swap is a token swap.

## Color

Restrained and warm. One accent (mustard) for "alive / now / attention"; identity color-coding
(jade agent / rose human) carried on **every** page; semantic colors for act meaning only. Neutrals
are warm-tinted toward amber/stone — that is what keeps it off the cool-Linear default. All values
below live in `tokens.css`; nothing hardcoded in components or the canvas.

| Role      | Token                    | Light (default)                                | Dark (opt-in)                                  | Use                                  |
| --------- | ------------------------ | ---------------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| sky       | `--sky`                  | `linear-gradient(#e9d9c3 → #f3e7d4 → #ffe9c8)` | `linear-gradient(#2a2044 → #392842 → #432a1f)` | scene backdrop, hero                 |
| ground    | `--ground`               | `#f7efe2`                                      | `#1d1622`                                      | page / consoles                      |
| floor     | `--floor` / `--floor-2`  | `#f0c188` / `#dca35f`                          | `#e4a96b` / `#c6863f`                          | isometric floor                      |
| wall/wood | `--wall` / `--wood`      | `#fbf3e6` / `#9a6a42`                          | `#2a2030` / `#7a4e2d`                          | walls, desks, shelves                |
| couch     | `--couch`                | `#e8b23d`                                      | `#e3a72b`                                      | lounge furniture                     |
| surface   | `--surface`              | `#fffaf1` / `#f3e9da`                          | `#2a2030` / `#362a3d`                          | rows, cards, raised                  |
| border    | `--hairline`             | `rgba(60,40,20,.10–.16)`                       | `rgba(255,233,208,.10–.18)`                    | dividers, outlines                   |
| text      | `--ink`                  | `#2a2118`                                      | `#f8efe1`                                      | body                                 |
| muted     | `--muted`                | `#7a6a56`                                      | `#ab9684`                                      | timestamps, captions (≥4.5:1 both)   |
| accent    | `--mustard-500` / `-300` | `#b8860b` / `#e1ad01`                          | `#e1ad01` / `#f4cf52`                          | now, request_help, focus, primary    |
| success   |                          | `#2f9e6a`                                      | `#5cd49a`                                      | accept, resolve                      |
| danger    |                          | `#d1503f`                                      | `#f3776a`                                      | decline                              |
| info      |                          | `#5b7fa6`                                      | `#88a9cf`                                      | wait (the one cool note)             |
| agent     | `--agent-jade`           | `#1a9e88`                                      | `#2ad6bb`                                      | agent avatars/desks — **every page** |
| human     | `--human-rose`           | `#d9557d`                                      | `#ff86a8`                                      | human avatars/desks — warmest tone   |

Act → tone: request_help=accent, accept/resolve=success, decline=danger, wait=info, rest=neutral.
Semantic/identity hues shift value between themes (darker on light for contrast) but keep the same hue
so jade=agent / rose=human reads identically in both. Light values are provisional — tune for ≥4.5:1.

## Typography

Two-family pairing on a contrast axis (mono "wire" vs humanist body):

- **JetBrains Mono** — the _wire_: timestamps, handles, act labels, wordmark, captions, counts.
- **Inter** — what's _said_: message bodies, headings, buttons.
- Fixed rem scale: 11 / 12 / 13 / 14 / 15px; headings 15–22px. No clamp.

## Motion

- **Chrome + stream (product discipline):** 140–240ms, ease-out-expo (`cubic-bezier(.16,1,.3,1)`).
  Row arrival, hover, focus, panel crossfade. No bounce/elastic.
- **The office scene (ambient — the exception):** a living Canvas2D/Rive floor. People sit, occasionally
  stretch/glance (ambient gestures); a `request_help` walks someone over (runs when urgent); a `handoff`
  carries a labeled box between desks; a `megaphone` broadcasts; coffee steam, monitor glow, and a slow
  day-cycle wash keep the room breathing. Falls back to a code-drawn frame if Rive/WASM fails.
- **Signature beat:** a `resolve` settles its thread — the actor brightens once and cools to green,
  synchronized between the scene and the stream.
- `prefers-reduced-motion`: all ambient motion off; the room renders one still populated frame;
  arrivals become instant; typewriter shows full text. Fully legible and calm.
- **Theme switch:** crossfades tokens (no relayout); the scene re-reads computed styles and re-tunes floor/
  sky/wash. No animation on the switch itself beyond the fade.

## Layout

- **Scene as hero + as panel:** the landing (`/`) mounts the office as an ambient living diorama behind
  the headline; `/live` mounts the same scene as the left panel beside the stream. One scene, two frames.
- **Rooms of one building:** `/approvals` (the desk) and `/audit` (the records room) don't render the
  isometric canvas — they wear its language (warm surfaces, wood/mustard accents, jade/rose identity,
  isometric-flavored empty states) so navigation feels like moving through a floor, not switching apps.
- Spacing (4-based): 2/4/6/8/12/16/20/24/32px. Radii: 6px (badges) · 8–10px (rows) · 14–16px (cards); never >16.
- Responsive is structural: below ~880px the scene collapses (stream-first); it's a wide-screen surface
  by intent. On mobile / `save-data`, the hero diorama degrades to a static populated frame.

## Components

`message-row` (timestamp · member-chip · act-badge · recipient · body), `act-badge` (per-act tone),
`member-chip` (avatar initial + name, jade/rose), the `office-scene` (Canvas2D/Rive floor + projected
label overlay), `now` divider, connect card, and — new — the shared **wayfinding shell** (Floor ·
Approvals Desk · Records Room). Every control ships default / hover / focus-visible / active / disabled /
loading. Empty + connecting + error states are first-class and stay in the office voice
("nobody's at the approval desk right now").
