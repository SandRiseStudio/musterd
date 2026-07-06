# 097 — The `/live` stage chrome retheme: dusk → daylight

- Status: accepted — built 2026-07-06 (`live/Live.css`'s `.lc` token block, sky gradient, and two
  theme-blind hardcoded overlays flip to daylight; the office-canvas dusk pin is removed so the scene
  now inherits the same light tokens as the chrome)
- Date: 2026-07-06

## Context

ADR 096 made the office scene itself theme-aware and flipped the site default to light, but explicitly
scoped the `/live` and `/office-preview` stage chrome (`.lc` in `Live.css`) out of that change — its
dusk gradient and `--lc-*` tokens were pinned so the scene stayed coherent with its dusk surroundings,
deferring the chrome retheme to "PR 4."

## Problem

Retheme the `/live` + `/office-preview` page chrome to daylight so the whole surface — stream console,
topbar, forms, roster, audit log, approval queue, and the office canvas itself — reads as one coherent
daylight office, not a daylight canvas floating in a dusk frame.

## Decision

**Flip the `.lc` token block to daylight values (mirroring `tokens.css`'s light semantic tokens) and
delete the dusk pin on the office canvas tokens.** Auditing `Live.css`'s ~2200 lines found the palette
is overwhelmingly token-driven (326 `var(--lc-*)` reads vs. 31 raw hex, and `ApprovalCard.css` /
`ApprovalQueue.css` are 100% token-driven — zero raw hex), so the token-block swap alone recolors nearly
everything correctly:

- `--lc-ground/-2`, `--lc-surface/-2/-3`, `--lc-text`, `--lc-dim/-muted/-faint`, `--lc-border/-2`,
  `--lc-accent/-bright`, `--lc-success/-danger/-info/-handoff/-agent/-human` all take their daylight
  equivalents (same values as `tokens.css`'s `:root[data-theme="light"]` block, so the two token sets
  stay in lockstep rather than drifting into a third palette).
- The `.lc` sky gradient (dusk violet → amber) becomes the same daylight sky (`--sky`, tokens.css).
- The `--floor`/`--floor-2`/`--wood`/`--couch` override that pinned the office canvas to dusk (ADR 096)
  is **deleted** — with no override, `getComputedStyle(host)` reads the light `:root` values, so the
  canvas and the chrome around it are now one theme by construction, not by two token sets kept in sync
  by hand.

Auditing the raw-hex outliers found exactly two that assumed a dark ground and needed a manual fix
(the rest are avatar-initial text on colored member-hue circles or the DOM speech bubble's fixed dark
chip — both correctly theme-independent, left unchanged):

- `.lc__topbar`'s background was `rgba(29, 22, 34, 0.5)` (a dusk-purple frost) → a cream frost
  (`rgba(255, 250, 240, 0.6)`).
- `.lc-form__field input`'s background was `rgba(0, 0, 0, 0.22)` (a dark inset "well" against dusk) →
  `rgba(0, 0, 0, 0.045)`, a light inset well with legible contrast against dark ink text.
- The `.lc-constellation` panel's decorative top wash (a violet radial, `rgba(150, 122, 224, 0.16)`)
  became a soft sunlit highlight (`rgba(255, 244, 214, 0.4)`) — the amber horizon glow beneath it was
  already daylight-appropriate and unchanged.

Left unfixed by design: a handful of `rgba(255,255,255,0.04–0.07)` "lift" overlays on icon buttons and
raised rows. These were tuned to lift a surface off a _dark_ ground; on cream they're a near-invisible
sliver rather than broken, and `--lc-surface-2/-3` already provide the raised-state contrast on their
own. Not worth chasing given the effort/visibility ratio.

## Consequences

- `/live` and `/office-preview` are now visually coherent with the rest of the site's daylight default
  (ADR 096) — same sky, same ink, same accent, same office floor.
- The office canvas no longer needs a page to explicitly pin its palette; any future page that mounts
  it inherits whatever theme cascades naturally. Removing the override is a net simplification, not
  just a recolor.
- Verified 2026-07-06 via headless-Chrome screenshots of `/live` (connect gate) and `/office-preview`
  (full choreography) pre/post-fix — confirmed the topbar and input fixes actually resolved the muddy
  overlay, not just tokens. Full `format:check` gate, typecheck, production build (6 pages prerender),
  and the 66-test office-scene suite all pass unchanged.

## Observability & Evaluation

n/a — a CSS/token retheme of human-facing page chrome. It emits no coordination acts, joins no team,
and adds no spans — there is no agent behavior to eval or experiment on. Success was verified visually
(screenshot comparison across the affected routes) plus the existing mechanical gates (typecheck,
build, tests, format:check).
