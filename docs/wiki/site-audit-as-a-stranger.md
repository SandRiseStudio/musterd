# Opening the public site as a stranger

What musterd.io and /watch actually look like to someone who arrives with no context, on a phone, and where the reach of an automated gate ends.

## Method, and why the method is the finding (2026-09-21, lane 01M2XC8RN9)

Four changes landed on the public site on 2026-09-18 and none of them was looked at as a page. This is the record of looking. It matters that the states are named: an audit reporting "looks fine" without naming what it opened is indistinguishable from not looking, which is the failure the lane existed to correct.

**States actually opened**, against the deployed `https://musterd.io` (not a dev build), Chrome at 390×844, `deviceScaleFactor 3`, mobile + touch emulation:

| state                 | opened?                    | how                                                          |
| --------------------- | -------------------------- | ------------------------------------------------------------ |
| phone width, 390px    | yes, `/` and `/watch`      | viewport emulation; overflow measured against `clientWidth`   |
| light theme           | yes, both                  | the only theme the site has — see below                       |
| dark theme            | **not applicable**         | the site is light-only by construction                        |
| channel **live**      | yes, both                  | the Twitch channel was genuinely up throughout                |
| channel **dark**      | **no** — substituted       | prerendered fallback read directly; dark branch read in source |

`resize_page` silently clamps the viewport at 500px wide in this setup; only `emulate` with an explicit `viewport` string reaches 390 (2026-09-21; falsify: call `resize_page` with width 390 and read back `document.documentElement.clientWidth` — a value of 390 disproves it). An audit that trusted the resize would have measured a tablet and called it a phone. <!-- claim: defect -->

The channel-dark state was not opened because the broadcast had just been started deliberately. What was read instead is the state a dark-channel reader gets at first paint anyway: the prerendered HTML ships the neutral eyebrow `from the office` and the dark state line, and upgrades only on a real signal. That is a weaker check than a dark channel and is recorded as such.

## The three defects, and what makes each one invisible to the gates

**Tap targets in the shared nav and footer are 21–22px tall at phone width (2026-09-21, lane 01M32GF49Z; falsify: emulate 390×844 and filter `header a, footer a` for `getBoundingClientRect().height < 24` — an empty result disproves it).** Nine on the homepage, six on /watch, all from the shared chrome: nav `Docs` 33×22, `Watch` 42×22, `GitHub` 45×22; footer `GitHub` 51×21, `SPEC` 34×21, `ROADMAP.md` 86×21. WCAG 2.2 AA 2.5.8 sets a 24×24 floor and the iOS HIG asks 44pt. The height comes from the line box alone — there is no vertical padding on the link. `pnpm a11y:check` covers 14 routes and passes, because target size is a computed-layout property at a specific viewport and nothing in the suite measures layout at phone width. <!-- claim: defect -->

**/watch asserts `isLiveBroadcast: true` to crawlers unconditionally (2026-09-21, lane 01M32GFMZ8; falsify: `curl -s https://musterd.io/watch | grep -ao 'isLiveBroadcast":[a-z]*'` while the channel is dark — anything but `true` disproves it).** `brand/siteMeta.ts:292` emits it into the prerendered `BroadcastEvent`. Every other liveness claim on that page was built to refuse to assert what it cannot read; this is the single exception, and it is the one surface search engines and social unfurls read, on a page that is dark most hours of most days. <!-- claim: defect -->

**The homepage renders the office twice in one phone viewport when the channel is live (2026-09-21, lane 01M32GK3SZ; falsify: emulate 390×844 on a live channel and compute `.ss__player` bottom minus `.op__still` top — a span greater than the viewport height disproves it).** The still sits at document y=658, the player at y=1261: 418px apart, an 800px total span inside an 844px viewport. A stranger sees a static picture captioned "A still from the stream. The office is live while the team is working." and, without scrolling, the actual live office moving below it. <!-- claim: defect -->

This one is worth dwelling on because **neither block is wrong and the defect is only in their composition.** The still was added 2026-09-18 precisely because the Twitch embed is a black rectangle on a dark channel, and mounting the live canvas instead was rejected on measurement (~51ms per draw GPU-less, lane 01M2TM6C6XF6). The player carries ADR 302: a visitor who merely sees it counts as a concurrent Twitch viewer through muted autoplay. Each has a written rationale in its own component, and each rationale holds. Exactly one of them is informative in any given channel state — and the two were never opened together, on a live channel, at phone height. Reasoning recorded per-component does not compose by itself.

All three defects share a shape worth naming: **each is in the layer the page's own tests do not model.** One is geometry at a viewport the suite never adopts; one is a machine-readable assertion sitting beside human-readable copy the suite checks carefully; one is a relationship between two components that are each individually correct and individually tested. All three sit outside the reach of a gate that reads strings.

## The site is light-only by construction, and the lane's premise was wrong (2026-09-21)

`routes/__root.tsx:53` pins `data-theme="light"` on `<html>`, and both pages ship `<meta name="color-scheme" content="light">` with `theme-color: #f7efe2`. The dusk palette in `styles/tokens.css` is present and unreachable — its own comment records this as the active default since PR 3b. A reader whose system is set to dark gets the light site.

So "both themes" is not a state musterd.io has, and the audit brief's assumption that dark "is the one a reader gets by system preference and the one nobody checks" does not hold for this site. Whether light-only is right for launch is a decision nobody has written down, not a defect; it is noted here so the next person auditing does not spend the time twice. The [`/live` console](../design/brand.md) is a different surface with different rules.

## What was expected to be wrong and was not

Recording these matters as much as the defects: several are places a previous defect was fixed and the fix holds, and an audit that only lists problems teaches the next reader nothing about where the floor is.

- **No horizontal scroll at 390px on either page**, and the 20px gutter is consistent across every `.shell` section — hero, office, stream, what-is, get-started, footer. `scrollWidth === clientWidth === 390`, zero elements overflowing the viewport box. The "three different ideas about where its left edge was" fixed in #1589 stayed fixed.
- **The homepage Twitch block is not a dead rectangle.** It ships a facade — a play triangle and the label `musterd on Twitch` — but the facade is an IntersectionObserver-deferred placeholder, not a decoy: scrolled into view it swaps to a real `player.twitch.tv` iframe and removes itself (verified 2026-09-21, iframe count 0 → 1, `.ss__facade` gone). The facade is `aria-hidden` and carries no state badge, so it asserts nothing while it waits. An audit that clicked it without scrolling would have wrongly reported a dead control — this one did, and was wrong for about ten minutes.
- **/watch's eyebrow reads real liveness.** It ships neutral `from the office`, and `twitchLiveness.ts` upgrades it to `live from the office` / `between sessions` only once the player's ONLINE/OFFLINE event fires. Observed reading `live from the office` with the channel genuinely up. The contract in `watchCopy.ts` — neutral whenever liveness is unwired — is honoured everywhere on the page except the JSON-LD above.
- **Zero contrast pairs below AA on the homepage**, computed over every leaf text node against its nearest painted ancestor background.
- **Semantics are sound**: one `h1` per page, no heading-level skips, `lang="en"`, the office still carries full descriptive alt text, /watch's five terms are a real `<dl>`/`<dt>`/`<dd>`, and focus is visible (2px solid goldenrod outline).

## Related

- [The Twitch channel audit](twitch-channel-audit.md) — the same exercise for the channel page.
- [`docs/design/watch-page-copy-spec.md`](../design/watch-page-copy-spec.md) §4.1–4.2 — the liveness copy contract this page verified.
