# Measuring colour contrast on the web surfaces

**`pnpm a11y:check` is the gate** (CI, after Build). `pnpm a11y:contrast <url>` is the instrument you
reach for when the gate fails, or when you are measuring a surface the gate cannot reach.

Colour only. **Tap target size has its own gate** — [target-size.md](target-size.md) — because it is
a property of layout at one viewport rather than of colour at any of them, and this gate was
structurally blind to it while 21–22px targets shipped on every route.

## The gate

`pnpm a11y:check` runs [`scripts/a11y/contrast-gate.mjs`](../../scripts/a11y/contrast-gate.mjs) in
two phases, failing on any live AA failure. No arguments, no running daemon, nothing to set up
beyond `pnpm build`:

1. **Prerendered routes**, off a static server it runs itself.
2. **`/board` and `/live` connected**, against a throwaway daemon over a synthetic team
   ([`fixture-team.sh`](../../scripts/a11y/fixture-team.sh)) — goals and lanes in every state the
   board can paint, **and an occupied room**: three seats that genuinely claim, a spread of acts
   across the tone map, and one open ask per tier. `--static-only` skips this phase and says so.

**Why the room has to be busy.** A team where nobody is present renders only its quiet states —
`offline` chips, an empty asks rail, no posture but idle. Measured both ways (`A11Y_FIXTURE_SEATS=`
gives the empty room): unoccupied `/live` yields 25 measurable text nodes, occupied 35. The count is
the least of it. Fourteen element/ink pairs exist **only** in a busy room, and nothing had ever
measured any of them — the act→tone badges (`help`, `status`, `handoff`), the `working` posture
chip, a quote and its author in the sender's own ink, the work stack's task/name/state/overflow, the
asks rail's avatar and rest-count. Seats must genuinely **claim**: `team add` alone leaves them
unbound, their sends fall back to the admin identity, and the whole identity palette collapses to
one colour — a seeded room that still measures almost nothing.

Phase 2 is not optional polish. Phase 1 alone reaches `/board` and `/live` only at their sign-in
screen — one measurable element each — and everything the product is made of lives past that point.
The first time phase 2 ran it found **eleven** more AA failures, ten of them on the goal grid.

**The reduced-motion room is its own sweep.** The instrument emulates `prefers-reduced-motion:
reduce` before navigating, so every route is measured with the media query on — but
`/office-preview` reads its own `?reduced` flag rather than the query, deliberately, so the design
tool still animates for a designer who has Reduce Motion set in their OS. Those two facts do not
cancel: without `&reduced` the gate measures a hybrid room nobody is served, CSS keyframes off and
scene motion running. `/office-preview` therefore sweeps four ways — two lights × animated and
reduced. Measured 2026-09-14 on `d92bca0a`: all four give 49 measured, 0 below AA, the same two
excluded rows and the same two translucent ones. The reduced room is contrast-identical to the
animated one at rest, which is the equivalence this pins rather than a reason to skip it.

To confirm the flag is not inert, count animation frames instead of trusting the row totals:
`&still` alone runs 522 `requestAnimationFrame` callbacks in nine seconds, `&still&reduced` runs 7.

It exists because measuring by hand does not scale past the person who remembers. `a11y:contrast`
shipped in #723 and the surfaces it was pointed at went to zero — but nothing pointed it at anything
afterwards, and by 2026-08-12 **nine live AA failures** had accumulated: eight on the approval card
and one on the goal grid's shelf label (4.05, found only because a seat happened to measure while
building something else nearby). Every one was the same mistake — a **fill** token used as text,
with its `-ink` sibling already defined a line away. That is not a lapse in care; it is what an
unautomated check measures over time.

**What the gate still cannot see**, so a green run is not over-read: hover, error and empty states,
which never render; text with no line box to sample or sitting off the captured page (still reported
SKIPPED, counted per route in the summary); elements caught mid-fade, which keep their composited
estimate rather than a frame nobody stays on; and any surface the fixture team does not seed. A
surface nobody seeds is a surface nobody measures.

**The approval card is currently in that category** (2026-08-19, lane 01M092TRQ6). `/approval-preview`
— a synthetic route that existed only to be swept — was retired rather than kept alive as its own
justification. The static sweep of `/approvals` reaches its sign-in screen only, and the card's
states come back into measurement when `/approvals` becomes a signin surface (ADR 222 limits those
to board/live) and the fixture team leaves one request pending. Until then the card's nine 2026-08-12
failures stay fixed in the tokens, but nothing re-measures them.

