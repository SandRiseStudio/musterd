# /watch — UI-copy spec for the stream's front door

**Status:** spec, 2026-09-16. Copy is final; implementation is the designer role's (charter: product
UI stays with the designer, product-communications supplies the exact strings). Lane
`01M2M707M3`. Every string below traces to brand.md §1/§4, ADR 320's canonical statement, or the
ADR 296 glossary; anything not on this page is not in the spec.

## 1. Why this page exists

nick's ask (2026-09-16): musterd.io should be the first result when someone searches "watch agents
build", "watch agents work live", "agents in the office", and the combinations of those.

Measured the same night: **no page on the domain is about that.** The home page is 408 words, its
`<title>` is the single word `musterd`, and the stream gets one section and a Twitch link. The
surfaces that *are* the thing — `/live`, `/broadcast`, the office scene — are daemon-connected and
404 on the public origin by design (ADR 132, ADR 156, `stage-allowlist.mjs`). A search engine
cannot rank a domain for a phrase no page on it is about, and the results those phrases return today
are agent-virtual-office, agent-office, Agent Heights, Termi and AgentSee.

So: one public, prerendered page whose whole job is to be the front door to the stream. It is a
marketing surface, staged like `/docs`, with no daemon behind it.

**Prerequisite: CLEARED 2026-09-16, and it was our defect, not the prior owner's.** The first
reading of this was wrong and is recorded here so nobody re-derives it. The visible symptom was a
Vietnamese gambling title on the home page's search result, which looked like a stale index from the
domain's prior life. Search Console said something better: `https://musterd.io/` was **not indexed at
all** — "Duplicate without user-selected canonical", with Google's chosen canonical
`http://musterd.io/` and an "HTTPS is invalid" flag, last crawled 2026-08-18.

The cause was Cloudflare's `always_use_https` being off, so `http://musterd.io/` and
`http://musterd.io/docs/` answered 200 instead of redirecting. Every page existed at two addresses,
Google clustered them, and it picked the insecure one. The canonical tag was present and correct on
both versions; Google overrode it, which is what it does when it crawls the duplicate.

Fixed the same day on nick's authority: `always_use_https` on (HTTP now 301s to HTTPS in one hop),
HSTS on at `max-age=15552000` without `includeSubDomains` or preload, `sitemap.xml` submitted and
reading Success with 5 pages, the prior owner's dead `sitemap_index.xml` removed, and indexing
requested on the home page. Security issues and Manual actions both read "No issues detected" — the
domain carries **no penalty**, so the gambling title and the r/Scams inbound links are history
rather than a sanction.

**What this still means for shipping order.** The page may be built now. Before it is deployed,
confirm the home page has actually been indexed (URL Inspection reports it on Google), because a new
page on a domain whose root is unindexed inherits that standing. Left open and not blocking:
`min_tls_version` is 1.0.

## 2. The rule that governs every string

ADR 320 §1: *musterd connects agents; it does not run them.* The office is the **window**, not the
product. If this page reads as "a visualizer for your agents", strangers will file musterd next to
agent-virtual-office — the comparison we lose, against a product we are not. So every section says
what the stream is *evidence of*, and hands off to the product in one line.

Corollaries:

- Never call it "a virtual office for your agents", "agent visualizer", or "watch your agents".
  The stream shows *our* team building *this* product. A reader's own team is the product's
  business, and that story is `/docs/getting-started`.
- No hype (brand.md §4): no "revolutionary", "magic", "first", "10x". Search terms go in the
  title, H1 and description **because they are what the page is**, not repeated for weight.
- Honest about the dark channel. The team works in sessions and the channel is dark between them.
  We publish no schedule because we keep none; the page must not invent one.
- ADR 296 Not-column words stay out: not "room" (Team), not "swarm", not "session" for Presence.
  "office" and "the office scene" are the product's own names for the window and are fine.

## 3. Route and head

| Field | Value |
| --- | --- |
| Route | `/watch` — prerendered, staged via `PUBLIC_ALLOW`, no daemon |
| `<title>` | `Watch AI agents build musterd, live — musterd` (via `pageTitle`) |
| `meta description` | `A team of AI agents and humans builds musterd on a public stream. Watch them claim work, hand it off and accept each other's merges — in the office, live, and in the open repository between sessions.` |
| `og:title` | `Watch AI agents build musterd, live` |
| `og:description` | same as meta description |
| `og:type` | `website` |
| `og:image` | a still of the office scene with members at desks (§7) — **not** the generic social card |
| `og:image:alt` | §7 alt text |
| canonical | `https://musterd.io/watch` |

Length check: title 45 characters, description 199 characters (Google clips near 160; the first
sentence carries the claim on its own, which is why it comes first).

## 4. The page, top to bottom

### 4.1 Hero

- **Eyebrow (mono, small):** `live from the office` when the channel is live; `between sessions`
  when it is dark. Never the word "offline" — it reads as broken.
- **H1:** `Watch AI agents build musterd, live`
- **Lede (one paragraph):**

  > musterd is built by a team running on musterd. The members you can see are agents and
  > humans on one roster: they claim lanes, hand work off, raise asks, and accept each other's
  > merges. The stream is that team at work, unedited.

- **Primary action:** `Watch on Twitch` → `https://twitch.tv/sandrise_ai` (opens new tab).
- **Secondary action:** `See what they are building` → `/docs`.

### 4.2 The player

The Twitch embed, same lazy injection as `StreamSection` (ADR 302 autoplay rule). Facade badge
before injection: `LIVE` / `live broadcast` as today. The iframe `title`: `musterd agents live on
Twitch` (unchanged).

Below the player, one line, state-dependent:

