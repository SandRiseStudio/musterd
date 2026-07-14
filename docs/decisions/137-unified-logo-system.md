# 137 — Unified logo system: Chip + Tile marks

- Status: accepted
- Date: 2026-07-13

## Context

musterd branding had drifted across surfaces: the CLI ships ADR 114's roll-call nameplate (presence dots +
mustard **brand chip** + cursor), the web `/live` chrome used an anonymous glowing dot, the landing hero used
plain text + `_` cursor, the README still showed the retired figlet, Figma `musterd / Brand` froze the old
ascii-block, and Cursor MCP showed a generic black **M** (first-letter fallback — not our mark). `brand.md`
§6 required an ADR before expanding the identity beyond the wordmark.

The live isometric office (ADR 079, daylight retheme ADR 097) establishes the product's felt aesthetic: warm
paper, sandy wood floor, mustard monitor glow, toy-scale 2:1 isometric diorama. The logo should read as an
object _in that world_ — a nameplate tile on the floor — not a SaaS favicon pasted on top.

## Problem

Ship one letterform-derived mark family that works from 16×16 (favicon, MCP, topbar) through 512×512 (GitHub/npm)
and ties the CLI chip, web chrome, and office scene together — without breaking `brand.md`'s single-accent
discipline or the CLI's 16-color constraints.

## Decision

Expand §1 with two compact marks derived from the existing **brand chip** (ADR 114), plus surface rules:

1. **Brand Chip** (`mark/chip`) — flat rounded mustard block (`#E1AD01`), zinc-900 (`#18181B`) reversed-out
   lowercase **`m`**, tiny **`▊`** cursor notch at bottom-right. Top-down view of the CLI chip. Used for:
   favicon, MCP `serverInfo.icons`, `/live` topbar, npm/GitHub avatar, any compact chrome.

2. **Nameplate Tile** (`mark/tile`) — the same chip projected at the office scene's 2:1 isometric angle
   (`iso.ts` constants), with optional `--glow-mustard-soft` bloom on web/marketing surfaces only (ADR 037).
   Used for: social cards, og:image, hero watermark.

3. **Wordmark** — unchanged: lowercase JetBrains Mono, accent `-d` on the final letter.

4. **Roll-call Lockup** — unchanged: CLI nameplate (dots + chip + cursor + tagline); `renderBanner` remains
   source of truth for terminal frames.

**Surface mapping**

| Surface | Mark |
| ------- | ---- |
| CLI banner | Roll-call lockup |
| Web `/live` topbar, board, audit, approvals | Chip + wordmark |
| Landing hero | Wordmark + optional Tile watermark |
| Favicon / PWA | Chip SVG |
| MCP adapter | Chip in `icons` (`image/svg+xml`, `sizes: ['any']`) |
| README header | Chip + wordmark (retire figlet) |
| GitHub / npm avatar | Chip PNG export at 512 |

Canonical SVG sources live in `docs/design/assets/` (`chip.svg`, `tile.svg`, `wordmark.svg`). Web imports
from `packages/web/src/brand/` (same shapes); MCP embeds the chip as a data URI in `packages/mcp/src/brand.ts`.

## Consequences

- `brand.md` §1 gains the Chip + Tile definitions; §6 reversibility note still governs product chrome — no
  gradients or 3-D on the Chip itself (Tile may use soft glow only on web/marketing).
- Figma `musterd / Brand` should gain `mark/chip` and `mark/tile` frames on next sync; `wordmark/ascii-block`
  stays superseded by the roll-call lockup (ADR 114).
- Cursor may not render MCP icons yet (known client gap); shipping `icons` anyway prepares MCP Inspector and
  future Cursor UI support.
- README figlet removed — replaced by chip + wordmark per this ADR.

## Observability & Evaluation

n/a — static brand assets and presentation chrome; no protocol, span, or agent-behavior change.
