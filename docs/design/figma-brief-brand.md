# Figma Brief 1 — "musterd / Brand"

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

**Audience:** a Figma-capable agent (Figma MCP + `/figma-generate-library`, `/figma-use` skills) executing this file alone. Everything needed to build the file without judgment calls is here. The source of truth for all values is [`brand.md`](./brand.md) — if a number is missing here, take it from there; if they conflict, `brand.md` wins.

---

> **Status: EXECUTED** (2026-06-10, see [ADR 008](../decisions/008-ui-ux-figma-execution.md)). File: [musterd / Brand](https://figma.com/design/ogOcNXhGq5THf9OBQgbYQB). Exports in [`assets/`](./assets/). Note: the ASCII block wordmark is mirrored *from* the CLI banner (`packages/cli/src/render/rows.ts`), which is the source of truth — not generated in Figma and copied back.

## File

- **Figma file name:** `musterd / Brand`
- **Pages (in order):** `Wordmark`, `Color`, `Type`, `Assets`

## Variables / tokens to define FIRST (before any frame)

Create a variable collection `musterd/core` with these modes: `light`, `dark`.

**Color variables** (hex from `brand.md` §2):
- `accent` → `#E1AD01` (both modes; dark may alias `mustard-300 #EFC94C` for text-on-dark)
- full `mustard/{50,100,300,500,700,900}` and `zinc/{50,100,200,400,500,700,800,900,950}` ramps as raw color variables
- semantic aliases: `success`, `warning`, `danger`, `info`, `muted` bound per-mode to the §2 semantic table

**Type variables / text styles** (from `brand.md` §3): create text styles `display`, `h1`, `h2`, `h3`, `body`, `small`, `mono-body`, `mono-sm` with exact size/line-height/weight/family.

## Page: Wordmark

Frames:
1. `wordmark/primary` (640×200) — lowercase `musterd` in JetBrains Mono, weight 700, letter-spacing 0, color `zinc-900` on `zinc-50`. The `-d` (final letter) filled `accent`.
2. `wordmark/reversed` (640×200) — same, `zinc-50` on `zinc-900`, `-d` in `mustard-300`.
3. `wordmark/mono` (640×200) — single color, all `zinc-900` (and a dark variant) — no accent, for stamping/embroidery-style use.
4. `wordmark/ascii-block` (640×240) — the frozen ASCII block banner rendered as text in mono; this exact glyph string is the canonical CLI banner and **must** be copied verbatim into `packages/cli` as a string constant. Produce the block art here and paste the literal characters into a code block in the acceptance notes so the CLI agent can copy it.

## Page: Color

- `color/accent-ramp` frame: swatches for the full mustard ramp, each labeled `token` + `hex`.
- `color/neutral-ramp` frame: full zinc ramp, labeled.
- `color/semantic` frame: success/warning/danger/info/accent/muted shown in both light and dark, with the ANSI mapping name annotated (per `brand.md` §2 ANSI table) so the terminal brief and CLI stay aligned.
- `color/contrast` frame: show accent-on-zinc-900 and zinc-900-on-zinc-50 with WCAG AA pass/fail annotations.

## Page: Type

- `type/scale` frame: every text style from the ramp, rendered with its token name + specs.
- `type/mono-grid` frame: JetBrains Mono at `14/22` over an 80-column grid guide (this is the shared reference the Terminal brief builds on).
- `type/pairing` frame: Inter heading + JetBrains Mono code block sample, showing the doc/web pairing.

## Page: Assets (export targets)

Build these frames at **exact** dimensions and mark each for export:

1. `asset/readme-header` — **1280×320**. Dark (`zinc-900` bg), centered wordmark + tagline (`brand.md` canonical tagline) in `mono-body` `zinc-400`. Export `@1x` and `@2x` PNG.
2. `asset/social-card` — **1200×630**. Dark bg, wordmark upper-left, one-liner centered, subtle 80-col grid texture at low opacity. Export PNG `@1x` and `@2x`.
3. `asset/avatar` — **512×512**. The `-d` motif or compact `musterd` lockup centered on `zinc-900`, accent `-d`. Export PNG at 512 and 256 and SVG. Used for npm + GitHub org avatar.
4. `asset/badge` — **120×20** shields-style mustard badge reading `musterd` (for README). Export SVG.

## Acceptance checklist ("done" means all true)

- [ ] Variable collection `musterd/core` exists with `light`+`dark` modes and every color + text token from `brand.md`.
- [ ] All four wordmark frames exist; `wordmark/ascii-block` includes the literal block string pasted as copyable text.
- [ ] Color page shows full mustard + zinc ramps and the semantic+ANSI mapping.
- [ ] Type page shows the full scale and the 80-col mono grid.
- [ ] All four asset frames exist at the exact dimensions listed.
- [ ] Exports produced: readme-header (PNG @1x/@2x), social-card (PNG @1x/@2x), avatar (PNG 512+256, SVG), badge (SVG).
- [ ] No color outside the `brand.md` ramps appears anywhere in the file.

## Iteration protocol

1. Build, then post screenshots of each page (Wordmark, Color, Type, Assets) for review.
2. Revisions are requested only against **named frames** (e.g. "tighten `asset/social-card` tagline leading"). Never "make it pop".
3. Re-post only the changed frames after each revision.
4. When the checklist is fully green, post the export bundle and mark this brief done.
