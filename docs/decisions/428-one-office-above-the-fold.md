# 428 — One office above the fold: the stream is the proof, the still is its offline state

- Status: proposed
- Date: 2026-09-21
- Lane: `01M32GK3SZ`
- Supersedes: the section-order and office-section decisions in [homepage-copy-spec](../design/homepage-copy-spec.md) §3, §4.2 and §5

## Context

[ADR 302](302-public-site.md) put a Twitch player on the homepage: a visitor who merely sees it counts as a concurrent Twitch viewer through muted autoplay, which is why the embed exists at all and why it is injected only once an IntersectionObserver says the box is genuinely on screen.

On 2026-09-18 the homepage gained a second office block above it — `OfficeProof`, a still of the office with the caption "A still from the stream." Its reason was good and is recorded in homepage-copy-spec §5: the Twitch embed renders Twitch's own offline card, a black rectangle, whenever the channel is dark, and for weeks that black rectangle was a stranger's first impression of the project. Mounting the live office canvas instead was measured and rejected — ~51 ms per draw on a GPU-less box, ~34 ms of it irreducible Skia cost (lane `01M2TM6C6XF6`, #1564) — so a static capture was the available fix.

The 2026-09-21 site audit (lane `01M2XC8RN9`, #1596) opened the page at 390×844 on a live channel and measured the two blocks together for the first time: the still at document y=658, the player at y=1261, 418px apart, an 800px span inside an 844px viewport. A stranger saw the same room twice — a photograph captioned as a still, and 418px below it the actual live office.

Neither block was wrong. Each had a written rationale and each rationale held. **The defect was only in their composition, and reasoning recorded per-component does not compose by itself.**

## Problem

Exactly one of the two blocks is informative in any given channel state:

- **Dark** (most hours of most days) — the still carries the page and the player is a black card. This is the case §5 was written for.
- **Live** — the still is a worse copy of the thing directly below it, and the page spends 185px and a caption narrating a stream the reader can already watch.

The page also buried its liveness: `StreamSection` used a hand-built `<iframe>`, which is cross-origin and exposes nothing, so unlike `/watch` it could not tell which of the two states it was in.

A further constraint rules out the obvious fix. **Liveness is only knowable _through_ a constructed player.** `twitchLiveness.ts` reads the SDK's ONLINE/OFFLINE event, which requires the player to exist; there is no credential-free way to ask Twitch beforehand. So "don't mount the player when dark" needs an answer before the question can be asked, and "hide the still once live" shifts ~250px of content two to three seconds after load.

## Decision

**The homepage has ONE office, it is the stream, and it sits directly under the hero.**

1. `OfficeProof` is deleted. Its picture, its two load-bearing closing sentences ("This is our team. Yours is what `npx @musterd/cli init` starts" — [ADR 320](320-naming-over-containment.md) §1) and its constraints move into `StreamSection`, which is now the page's second section, after `LightHero` and before `WhatIs`.
2. **The still is the player's offline state, not a separate figure.** One fixed-aspect slot: the player always mounts, and the still is absolutely positioned over it whenever liveness is not `live`. The box never changes size, so nothing below it moves — measured CLS 0.0047 across a full load.
3. **`unknown` shows the still.** It is the state the prerendered HTML ships and the one a reader with a blocked SDK keeps, so it must be the state that claims least. The caption rendered beside it says the channel is dark between sessions and that the work lands in the open repository either way — true whichever state actually holds, per watch-page-copy-spec §2.
4. **`StreamSection` constructs a `Twitch.Player` rather than a hand-built `<iframe>`**, the same mechanism `/watch` uses, so it can read liveness at all. Measured 2026-09-16: the SDK emits the same origin, path and parameters, and additionally sets `allow="autoplay; fullscreen"`, which the hand-written iframe never carried.
5. **The hero keeps the first screen.** The install command is still the one thing on this page with a job, and the stream is quiet by construction — a contained slot in the narrower of two columns, capped at 34rem, never a hero video.

## Consequences


- **2026-09-21 — the still is now the player's THIRD state, not its second** (lane 01M32JE1ZP, the
  follow-up this ADR named). A dark channel plays a hand-curated Twitch collection of past
  sessions, so the common case shows the team actually working rather than a photograph of the
  room they work in. The still did not go away and could not: it remains beneath the replay and is
  what a reader gets when the SDK is blocked, the collection is empty or private, or the swap is
  refused — the §2/§3 guarantee is unchanged. A collection id is public, which is why this needed
  no Twitch API credential, no build-time network call and no runtime endpoint on a prerendered
  page; the cost is that the collection is curated by hand and goes stale silently. What it cannot
  do is look broken. Falsifier: stop the stream, load musterd.io, and find a static image where
  footage should be — or find a replay captioned as anything but a replay.
- The ADR 302 viewer-count precondition is preserved and slightly strengthened: the IntersectionObserver gate is unchanged, and the SDK grants the autoplay permission the hand-built iframe was missing.
- The still is now **above** the fold, which inverts its loading strategy: `fetchPriority="high"` and eager, where it was `loading="lazy"` below the fold. It is a 166 KB PNG and is now the page's first image.
- The page is 445px shorter (3085 → 2640 at 390px) and has one fewer component.
- `homepage-copy-spec` §3, §4.2 and §5 are superseded and annotated in place; the constraints they carried survive as assertions in `landing.test.ts` and `streamSection.test.ts`, which moved with the picture.
- **A dark channel still shows a still, not a replay.** Playing the latest VOD when the channel is dark would be better — it is the difference between "here is a photograph" and "here is what they did yesterday" — but the Twitch embed cannot find the latest VOD without a Helix credential, and this repo has none. Recorded as a follow-up rather than done: lane `01M32JE1ZP`.

## Observability & Evaluation

**Traces.** n/a — this decision changes a prerendered marketing page. It emits no telemetry, reaches
no daemon, and logs nothing; the only runtime signal is the Twitch SDK's ONLINE/OFFLINE event, which
stays inside the page and is never recorded.

**Eval.** Dataset: the homepage at 390×844 and 1280×900, in each of the three liveness states
(`live`, `dark`, `unknown` — the last reachable by blocking `player.twitch.tv/js/embed/v1.js`).
Baseline before this change, measured 2026-09-21 on a live channel: two offices rendered, spanning
800px inside an 844px viewport. After: one office in every state, document height 3085 → 2640 at
390px, cumulative layout shift 0.0047 across a full load, and the prerendered HTML carrying the
still plus a caption that does not assert liveness. Pinned by `landing.test.ts` (no second office
block, the still's constraints) and `streamSection.test.ts` (the deferral, the SDK, the overlay).

**Experiment.** n/a — no flag and no split. The defect was a composition measured at one viewport
size, and the fix is verified by re-measuring it rather than by comparing populations.

## Falsifier

Open musterd.io at 390×844 with the channel live and confirm exactly one office is rendered; then
block `player.twitch.tv/js/embed/v1.js` and confirm the still is what remains, with a caption that
does not claim the channel is live.
