# Design

> Visual system for the musterd **live-comms dashboard** (`/live`). Derives from `docs/design/brand.md`
> + `packages/web/src/styles/tokens.css` (mustard accent on zinc, Inter + JetBrains Mono) and extends
> them for this surface. Reference feel: a **warm dusk observatory** — a twilight sky melting to an
> amber horizon, cream ink, mustard accent, with a living **three.js** constellation (real WebGL glow).

## Theme

A warm **dusk / dawn** mid-tone — not near-black. The app background is a twilight gradient: violet up
top, warm mauve mid, an amber horizon at the base. The left **constellation** is a three.js scene over
that sky (glowing 3D nodes, curved arcs, a comet on the active arc, a warm dust field); the right
**stream** is a calm warm console (solid mid-dark surface) so dense rows stay legible. Light = presence,
warmth = recency; the warmth lives in the neutrals + the sky, not just the accent. Light mode out of
scope.

## Color

Restrained, warm. One accent (mustard) for "alive / now / attention"; semantic colors for act meaning
only. Neutrals are warm-tinted (toward amber/stone), which is what keeps it off the cool-Linear default.

| Role | Value | Use |
|---|---|---|
| sky | `linear-gradient(#2a2044 → #392842 → #432a1f)` | app bg (twilight→amber dusk) |
| ground | `#1d1622` (warm dusk, mid-tone) | stream console, solid areas |
| surface | `#2a2030` / `#362a3d` | rows, cards, raised |
| border / hairline | `rgba(255,233,208,.10–.18)` (warm) | dividers, outlines |
| text | `#f8efe1` (cream) | body |
| muted | `#ab9684` (warm stone) | timestamps, captions (≥4.5:1) |
| accent (mustard) | `var(--mustard-500)` `#e1ad01` / bright `#f4cf52` | now, request_help, focus, primary |
| success | `#5cd49a` | accept, resolve |
| danger | `#f3776a` (warm coral) | decline |
| info | `#88a9cf` (steel blue — the one cool note: "paused") | wait |
| agent | `#2ad6bb` (warm jade) | agent nodes/avatars |
| human | `#ff86a8` (warm rose) | human nodes/avatars — warmest tone |

Act → tone: request_help=accent, accept/resolve=success, decline=danger, wait=info, rest=neutral.

## Typography

Deliberate two-family pairing on a contrast axis (mono "wire" vs humanist body):

- **JetBrains Mono** — the *wire*: timestamps, member handles, act labels, the wordmark, captions,
  counts. Precise, CLI-native.
- **Inter** — what's *said*: message bodies, headings, button labels. Warm, human.
- Fixed rem scale (product, not fluid): 11 / 12 / 13 / 14 / 15px steps; headings 15–22px. No clamp.

## Motion

- **Chrome + stream (product discipline):** 140–240ms, ease-out-expo (`cubic-bezier(.16,1,.3,1)`).
  Conveys state: row arrival, hover, focus, connect↔canvas crossfade. No bounce/elastic.
- **Constellation (three.js, ambient — the exception):** a real WebGL scene — additive-glow 3D nodes
  that breathe, mustard working-rings on active members, curved arcs (TubeGeometry), a comet on the
  active arc, a drifting warm dust field, and pointer parallax (the node group rotates). Raycast hover
  lifts a node (glow blooms, core scales) and recedes the rest. Glow is sprite-based (no post-processing,
  for reliability); member names + working labels are a projected HTML overlay so text stays crisp.
- **Signature beat:** a `resolve` settles its thread — brightens once, cools to green — synchronized
  across constellation and stream.
- `prefers-reduced-motion`: all continuous/ambient motion off; arrivals become instant; typewriter
  shows full text. The view stays calm and fully legible.

## Layout

- Split-canvas: Constellation (left, ~38–42%) + Stream (right). Hairline divider. Minimal top bar
  (wordmark · team · live count).
- Spacing scale (4-based): 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32px via tokens.
- Radii: 6px (badges/inputs) · 8–10px (rows) · 14–16px (cards). Never >16px on a card.
- Responsive is structural: below ~880px the constellation collapses (stream-first); it's a wide-screen
  / second-monitor surface by intent.

## Components

`message-row` (timestamp · member-chip · act-badge · recipient · body), `act-badge` (per-act tone),
`member-chip` (avatar initial + name, agent/human color), the WebGL `constellation` (three.js scene +
projected label overlay), `now` divider, connect card. Every control ships default / hover /
focus-visible / active / disabled / loading. Empty + connecting + error states are first-class.
