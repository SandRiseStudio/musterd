# ADR 431: the public site is light-only at launch, and that is a decision now

- Status: proposed
- Date: 2026-09-21
- Lane: 01M32PWCZHNCS7TKRKMBVHWN7M (goal `launch`)

## Context

`packages/web/src/routes/__root.tsx` pins `data-theme="light"` on `<html>` and declares
`<meta name="color-scheme" content="light">`. Nothing on the public site reads
`prefers-color-scheme`, and there is no toggle.

The dusk palette is not missing. It is the **bare `:root` block** in `packages/web/src/styles/tokens.css` —
the complete semantic token set, reachable by setting `data-theme` to anything but `light`. That
file's own header describes the arrangement as a staging post:

> ACTIVE DEFAULT: light (PR 3b). … The bare `:root` values remain the dusk palette — reachable by
> setting data-theme to anything but "light" (**a future toggle**) …

So a reader today cannot tell whether light-only is a choice or a leftover. The 2026-09-21 site
audit (lane 01M2XC8RN9) recorded it as an open question rather than a defect for exactly that
reason, and it has sat open since. Ambiguity of this shape is the kind the next person resolves on
a hunch — which, on the surface a launch is judged by, is the wrong way for it to get decided.

## Problem

Ship `prefers-color-scheme` before launch, or state that light-only is the launch surface?

The scheduling answer ("no time") is not admissible on its own, and measurement says it would be
close to wrong. Sweeping the prerendered marketing routes with the attribute flipped to `dusk`
(2026-09-21, this lane) gives **2 AA failures on `/`** — `gs__cmd-label` at 4.43 against the dusk
paper, twice — and **zero on `/watch` and `/docs`**. The dusk palette is in good shape. The cost is
not the tokens.

## Decision

**The public site ships light-only at launch.** The `data-theme="light"` pin and the
`color-scheme: light` declaration stay, and they are documented at the pin as deliberate rather
than provisional.

The reason is the hero, not the palette. **The homepage's office still is a photograph of a
daylight office** (`brand/office-still.png`, `StreamSection.tsx`), and it is the largest thing
above the fold on a phone. A dark page around a bright daylight photograph is the same
incoherence [ADR 428](428-one-office-above-the-fold.md) removed from this exact section three days
ago — two rooms in one viewport, each internally reasonable. Honouring `prefers-color-scheme`
today would hand roughly half of all visitors that composition on the first screen of the site,
and no amount of token work fixes it, because the mismatch is in the photograph.

Three things are therefore true at once and are stated together so the next reader does not have
to rediscover them: the dusk tokens are healthy, the site is light-only, and that is because of an
image rather than a palette.

## Consequences

- A visitor who prefers dark gets a light site. The `color-scheme: light` meta means the browser
  paints its own chrome — form controls, scrollbars — to match, so it is a consistently light
  page rather than a light page inside dark furniture. That is the whole mitigation and it is a
  real but modest one.
- `tokens.css`'s "a future toggle" comment is now a pointer to this ADR rather than an unowned
  promise. The dusk block stays: it is live on `/live` via the `.lc` scope, so it is not dead code
  kept for a someday.
- **The a11y gates measure one theme.** `pnpm a11y:check` and `pnpm a11y:targets:check` sweep the
  site as served — light. A dark path would double both gates' surface, and the dusk marketing
  routes are unmeasured in CI today (the two failures above were found by a hand-run with a
  patched dist, not by a gate). That is a consequence of this decision, not an argument for it:
  the work is small and it is simply not owned by anyone while the site is light-only.
- This is a launch-surface decision and not a product principle. `/live` is and remains its own
  theme system.

### What would reopen this

Not a preference and not a vote — a specific, checkable set. All three, because any one alone
leaves the hero mismatched or the verdict unmeasured:

1. a dusk office still that reads as the same room as the daylight one;
2. the office scene's dusk lighting exercised on the landing hero the way `?light=` already pins
   `/office-preview` (ADR: the scene reads tokens per host, so this is real work, not a swap);
3. both themes swept by `pnpm a11y:check` **and** `pnpm a11y:targets:check`, with the 2 known dusk
   rows on `/` fixed.

## Observability & Evaluation

- **Traces:** n/a — this decision changes no daemon behaviour and emits no act. It is a property of
  the served HTML, so the two falsifiers below read that directly.
- **Eval:** n/a — no model behaviour is involved. The checkable claims are measurements, and both
  carry a dated baseline below.
- **Experiment:** n/a — a preference split would measure which theme visitors like, which is not the
  question. The decision turns on the hero's daylight photograph, and no amount of preference data
  makes a bright still sit well in a dark page.

- **Falsifier for "the site is light-only":** `curl -s https://musterd.io/ | grep -o 'data-theme="[a-z]*"'`
  returning anything but `light`, or any `prefers-color-scheme` block in the served CSS outside
  `.lc`.
- **Falsifier for "the dusk palette is healthy":** re-run the hand measurement —
  `cp -r packages/web/dist/client /tmp/dark && find /tmp/dark -name '*.html' -exec sed -i '' 's/data-theme="light"/data-theme="dusk"/g' {} \; && node scripts/a11y/contrast-gate.mjs --static-only --dir /tmp/dark --routes /,/watch,/docs`.
  Baseline 2026-09-21: `/` 2 below AA (both `gs__cmd-label`, 4.43), `/watch` 29 measured 0 below,
  `/docs` 10 measured 0 below. More than 2 rows on `/`, or any row on the other two, means the
  dusk palette has drifted while nobody was looking at it — which is the standing risk of keeping
  a palette that no gate sweeps.
