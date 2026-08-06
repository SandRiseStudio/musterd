# Measuring colour contrast on the web surfaces

`pnpm a11y:contrast [url] [--probe cls,cls,…] [--json out.json]`

Runs [`scripts/a11y/contrast-sweep.mjs`](../../scripts/a11y/contrast-sweep.mjs) against a rendered
page and reports every text node whose contrast against its **actually painted** background falls
under WCAG 2.1 AA. Exits non-zero on a live failure, so it can be wired into a gate.

```bash
pnpm --filter @musterd/web build && (cd packages/web && npx vite preview --port 4311 &)
pnpm a11y:contrast "http://127.0.0.1:4311/live?team=<team>"
```

## Why a script, rather than eyeballing hex values

The eslint config already says what it cannot check — "colour contrast, visible focus states,
tap-target size, and whether the keyboard path through a flow actually makes sense". Contrast is the
half that looks easy and is not, because **the hex in the CSS is not what lands on screen**: alpha
tints, `color-mix()`, nested translucent layers and gradients all change it.

So it has to be measured in the page. Both natural ways of doing that are quietly wrong, and both
produced confident wrong numbers before this script existed:

1. **Parsing `getComputedStyle`.** It can return `color(srgb 0.91 0.84 0.69)`, whose components are
   0–1 **floats**. A `/[\d.]+/g` parser reads them as 0–255, so every element with a `color()`-form
   background measures as near-**black**. This reported a real 1.48:1 badge as 1.2:1 — the right
   conclusion carried by a wrong measurement, which is the worst kind because nothing looks broken.
2. **Walking ancestors for a background colour.** The moment an ancestor paints a gradient the walk
   sails past it; on `/live` it lands on the letterbox black behind the office canvas, so anything
   over `.lc-office` gets a nonsense ratio.

The script resolves colour by painting it to a 1×1 canvas **over white and over black** and solving
for colour and alpha from the two composites — exact for any colour space, syntax or alpha — and it
**stops at a gradient and says so** rather than guessing.

Validated against the canonical reference greys: `#767676` on white passes at 4.54:1, `#777777`
fails at 4.48:1.

## Reading the output honestly

- **SKIPPED** lists text over a gradient, which this method cannot measure. It is printed on every
  run and is never dropped silently — a clean sweep with 21 unmeasurable elements is itself a
  finding. Read that surface's own paper token (`--lc-paper`, `--lc-paper-2`) instead.
- **A DOM sweep only sees what is rendered.** Hover, error, empty and card/tier states are invisible
  unless you pass `--probe`.
- **`--probe` output is advisory** and never sets the exit code, because a class injected into a
  container it never really lives in can report a background it never really has.

## The design law this keeps surfacing

**A colour that is both seen and read needs two values** — a _fill_ (badge tint, border, presence
dot, a character's body on the floor) and an _ink_ (anything read as text). Four instances so far:
`--lc-warn`/`--lc-warn-ink`, `--lc-ov-accent`/`--lc-ov-accent-ink`, the ten `--lc-*-ink` siblings
(#723), and `memberColor`/`memberAvatar`/`memberInk` (#728). Derive the ink by scaling the fill in
**linear light** — the same pigment under less light — which preserves hue and saturation exactly.

`pnpm tokens:check` enforces the adjacent rule: a colour token must be defined, and a `var()`
fallback must not disagree with its definition.

**Corollary, from #728:** constant HSL _lightness_ is not constant _luminance_. The seat-identity
palette held lightness at 62% and still spanned 4.6× in luminance, so amber read far louder than
indigo and the correct text pole flipped partway across the hue band. When one ink must serve a
whole band, target a **luminance**.

## Log

| Date       | Surface                                  | Result                                                                |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------- |
| 2026-08-05 | `/live`, `/broadcast` focus rings (#710) | ring was `--accent` at 2.66:1 on paper; added `--lc-focus`            |
| 2026-08-05 | `/live` badge + status palette (#723)    | 19 failures, worst 1.48:1; ten `-ink` siblings, quiet tiers re-spaced |
| 2026-08-05 | seat identity (#728)                     | avatar initials; `memberAvatar` / `memberInk`                         |

After those three, `/live` and `/broadcast` measure **zero** live AA text-contrast failures.
