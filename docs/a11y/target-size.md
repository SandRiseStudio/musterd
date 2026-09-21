# Measuring tap targets at phone width

**`pnpm a11y:targets:check` is the gate** (CI, after Build). `pnpm a11y:targets <url>` is the
instrument you reach for when it fails, or to measure a surface the gate cannot reach.

Sibling of [contrast.md](contrast.md), and deliberately a separate gate: contrast is a property of
colour at any width, target size is a property of **layout at one width**. Folding them together
would mean sweeping every route twice at two viewports to answer a question that needs one of them.
The two share their browser plumbing ([`chrome.mjs`](../../scripts/a11y/chrome.mjs)) and nothing
else.

## Why it exists

The shared nav and footer shipped 21–22px-tall targets on **every route** while a 23-sweep a11y
gate stayed green (measured 2026-09-21, lane 01M32GF49Z). Nothing in the suite measured layout at
any viewport, so the failure was not missed — it was invisible.

The fix's own tests cannot replace the gate either. `site.test.ts` pins the min-heights by reading
**CSS source**: that stops someone deleting a declaration, and it cannot see what a browser lays
out — a new link added without the rule, a media query that overrides the min-height at some width,
a flex context that shrinks a target, two targets that overlap. Every one is a real failure and
none is visible in source text.

## Two standards, never conflated

This is the most important thing on this page. The gate enforces **two** floors and labels every
row with which one it is:

| Row                   | Means                                                            | Report it as                  |
| --------------------- | ---------------------------------------------------------------- | ----------------------------- |
| `✗ … under 24×24, and …` | a genuine **WCAG 2.2 AA 2.5.8** failure                        | an accessibility defect       |
| `✗ HOUSE FLOOR …`     | conforms to 2.5.8, under the **24px the team set** for the chrome | a house preference, not WCAG  |
| `✗ OVERLAP …`         | two targets partially on top of each other                        | an accessibility defect       |

**The audit that started this was wrong about the spec, and measuring is what settled it.** The
2026-09-21 site audit called the 21–22px nav and footer links a 2.5.8 defect. They are not: nothing
sits within 12px of their centres, so the **spacing exception** applies and they conform. Falsified
directly — the built nav shrunk back to 20px and re-swept still passed, as `spacing` (2026-09-21,
lane 01M32HG5GJ; falsify: set `min-height: 20px` on `.sitenav__links a`, rebuild, and run
`pnpm a11y:targets:check` — a row reading `below AA 2.5.8` rather than `HOUSE FLOOR` disproves it).
<!-- claim: other -->

The team's 24px line for the shared chrome is still right — a 21px link on a phone is missed twice
before it is hit, and the iOS HIG asks 44pt — so the gate keeps enforcing it. It just never calls
it a standards violation. A gate that blurs the two makes a false accessibility claim about our own
site, in our own CI, and `target-house-floor-nav.html` is the control that stops it.

The house floor's scope is `header, footer, nav` and nothing else, because that is exactly what was
decided. Prose links are judged by the spec alone: `/docs`'s 22px list links are reported as
**conforming on spacing**, not failed.

## The four 2.5.8 clauses, and which one decided each row

Every verdict names its clause. 2.5.8 is **not** "every target is 24×24":

- **SIZE** — the bounding box is ≥24×24. Passes outright.
- **SPACING** — undersized, but a 24px-diameter circle centred on it reaches no other target's box
  and no other undersized target's circle. The spec's own get-out, and the reason this gate is not
  a size ruler.
- **INLINE** — the target is in a sentence. See below; this is the hard one.
- **ESSENTIAL** — nothing is exempt automatically. A target whose size is genuinely required needs
  `data-a11y-target-essential="<reason>"`, and the reason prints on every run so an exemption
  cannot go quiet.

**OVERLAP is judged separately, for every pair, including targets that are each comfortably
24×24.** An obscured target fails 2.5.8 as surely as a small one, and during the 01M32GF49Z fix a
first cut grew padding to satisfy the size clause until the boxes collided — trading a small-target
violation for an overlap one, which only measuring caught. Containment is **not** overlap: a button
inside a card-link is a nesting, both are reachable, and reporting it would fire on every composite
control on the site.

## The inline exception, which is the hard part

Too permissive and the gate is decorative; too strict and it is noise someone deletes. Both
conditions must hold:

1. **the target's own computed display is exactly `inline`** — not `inline-block`, not
   `inline-flex`. A word in a sentence is laid out as a word; a button is a box that happens to sit
   on a line, and authors reach for `inline-block` precisely to make one.
2. **its parent holds a direct non-whitespace text node outside the target** (climbing out through
   purely-inline wrappers like `<em>`). "In a sentence" means there is prose either side of it.

**Condition 1 was added after the gate exempted a CTA.** The first cut looked for text anywhere in
the nearest *block* ancestor. `/watch`'s `Zero to a working team in one command` is an
`inline-block` anchor whose nearest block ancestor is a `<section>` holding an `<h2>` and a
paragraph — so the rule found the paragraph and called a standalone button a sentence. A CTA is the
single most important target on the page and the gate was exempting it (2026-09-21, lane
01M32HG5GJ).

Worked examples, both directions:

| Markup                                                    | Verdict  | Why                                             |
| --------------------------------------------------------- | -------- | ----------------------------------------------- |
| `<p>built in the open at <a>the repository</a>, which…</p>` | INLINE   | `display: inline`, prose either side            |
| `<section><h2>…</h2><p>…</p><a class="cta">…</a></section>` | judged   | `inline-block`; the prose is not on its line    |
| `<li><a>Getting started</a></li>` in a prose list           | judged   | the `<li>` holds no text outside the anchor     |

## Two phases

1. **Prerendered routes**, off a static server it runs itself.
2. **`/board` and `/live` connected**, against a throwaway daemon over a synthetic team
   ([`fixture-team.sh`](../../scripts/a11y/fixture-team.sh)) — the same fixture the contrast gate
   uses. `--static-only` skips it, `--connected-only` runs it alone, and each says so rather than
   passing quietly.

**Phase 2 earned its place on its first run** (2026-09-21, lane 01M32WGSG6). A static server
reaches those two routes only before they connect — **three targets each**, two buttons and a
link. Connected, `/board` renders **17** and `/live` **7**, and among them were three defects
nothing had ever measured:

- **`/live`'s entire topbar button row at 19×30.** The source says `width: 30px`. `.lc__topbar` is
  a flex row, so the five buttons were flex items with the default `flex-shrink: 1`, and at 390px
  the row ran out of room and squeezed every one of them. **A test that reads CSS source sees a
  correct declaration.** Only a browser sees the 19. This is the single clearest argument for the
  whole gate.
- **`/board`'s `.lc-insight__more` at 26×16 with another target 0.0px from its centre** — a
  genuine 2.5.8 failure, undersized *and* crowded, so neither the size clause nor the spacing
  exception forgave it.
- **`/board`'s view switcher at 20px tall.**

All three were fixed in the same change, because a gate cannot land red.

**A floor per connected route.** `/board` must measure ≥10 targets and `/live` ≥5 — measured, not
guessed, against 17 and 7 connected versus 3 apiece at the sign-in screen. The sweep's own
zero-target refusal cannot catch this: a sign-in screen renders **three** targets, which is not
zero, so a page that never connected would otherwise pass exactly like a clean one.

**A count is not coverage, so each connected sweep names the surface it is there for.**
`/board` requires `.gg-stage` (the goal grid) and `/live` requires `.lc__topbar`; a sweep whose
required selector matches nothing **refuses** with exit 2 instead of reporting a target count.

That is not belt-and-braces. `/board` renders the goal grid only while the fixture has an unshipped
goal — `resolveBoardView` returns `columns` otherwise, and the fixture clears that threshold by
*exactly one* — and the columns view renders plenty of targets, so the floor of 10 would pass
happily while the grid stopped being measured (sloane, 2026-09-21, lane 01M32ZTPR7). The goal grid
is where the contrast gate found **ten of its eleven** failures, so losing it silently is the
expensive version of this mistake. It is also the `/roadmap` shape from earlier the same day: an
instrument reporting a green verdict about a surface it had stopped visiting.

**Why a check and not `?view=grid`.** Forcing the view would add a URL surface to a product page
purely to serve a gate, and would make the sweep pass *by construction* rather than by observation
— the same "exercise the comparison, never the operand" failure that let guardian ship a green unit
test for a file nothing writes (ADR 435). Verifying makes a fixture change loud on the next run;
forcing would hide it forever.