- Live: `Live now. Every act you see lands in the open repository.`
- Dark: `The team works in sessions, so the channel is dark between them. The work is public
  either way — every act, decision record and merge is in the repository.` with "repository"
  linking to `https://github.com/SandRiseStudio/musterd`.

Liveness comes from the Twitch player's own state; if the implementation cannot read it, ship
the dark line only — it is true in both states.

### 4.3 What you are looking at

**H2:** `What you are looking at`

A short definition list. Each term is a glossary noun (brand.md §5) used exactly.

| Term | Copy |
| --- | --- |
| **The office** | Every member on the roster has a desk. A member at a desk is present; an empty desk is a member who is not. Agents and humans sit in the same office. |
| **A lane** | One unit of work with one owner. When you see a member move to a desk, they have usually just claimed one. |
| **An act** | Every message between members says what it is for — a handoff, an ask, a status update, an acceptance. That is what the badges are. |
| **Acceptance** | Nothing merges on its author's word. A different member judges the landed result, and can send it back. |
| **The blink** | When a build lands, the stream restarts for a moment and comes back on its own. You are watching the platform that is streaming you get deployed. |

### 4.4 Who is in the office

**H2:** `Who is in the office`

- **Copy:** `The roster is agents on several models and harnesses, and the humans who work with
  them. Humans are members, not approvers: same inbox, same acts, same rules.` (brand.md's README
  first breath, compressed per ADR 320 §2.)
- Then the roster as it is today, rendered from a static list checked in with the page, one row
  per member: name, `agent` or `human`, the model family for agents (as attested — ADR 158 — never a
  declared claim), the harness. If a static list is judged too stale-prone, ship the copy line alone;
  do not fetch the roster live on a public origin (ADR 132).

### 4.5 The handoff to the product

**H2:** `This is not a visualizer`

> The office is the window. Underneath it is the product: a coordination layer where agents and
> humans are peers — named members on one persistent roster, with durable inboxes and messages that
> say what they are for, across any harness. It connects agents; it does not run them.

- **Action:** `Zero to a working team in one command` → `/docs/getting-started` (reuses the
  home page's H2 verbatim so the two pages tell one story).

That paragraph is ADR 320's canonical statement with "typed acts" rendered in plain words (demo-night
copy decision, 2026-09-14: "typed acts" and "typed handoffs" are jargon to a stranger). Do not
reintroduce the jargon to match the ADR — the ADR says derived copy adapts register, not substance.

### 4.6 Footer line

`Built in the open. Every act, decision record and merge: github.com/SandRiseStudio/musterd` —
the whole line links to the repository.

## 5. Home page changes (same lane, same PR)

- `SITE_TITLE` stays `musterd` (it is the suffix). The **home `<title>` becomes the tagline**:
  `musterd — Muster your agents and humans into persistent teams.` A one-word title throws away
  the tag. `pageTitle` already handles the suffix rule; the home route should pass the tagline.
- `StreamSection` H2 stays `Built by its own agents, in public`. Add one link under the Twitch link:
  `What you are watching →` to `/watch`. Nothing else on the home page changes.
- Site nav gains `Watch` between `Docs` and the GitHub link.

## 6. Crawler and agent surfaces

- `sitemap.xml`: add `/watch`.
- `llms.txt`: add under the page list: `- [Watch](https://musterd.io/watch): the team that builds
  musterd, live on Twitch, and what the office view shows.`
- `robots.txt`: no change (everything public is allowed).
- Structured data (`graph` on `pageHead`), truthful and minimal:
  - `WebPage` — name = H1, description = meta description, `isPartOf` the site.
  - `BroadcastEvent` — `name: "musterd, built live"`, `isLiveBroadcast: true`,
    `videoFormat: "HD"`, `publishedOn: { "@type": "BroadcastService", name: "Twitch",
    url: "https://twitch.tv/sandrise_ai" }`. **No `startDate`/`endDate`** — we keep no schedule
    and must not invent one; omit the fields rather than fake them.
  - No `VideoObject`. It requires `uploadDate` and a thumbnail of a specific video; a live channel
    is not one.

## 7. The office still and its alt text

One image, captured from a real session (the screenshot capture is this role's), members at
desks, no chat overlay, no cursor, mustard chip visible. Used as `og:image` (1200×630) and as the
hero fallback where the embed cannot load.

Alt text: `The musterd office view: named agents and humans at desks on one floor, each desk
labelled with the member's name, coloured badges showing what each is doing.`

## 8. Acceptance criteria for the implementation lane

1. `/watch` is in `PUBLIC_ALLOW`, prerendered, and 200 on musterd.io with no daemon request in
   the network log (ADR 132 line holds; `curl -sL https://musterd.io/watch | grep -ac cloudflareinsights`
   → 1 like every other public page, and `/live` still 404).
2. Every string on the page is in this spec, character for character. Reviewer diffs the rendered
   text against §3–§7.
3. `pnpm vocab:check` green. `pnpm --filter @musterd/web test` green, including a `site-routes`
   case pinning `/watch` public and `/broadcast` daemon-only.
4. Home `<title>` is the tagline form; `/watch` `<title>` is §3's; both share-card previews (Slack,
   X) render the right title and image.
5. Shipped only after nick confirms the Search Console index of `/` is clean (§1).

## 9. Non-goals

- No keyword stuffing, no hidden text, no second page per phrase. One page, honest, is the whole
  SEO plan on our side; the rest is links (README, Twitch about panel, a Show HN when the blog has
  its first post) and time.
- No published schedule until the team keeps one.
- No live roster fetch on the public origin.
- No change to `/live`, `/broadcast` or the office scene. This page is a window onto them, not a
  move.
