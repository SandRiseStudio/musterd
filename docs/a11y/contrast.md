# Measuring colour contrast on the web surfaces

**`pnpm a11y:check` is the gate** (CI, after Build). `pnpm a11y:contrast <url>` is the instrument you
reach for when the gate fails, or when you are measuring a surface the gate cannot reach.

## The gate

`pnpm a11y:check` runs [`scripts/a11y/contrast-gate.mjs`](../../scripts/a11y/contrast-gate.mjs) in
two phases, failing on any live AA failure. No arguments, no running daemon, nothing to set up
beyond `pnpm build`:

1. **Prerendered routes**, off a static server it runs itself.
2. **`/board` and `/live` connected**, against a throwaway daemon over a synthetic team
   ([`fixture-team.sh`](../../scripts/a11y/fixture-team.sh) — goals and lanes in every state the
   board can paint). `--static-only` skips this phase and says so in the output.

Phase 2 is not optional polish. Phase 1 alone reaches `/board` and `/live` only at their sign-in
screen — one measurable element each — and everything the product is made of lives past that point.
The first time phase 2 ran it found **eleven** more AA failures, ten of them on the goal grid.

It exists because measuring by hand does not scale past the person who remembers. `a11y:contrast`
shipped in #723 and the surfaces it was pointed at went to zero — but nothing pointed it at anything
afterwards, and by 2026-08-12 **nine live AA failures** had accumulated: eight on the approval card
and one on the goal grid's shelf label (4.05, found only because a seat happened to measure while
building something else nearby). Every one was the same mistake — a **fill** token used as text,
with its `-ink` sibling already defined a line away. That is not a lapse in care; it is what an
unautomated check measures over time.

**What the gate still cannot see**, so a green run is not over-read: gradient-backed text (reported
SKIPPED, counted per route in the summary); hover, error and empty states, which never render; and
any surface the fixture team does not seed. A surface nobody seeds is a surface nobody measures.

**The fixture's isolation contract is inherited whole** from
[`scripts/perf/broadcast-bench-fixture.sh`](../../scripts/perf/broadcast-bench-fixture.sh), which
leaked teams into the **live** daemon's DB on 2026-07-27 with every env var apparently set right.
Every CLI call carries `--server` explicitly, and before a single write the daemon at that port must
report _our_ scratch DB on `/health`. Env vars say what was intended; `/health` says what will
actually be written. Teardown kills by recorded PID — never `pkill -f serve`, which also kills the
real daemon and every other seat's.

## The instrument

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

**And its sharper form, 2026-08-12:** a band can be wide enough that _neither_ pole works. The 16px
seat avatar carried a white initial; measured across the identity band, white scored 1.61–3.90 and
near-black 4.42–10.73, and the purple seat cleared **neither** at the 4.5 small-text threshold. No
ink choice was available. Since the seat's name is written immediately beside the disc in all four
places it appears, the initial was duplicated text and the disc became a plain colour dot. Retuning
the band to a constant luminance is the other fix, and it stays open — it is a visible change to the
office, where the same values colour the characters' bodies.

## Log

| Date       | Surface                                   | Result                                                                |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------- |
| 2026-08-05 | `/live`, `/broadcast` focus rings (#710)  | ring was `--accent` at 2.66:1 on paper; added `--lc-focus`            |
| 2026-08-05 | `/live` badge + status palette (#723)     | 19 failures, worst 1.48:1; ten `-ink` siblings, quiet tiers re-spaced |
| 2026-08-05 | seat identity (#728)                      | avatar initials; `memberAvatar` / `memberInk`                         |
| 2026-08-12 | goal grid shelf label                     | `.gg-shelf__label` 4.05 on shelf paper (#8a755a); first sign of the below |
| 2026-08-12 | approval card + asks preview              | 9 failures, worst 1.50:1; all fill-token-as-text → `-ink` siblings    |
| 2026-08-12 | connected `/board` + `/live` (first ever) | 12 failures; goal grid's eight one-off browns → one measured ink set  |
| 2026-08-12 | seat avatar disc                          | white initial 3.42; band clears NEITHER pole, so the glyph went       |

After those three, `/live` and `/broadcast` measure **zero** live AA text-contrast failures — and
since 2026-08-12 every prerendered route measures zero on every PR, because `pnpm a11y:check` says
so rather than because someone looked.
