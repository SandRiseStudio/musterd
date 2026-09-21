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

**~~Tap targets in the shared nav and footer are 21–22px tall at phone width — a WCAG 2.2 AA 2.5.8 failure (2026-09-21, lane 01M32GF49Z)~~ WRONG ABOUT THE SPEC, corrected 2026-09-21 (lane 01M32HG5GJ): the sizes are real and they CONFORM. 2.5.8 exempts an undersized target that nothing crowds, and nothing sits within 12px of these centres, so the spacing exception applies. Falsified by measurement, not argument — the built nav shrunk back to 20px and re-swept still passes, as `spacing` (2026-09-21; falsify: set `min-height: 20px` on `.sitenav__links a`, rebuild and run `pnpm a11y:targets:check` — a row reading `below AA 2.5.8` rather than `HOUSE FLOOR` disproves it).** The measurements stand: nine on the homepage, six on /watch, all from the shared chrome — nav `Docs` 33×22, `Watch` 42×22, `GitHub` 45×22; footer `GitHub` 51×21, `SPEC` 34×21, `ROADMAP.md` 86×21, the height coming from the line box alone with no vertical padding on the link. So does the fix: 24px is the line this team set for its own chrome, because a 21px link on a phone is missed twice before it is hit and the iOS HIG asks 44pt. What changed is what it is CALLED. The gate now enforces both floors and labels every row with which one it is, and `target-house-floor-nav.html` is the control that keeps them apart — reporting a house preference as a standards violation would be a false accessibility claim about our own site, in our own CI. `pnpm a11y:check` covered 14 routes and passed throughout, because target size is a computed-layout property at a specific viewport and nothing in the suite measured layout at phone width; that half of the finding was right, and `pnpm a11y:targets:check` is the gate that closes it. <!-- claim: other -->

**~~/watch asserts `isLiveBroadcast: true` to crawlers unconditionally (2026-09-21, lane 01M32GFMZ8)~~ FIXED IN THE SOURCE 2026-09-21, and NOT YET LIVE — the property is gone from the node, and musterd.io still serves it because a merge is not a deploy (falsify the fix: a build of `main` whose `packages/web/dist/client/watch/index.html` contains `isLiveBroadcast` disproves it. Falsify the DEPLOY separately: `curl -s https://musterd.io/watch | python3 -c "import sys;h=sys.stdin.read();print(h.count('isLiveBroadcast'), h.count('BroadcastEvent'))"` printing anything but `0 1`).** `brand/siteMeta.ts` emitted it into the prerendered `BroadcastEvent`. Every other liveness claim on that page was built to refuse to assert what it cannot read; this was the single exception, and it was the one surface search engines and social unfurls read, on a page that is dark most hours of most days. The node still names the channel — omitting the property says unknown, which is what prerender time honestly knows, and it is not required of a `BroadcastEvent`.

**The falsifier above is two falsifiers now, and that is the lesson.** As first written it was one `curl` against the live site, which cannot tell "the fix failed" from "musterd.io is serving an older bundle" — and the second is what was actually true. dolly caught it in a peer read (2026-09-21; falsify: point any single falsifier at a deployed URL and check whether a stale deploy and a failed fix produce the same reading — if they differ, this claim is wrong) and measured both sides: the deployed page had the property, a local build of the same commit had none. A falsifier aimed at a DEPLOYED artifact silently tests the deploy pipeline as well as the claim, so it must either pin the build or say which of the two it is measuring ([ADR 308](../decisions/308-public-site-deploy-authorization.md): landed and live are different facts). Counting `BroadcastEvent` alongside it is what distinguishes "property removed" from "node gone entirely", which the bare grep also could not see. <!-- claim: other -->

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