**The gradient blind spot is closed** (2026-08-13). It used to be the largest hole in the gate —
13–21 elements a route, and seeding the office made it _worse_, because a loud asks rail meant more
text painted over a gradient. Sampling the painted pixel measures all of it. `SKIPPED` is now
normally empty; what remains reaches it only when there is no line box to sample or the text sits
off the captured page.

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
**stops at a gradient** rather than guessing.

**There was a third wrong answer, and it survived the first two fixes.** Stopping at a gradient was
honest about what it could not see; it said nothing about what it _could_ see but was reading wrong.
The ancestor walk ignores `opacity` entirely, so a row faded to 0.55 had its ink measured at full
strength — `.lc-seat--offline` reported **14.34** where the eye gets **3.55**. Refusing to answer
where you cannot see is only half the discipline.

## Sampling the painted pixel

So the sweep no longer reasons about what the background _should_ be. After the walk, every glyph on
the page is made transparent, the page is screenshotted over CDP, the PNG is decoded in-process
(pure `node:zlib`, no dependency), and each text node's own line box is sampled. Whatever is under
that pixel — gradient stop, photograph, live canvas, three translucent layers — is what the reader
gets. The element's settled opacity is folded into the **ink** too, because a fade dims the words and
the paper together.

Three rules stop that becoming a fourth wrong answer:

- **It must agree with the walk wherever the walk was valid.** Both run every time, and every
  disagreement past rounding prints in a `DISAGREEMENT` section. This earned its place immediately:
  the first run disagreed on three elements and the _walk_ was right about all three — they were
  mid-animation.
- **A fade that is still moving is refused; a fade that has settled is measured with the fade
  included.** Three opacity readings tell them apart — two bracketing a 300 ms window before the
  screenshot, and one _after the shutter_. The third is not belt-and-braces: the office preview runs
  a timed choreography that pulls speech bubbles back out of the room, and on CI a bubble sat at
  opacity 1 for both early readings and was halfway gone by the time the pixel was taken. It
  reported 3.16 for text that is nowhere near that bad — a false **failure**, the one kind of wrong
  answer that costs someone a day chasing a colour that was never wrong. Animations are also finished
  programmatically first, and the page is measured under `prefers-reduced-motion: reduce` — a real
  user state this project already writes CSS for, and the only one with a single settled appearance.
- **Validated end to end against known values whenever it changes:** `#767676` on white 4.54,
  `#777777` 4.48, 30% black over white 2.11, and `#949494` over a gradient-painted black 6.92 — the
  last of which the walk could not measure at all.

### Exemptions

Two, both WCAG 1.4.3's own carve-outs, both **printed in an `EXEMPT` section on every run** rather
than filtered into silence:

- **Logotypes** — "text that is part of a logo or brand name has no contrast requirement". The only
  entry is the room's `musterd` watermark, whose 0.45 opacity is a tuned value.
- **Inactive components** — a disabled control. Read off the element (`:disabled`, `aria-disabled`),
  never off a list of class names, so a control that gets re-enabled stops being exempt by itself.

Anything merely hard to fix belongs in the failure list.

## Reading the output honestly

- **SKIPPED** is what neither method could reach: no line box to sample, or text off the captured
  page. It is printed on every run and never dropped silently — a sweep that skips a lot is itself a
  finding. It used to mean "over a gradient", which was the bulk of it; that hole closed on
  2026-08-13 and the list is normally empty now.
- **`! … mid-animation`** means an element was still moving and kept its composited estimate. Not a
  measurement of the painted pixel, and not a pass to lean on — if a surface reports this every run,
  something is animating that should have settled.
- **`! … permanently translucent`** is the opposite, and it IS authoritative: a settled fade, with
  the ink composited at that alpha because that is what the reader gets.
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

**A third form, 2026-08-13: `opacity` is not a de-emphasis tool for text.** It scales the ink and
the paper behind it by the same factor, so it lowers contrast _by construction_ — and it does so
invisibly, because every checker that reads CSS colours sees the ink at full strength and passes it.
`.lc-seat--offline` faded whole roster rows to 0.55 and took three labels to 3.55, 2.59 and 2.34.
The fix is the same shape as the fill/ink split: **fade the glyphs that carry no words** — the
presence dot, the avatar disc — and let a quieter _ink_ do the de-emphasising, where the value is
chosen and measured rather than arrived at by multiplication.