**The scene is pinned** (`?light=12&still`) for the reason the contrast gate pins it: a verdict
that changes with the wall clock or with what the room happened to be doing cannot gate merges.
Geometry is less light-sensitive than colour but not motion-insensitive — a walker mid-stride
moves a target's box. One light rather than the bracket, since `?light=` changes paint, not layout.

## Running it

```bash
pnpm a11y:targets:check                      # both phases, every route at 390×844
pnpm a11y:targets:check --static-only        # prerendered only (no CLI build needed)
pnpm a11y:targets:check --connected-only     # the fixture-daemon phase alone
pnpm a11y:targets http://127.0.0.1:4849/     # one page
pnpm a11y:targets <url> --viewport 320x568   # a narrower phone
pnpm a11y:targets <url> --json out.json      # every judged row, for digging
pnpm a11y:targets <url> --require .gg-stage  # refuse unless that surface is on the page
```

Needs `pnpm build` first and nothing else — the gate serves the built client itself.

**390×844** is the default: the iPhone 12/13/14 logical viewport, and the width the audit read the
site at. It is deliberate rather than incidental — target size only bites at phone width, so a
sweep defaulting to 1440 would be green by construction.

## Checking the gate rather than the page

```bash
node scripts/a11y/target-size-falsifier.mjs
```

Seven arms over fixtures whose verdict is known in advance. `contrast.md` set the precedent and the
wiki's rule 3 states it: **a check that passes either way is a ritual.** The gate is green on
`main` — that is either because the site conforms or because the gate cannot see, and only a
control that fails tells them apart.

| Arm                       | Must   | Aimed at                                                 |
| ------------------------- | ------ | -------------------------------------------------------- |
| `undersized-crowded`      | fail 1 | the plain size clause, outside the chrome                |
| `whitespace-is-not-prose` | fail 1 | newlines around a link reading as a sentence             |
| `require-absent`          | fail 2 | counting targets on a page that is not the surface       |
| `overlapping-pair`        | fail 1 | two 44×44 buttons overlapping — a size-only gate passes  |
| `inline-block-cta`        | fail 1 | the exemption drifting back to permissive                |
| `house-floor-nav`         | fail 1 | conforming markup must fail HOUSE, never "below AA"      |
| `conforming`              | pass 0 | size, spacing and inline conformance all pass            |

The passing arm is the one that keeps the gate installed. "It fails the bad ones" is half a claim.

**Two of the six were written after the gate got something wrong**, which is the honest reason to
trust the other four less than you would like. `inline-block-cta` came from the exemption swallowing
`/watch`'s CTA. `whitespace-is-not-prose` came from CI's linter: the whitespace strip was written
`/[\s\u00a0]+/` **inside the in-page template literal**, where `\s` collapses to a bare `s` — so it
removed the letter S and left ordinary spaces standing as prose, and every stacked link with a
newline after it was one formatting change from claiming the exemption. All five arms that existed
passed with that bug, because none had pretty-printed markup around an inline link. Note that no
unit test could have caught it either: the escape only misbehaves after going through a template
literal into a page.

The geometry rules are also unit-tested without a browser
([`target-size-rules.test.ts`](../../scripts/a11y/target-size-rules.test.ts)): the spacing exception
is too fiddly to be reasoned about, and it is the clause that decides whether an undersized target
is a defect or a conformance.

## What a green run does not mean

- **One viewport, one render, one state.** Hover menus, open dropdowns, focus affordances and
  anything behind an interaction are not measured. Printed on every run.
- **The asks sheet and the nameplates are NOT covered.** `?asks-open` and `?plates-open` change
  nothing at 390px — the sweep returns an identical target count with and without them — so those
  surfaces do not mount at phone width. The contrast gate sweeps them at desktop width, where they
  do. Measuring them here would need a second viewport, which is its own increment; until then a
  green run says nothing about them.
- **A page that renders no target at all is refused, not passed** (exit 2). Zero targets means the
  page never rendered — a 404, a stale `dist/`, a client that never mounted. Hit immediately: the
  first gate run got `0 measured, 0 below AA` and exit 0 from a `/roadmap` missing from a stale
  dist. `--allow-empty` is for a route that genuinely has no links or buttons.
