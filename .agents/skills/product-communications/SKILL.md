---
name: product-communications
description: How musterd speaks in public — messaging, launch narrative, release notes, press releases, public docs, UI-copy specs, and marketing assets. Use for any writing that leaves the repo (announcement, launch post, press release, release notes, social copy, README/docs prose) or any UI-copy spec handed to the designer. Enforces the brand voice and canonical glossary; adapted craft from vendored upstream skills, provenance in PROVENANCE.md.
---

# product-communications

This skill teaches craft, not message. The message lives in the authoritative
sources below; if anything in this file appears to disagree with them, they win
and this file has a bug — fix it with a PR, do not follow it.

## Authoritative sources (read before writing anything public)

1. `docs/design/brand.md` — voice and tone (§4), terminology glossary (§5),
   marks and color (§1–§3, ADR 154). The glossary's five terms — Team, Member,
   Presence, Surface, Act — are load-bearing and must be used with their exact
   meanings; never introduce synonyms ("room", "user", "session", "platform",
   "event"). ADR 296 makes the glossary a generated, gated artifact — treat
   drift as a build failure, not a style preference.
2. `PRODUCT.md` — register, users, product purpose, brand personality
   (engineered, luminous, quiet-confident), anti-references.
3. `SPEC.md` — the normative definitions behind the glossary.
4. `docs/wiki/positioning.md` + `docs/design/landscape.md` — brand
   architecture (SandRise Studio is maker, never product brand) and the
   competitive line (coordination of independent actors, not intra-task
   orchestration; "Band connects your agents; musterd makes them a team").

**The positioning decision is not yours.** It is made in the positioning ADR;
you execute the decided message and keep every surface telling the same story.
Until that ADR lands, treat `docs/wiki/positioning.md` as current direction and
flag — don't resolve — any tension you find.

## Charter boundaries (from the product-communications role)

- **Product UI stays with the designer role.** You supply exact UI-copy specs
  (see below) and hand implementation over.
- **Pricing / business model:** advise, never decide.
- **Internal architecture docs and ADRs:** audit for clarity; implementers
  retain authorship.
- **Imported or adapted skill material must never become a competing message
  source.** This file deliberately quotes the brand doc minimally and points
  instead; when in doubt, open brand.md.

## Voice, operationally

brand.md §4 is the profile. The checks that catch most violations:

- No hype vocabulary. Banned outright: "revolutionary", "magic",
  "supercharge", "10x", "game-changing", "cutting-edge", "world-class",
  "seamless", "innovative", "thrilled", "excited to announce".
- Second person, present tense, plain and declarative. One idea per sentence.
  Lead with the concrete.
- `musterd` lowercase everywhere body copy allows; sentence-case headings.
- Honest about scope: roadmap is "not yet", plainly — never implied as
  existing. If a claim can't be made specific and true, cut it.
- Personality budget: one mustard pun in the README, warm-but-spare CLI
  microcopy. Everything else stays plain — the experience carries the
  spectacle, never the words (brand.md §7).

## Editing pass: the sweeps

Adapted from upstream "Seven Sweeps" (see PROVENANCE.md), reduced to the five
that fit a no-hype voice. Run them in order on any public copy; after each
sweep, re-check the earlier ones.

1. **Clarity** — can a reader outside the team parse every sentence? No
   insider shorthand, no unexplained ADR numbers in public copy.
2. **Voice** — consistent with §4 throughout; no drift from plain to
   corporate or from calm to salesy.
3. **So what** — every claim answers "why should the reader care", in the
   reader's terms. Features get their consequence stated.
4. **Prove it / specificity** — claims carry the number, the name, or the
   command that makes them checkable. "Fast" is not a claim; "reloads on
   SIGHUP without dropping sessions" is. What can't be made specific is
   filler — cut it.
5. **Honesty** — the musterd replacement for "heightened emotion" and "zero
   risk" sweeps: no manufactured urgency, no softened limitations. State what
   exists, what doesn't yet, and what it costs to adopt.

## Release notes and announcements

Size the announcement to the change (adapted from upstream launch skill):

- **Major** (new capability, new surface): launch post + README/docs update +
  social copy + demo asset. Full pass through the sweeps.
- **Medium** (new integration, meaningful improvement): short announcement +
  changelog entry.
- **Minor** (fixes, small tweaks): changelog line only. Its job is to signal
  the product is alive, not to market.

Structure for any announcement: what changed, why it matters to the reader,
how to try it (exact command), what's still not there. Phased releases
(internal → early access → general) are fine; never call a phase more than it
is.

## Press releases

Adapted from upstream press-release-writer (see PROVENANCE.md). A press
release is a news document, not an advertisement — if there is no genuine
news, say so and stop.

Structure (inverted pyramid — every paragraph removable from the bottom):

```
FOR IMMEDIATE RELEASE / EMBARGO [date, tz]
Headline — sentence case, the core news
Dateline — Lead: the 5W1H in 25–35 words (count them)
Body 1 — expand the lead; primary data point
Quote — a named person saying something with content, not enthusiasm
Body 2 — context; availability; how to try it
Boilerplate — about musterd / SandRise Studio, ≤100 words, factual
Media contact
###
```

Quality bar before it leaves the building:

- Lead answers who/what/when/where/why/how in 25–35 words.
- 300–500 words total; third person outside quotes; attribution verb is
  "said"; at least one concrete number; no banned vocabulary (see Voice).
- Boilerplate matches positioning.md's brand architecture: SandRise Studio is
  "from the makers of", never the product brand.

## UX-copy specs (handoff to designer)

Adapted from upstream ux-writing skill (see PROVENANCE.md). Four standards for
every string: **purposeful** (helps the user's task), **concise** (no word
that isn't working), **conversational** (how a person says it), **clear**
(no ambiguity about what happens next).

- Error messages: what happened, why (if known), what to do next — in that
  order. Never blame the user; never a bare "something went wrong" when the
  cause is known.
- Empty states: say what will appear here and how to cause it. The CLI's
  registered example: `inbox empty — nobody's mustered anything yet`.
- Buttons/links: verb-first, outcome-named.
- Act meaning never relies on color alone; the act name is always written
  (PRODUCT.md accessibility).

Handoff format: a table of `surface / state / exact string / notes
(constraints, char limits, glossary terms used)`. The spec is exact — the
designer implements it verbatim or bounces it back; nobody paraphrases copy
in transit.

## Marketing assets

- Marks: only the wordmark, Brand Chip, and Nameplate Tile (ADR 154; sources
  in `docs/design/assets/`). Never a lone capital M, gradients on the chip,
  or a new mascot.
- One accent: mustard `#E1AD01` on zinc neutrals. Web/marketing surfaces may
  go maximal per brand.md §7; the words stay plain even when the pixels
  don't.
- Social cards: the live reference is https://musterd.io's og:image; keep new
  cards consistent with it.
- Screenshots: real product output only — never mock terminal output that the
  CLI doesn't actually produce.

## Definition of done for public copy

- [ ] Sweeps run (all five, in order)
- [ ] Glossary terms used exactly; no synonyms introduced
- [ ] Every claim specific and checkable; roadmap marked "not yet"
- [ ] Voice check against brand.md §4 (read it, don't recall it)
- [ ] `pnpm format:check` passes if the copy lives in-repo
- [ ] For high-stakes copy (launch post, press release, pricing page): a
      second seat reads it before it ships