**And its sharper form, 2026-08-12 — withdrawn 2026-08-13, because the measurement behind it was
not measuring what it named.** The claim was that the seat-identity band is wide enough that
_neither_ ink pole works, so the avatar initials had to go. What was actually measured was the
owner-filter chip's disc, which is painted by `memberColor` — the office **fill**, luminance 0.257.
Every disc that carries a letter is painted by `memberAvatar`, the **ink**, luminance 0.165, where
white measures **4.86 at its worst across 24 names**. The retune the paragraph called still-open had
shipped in #728; the band already targets a constant luminance, and always deliberately left the
office floor alone. The initials are back.

### The dedupe key must carry the paper, not just the ink

The reason one component's number was read as four components' verdict: the sweep keyed each text
node as `class | computed-colour` and measured only the first node per key. Four components render
`.lc-card__avatar` in white — same class, same ink, **different background** — so they collapsed
into one row.

The key now carries a signature of the painted background as well (`paperSig`, walking the same
ancestor chain `effBg` composites and stopping at the first opaque layer or gradient). It is shared
verbatim by all three in-page walkers so their rows still join.

This was never only about avatars. Turning it on took connected `/board` from 41 measured rows to
45, and one of the four newly-visible rows was a **live AA failure of its own**: `.gg-zone` under
`.gg-card--loose`'s 0.75 runway fade, 3.30 where the same class on every other card measures 5.72.
Any shared utility class in the codebase was one background away from the same blind spot.

The general rule: **a dedupe key that omits any input to the measurement will hide exactly the
instances that differ in it** — and it hides them as a pass, which is the one direction an
accessibility tool must never fail in.

## Measuring while it moves: `--motion` (manual, not in the gate)

The frozen pass answers "what does this row sit on". It cannot answer "what does it sit on a second
later". In the office, members walk, the night veil runs and bubbles pass under nameplates. A label
that clears AA on the floor it settles on can be washed out by a body crossing beneath it, and two
lighting presets do not catch that (lane 01M2NRPMPA).

`node scripts/a11y/contrast-sweep.mjs <url> --motion` lets the page run. It samples 8 frames 750 ms
apart, holding each still only for its own shutter: rAF callbacks are parked and then handed back,
so the scene resumes. Each row is graded against its **worst ground among the frames where it is at
its most opaque**. A fade is graded at its peak, not mid-fade. A row that moves under a shutter is
excluded for that frame. The mode skips reduced-motion emulation, because the motion is what it
tests, and it replaces the frozen pass for that run. Run both for full coverage.

**The falsifier** is `scripts/a11y/fixtures/motion-ground-brightens.html`: white text on `#1a1a1a`,
with a `#e8e8e8` block walking beneath it on an rAF loop. Measured 2026-09-23: the frozen pass is
**green 3 of 3**, and `--motion` is **red 3 of 3** at `1.23 on #e8e8e8` (best frame 17.4), while its
steady control line passes.

**The opacity falsifier** is `scripts/a11y/fixtures/opacity-pinned-055.html`: `#555555` on white
(about 7.5:1 at full strength) pinned at `opacity: 0.55`, with the same ink at full strength as a
control. Measured 2026-09-23: the frozen pass and `--motion` are both **red 3 of 3 at 2.57**, and the
control passes. `--motion` says it graded the row at its peak opacity of 0.55. This is the lane's
second falsifier. The frozen pass already folded a settled fade into the ink, so this commits the
proof rather than a fix.

**Cost, measured 2026-09-23** against the local daemon (wall clock includes Chrome start and load):

| route | rows | motion loop | wall | below AA |
| --- | ---: | ---: | ---: | ---: |
| `/live?light=12` | 130 | 7.4 s | 12 s | 1 |
| `/live?light=21` | 127 | 7.8 s | 22 s | 0 |
| `/office-preview?light=12` | 8 | 7.9 s | 25 s | 0 |
| `/office-preview?light=21` | 8 | 7.7 s | 16 s | 0 |

So the loop is ~8 s per route, and the four office routes would add about 75 s of wall clock to
`a11y-connected` if they ran as separate sweeps. Until someone decides that is worth it, the mode
stays manual.

**Findings from those runs, triaged 2026-09-23:**

- ~~`/live?light=12`: `lc-chip__avatar lc-asks__who is-over` "D", white on `#5b8dd5`, **3.38**~~
  **A measurement artifact, not a page defect.** Live at 1440×900, the disc is `rgb(41,110,214)`
  (luminance 0.164, the value `memberAvatar()` targets) and white on it is about 4.9:1, with nothing
  over it in `elementsFromPoint`. The sampled `#5b8dd5` is that disc under a ~23% white wash, and it
  varied from frame to frame (3.38 to 4.39, never 4.9). The cause was this mode's own shutter. A
  `captureBeyondViewport` capture resizes the page, and without reduced motion that re-ran the
  strip's 0.2 s `lc-fade`, so every frame caught it mid-fade over the floor. The mode now captures
  the viewport only. On a re-run the row is clean 3 of 3, and the fixture is still red at 1.23.
