# The share card

`social-card.html` is **the source**. Two PNGs are build artifacts and must stay identical:
`docs/design/assets/social-card.png` (the brand asset the README unfurl points at) and
`packages/web/src/brand/social-card.png` (what `__root.tsx` imports as `og:image` /
`twitter:image` — Vite hashes and ships THIS one, so a re-render that misses it never reaches
musterd.io; that is exactly what happened on 2026-09-16, deploy ff6b60b2) — never
hand-edit it, and never ship a PNG whose copy you have not changed here first.

## Rebuild it

Needs Chrome, the only dependency, not added to the repo:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --window-size=1200,630 \
  --screenshot="docs/design/assets/social-card.png" \
  --virtual-time-budget=2000 \
  "file://$PWD/docs/brand/social-card/social-card.html"
```

```bash
cp docs/design/assets/social-card.png packages/web/src/brand/social-card.png
```

Then open the PNG and look at it, and update `SITE_CARD_ALT` in
`packages/web/src/brand/siteMeta.ts` so the alt text says what the card renders.

## Where the copy comes from

Nothing on this card is invented. Change the sources first, then the card.

| On the card | Comes from |
| --- | --- |
| Wordmark | `docs/design/brand.md` §1 — lowercase, the `d` in mustard |
| The four-line one-liner | `docs/design/brand.md` §1 — the canonical one-liner, verbatim |
| "every act on the roster has a name on it, and a human is on the roster too." | [ADR 320](../../decisions/320-positioning-the-value-prop-decided.md) §5a (2026-09-16) — the approved compression of the swarm counter-line |
| "humans are members, not approvers." | README Principle 1; ADR 320 §2 |

## Rules this card has to keep

- **No bare "coordination layer"** (ADR 320 §4). The card does not use the phrase.
- **No containment claim, and not the critic's noun** (ADR 320 §5). Names and the observed record
  are the answer; "swarm" never appears.
- **No hype vocabulary** — `docs/design/brand.md` §4.
- **The alt text matches the render.** A reader who gets the alt instead of the image gets the same
  claims in the same order.

## History

Before 2026-09-16 the card existed only as a Figma export (`docs/design/figma-brief-brand.md`),
so its accent line could not follow the positioning decision. This directory exists so the image
strangers meet first in Slack or on X is rebuildable from text under review.
