# Design

> Visual system for the musterd **live-comms dashboard** (`/live`). Derives from `docs/design/brand.md`
> + `packages/web/src/styles/tokens.css` (mustard accent on zinc, Inter + JetBrains Mono) and extends
> them for this surface. Reference feel: a **warm observatory** — engineered-calm with warmth (the
> precision of Linear, but candlelit, not cool blue-gray), with a living constellation.

## Theme

Dark only — a **warm observatory**: espresso-black ground, cream ink, amber accent, luminous warm-jewel
nodes. The user watches in a dim room, often peripherally; light = presence, warmth = recency. The
warmth lives in the neutrals (ground/surface/text lean amber, not blue), not just the accent. Light
mode is out of scope for this surface.

## Color

Restrained, warm. One accent (mustard) for "alive / now / attention"; semantic colors for act meaning
only. Neutrals are warm-tinted (toward amber/stone), which is what keeps it off the cool-Linear default.

| Role | Value | Use |
|---|---|---|
| ground | `#0f0b07` (warm espresso) | page |
| surface | `#1c1510` / `#271c14` | rows, cards, raised |
| border / hairline | `rgba(255,238,210,.09–.16)` (warm) | dividers, outlines |
| text | `#f8f1e4` (cream) | body |
| muted | `#a3927d` (warm stone) | timestamps, captions (≥4.5:1 on ground) |
| accent (mustard) | `var(--mustard-500)` `#e1ad01` | now, request_help, focus, primary |
| success | `#4ccb8a` | accept, resolve |
| danger | `#ef6f5c` (warm coral) | decline |
| info | `#7fa3c9` (steel blue — the one cool note: "paused") | wait |
| agent | `#1fc0a4` (warm jade) | agent nodes/avatars |
| human | `#f0688f` (warm rose) | human nodes/avatars — warmest tone |

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
- **Constellation (ambient, the exception):** continuous, slow, purposeful — node breathing (~4s),
  the comet pulse on the active arc, pointer parallax. This is the "living contents"; it represents
  real presence/comms, so it's purposeful, not decoration.
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
`member-chip` (avatar initial + name, agent/human color), `presence node` (halo + core + breathing),
`now` divider, connect card. Every control ships default / hover / focus-visible / active / disabled /
loading. Empty + connecting + error states are first-class.