- `/office-preview?light=12`: one run graded `lc-speech__text` at 4.38 on `#d7605f`, seen in only one
  frame. That is a character colour, so it is probably the moving-bubble mis-sample the frozen pass
  already documents. It did not repeat, and nothing has been changed for it.

**A vacuous green, closed the same day.** Settling on "loaded and painted" can fire before `/live`
renders its rows, and one run graded **0 rows and exited 0**. Zero graded rows now exits 2 as a
harness failure. A settle that fires early and grades only part of the page (one run graded 16 rows
where others graded ~120) is ~~still possible and is not yet guarded~~ **guarded since 2026-09-23**:
after the frames, if the page carries more than 1.25 × the walked rows + 5, the run exits 2 ("the
page grew from N to M text rows"). `fixtures/motion-late-render.html`, which adds 20 rows after 6 s,
graded 1 row of 21 green before the guard and exits 2 after it. A settle heuristic was tried first
(wait until the row count stops reaching new highs for 2.5 s) and was rejected: it cannot know how
long a fetch will take, and it still graded that fixture's 1 row.

~~**What the guard cannot see:** a page whose data never arrives during the run.~~ **Guarded since
2026-09-24.** In 1 of 5 `/live` runs the team data did not load at all, so the sweep graded the
empty screen ("0 seats", "No seats on this team", "Listening.", 18 rows) and nothing grew. That was
not specific to `--motion`, and it was not only a manual gap: the CI gate's floor for connected
`/live` was 12 rows, **under** the empty screen's 18, so an empty `/live` passed CI too. Two changes:

- The gate's connected `/live` floor is now 100. The fixture team paints 260-307 rows in CI
  (2026-09-24) and the empty screen paints ~18. `/board` keeps its 12.
- The sweep takes `--min-rows N` for manual runs, both passes. Under the floor it exits 2 as a
  harness failure. Use ~100 on a populated `/live`. Without the flag, read the row count yourself.

## Log

| Date       | Surface                                   | Result                                                                                 |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| 2026-08-05 | `/live`, `/broadcast` focus rings (#710)  | ring was `--accent` at 2.66:1 on paper; added `--lc-focus`                             |
| 2026-08-05 | `/live` badge + status palette (#723)     | 19 failures, worst 1.48:1; ten `-ink` siblings, quiet tiers re-spaced                  |
| 2026-08-05 | seat identity (#728)                      | avatar initials; `memberAvatar` / `memberInk`                                          |
| 2026-08-12 | goal grid shelf label                     | `.gg-shelf__label` 4.05 on shelf paper (#8a755a); first sign of the below              |
| 2026-08-12 | approval card + asks preview              | 9 failures, worst 1.50:1; all fill-token-as-text → `-ink` siblings                     |
| 2026-08-12 | connected `/board` + `/live` (first ever) | 12 failures; goal grid's eight one-off browns → one measured ink set                   |
| 2026-08-12 | seat avatar disc                          | white initial 3.42; band clears NEITHER pole, so the glyph went                        |
| 2026-08-12 | `/live` with the room occupied            | 0 failures — but +14 pairs measured for the first time, +8 shown unmeasurable          |
| 2026-08-13 | dedupe key gains the painted paper        | 41 → 45 rows on `/board`; `.gg-zone` 3.30 under the loose-card fade; initials restored |
| 2026-08-13 | pixel sampling — the gradient blind spot  | 12 failures nothing could previously see; `SKIPPED` 21 → 0 on `/live`                  |
| 2026-08-13 | `.lc-seat--offline` opacity dim           | ink read 14.34, eye got 3.55 — dim the dot and avatar, not the words                   |
| 2026-08-13 | hero eyebrow + cursor + `--text-faint`    | 1.18 / 2.54 / 4.09 on the landing page; added `--accent-ink`                           |
| 2026-09-14 | `/office-preview` reduced-motion room     | 0 failures — 49 measured at both lights, identical to the animated room at rest        |

After those three, `/live` and `/broadcast` measure **zero** live AA text-contrast failures — and
since 2026-08-12 every prerendered route measures zero on every PR, because `pnpm a11y:check` says
so rather than because someone looked.
