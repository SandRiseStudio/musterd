# The Twitch channel — what a stranger sees, measured

Measured on the public channel pages (2026-09-16; falsify: open them logged out and compare), twitch.tv/sandrise_ai has 5 followers, sits in Twitch's largest category, keeps no recording of any session, and its only permanent content is seven clips from the account's life before musterd — so a stranger finds it only if sent to it. <!-- claim: defect -->

## Why this page exists

nick asked (2026-09-16) how the stream gets more viewers, engagement and followers/subscribers. Nobody had looked at the channel the way a stranger arrives at it. This page is that look, so the next person does not re-derive it — and so the leverage order below is argued from what was seen, not from general Twitch advice. The copy that fixes the strings lives in [the channel copy spec](../design/twitch-channel-copy-spec.md); the owned front door is the [/watch spec](../design/watch-page-copy-spec.md).

Every row here was read off the public channel pages (`/about`, `/videos`, `/clips`, `/schedule`) while logged out, so it is what a first-time visitor gets. The Creator Dashboard was not opened; anything only visible there is marked as such. The stream infrastructure itself — what the machine does — is [broadcast-stream](broadcast-stream.md) and not repeated here.

## What the channel showed on 2026-09-16 (falsify: open each page logged out and compare)

| Surface | Observed | Why it matters to a stranger |
| --- | --- | --- |
| Followers | **5** | The number every directory card shows beside the name. |
| Category | **Just Chatting** | Directory browse sorts by concurrent viewers, descending. Just Chatting is Twitch's largest category by live channels; a 0–2 viewer stream in it is thousands of cards deep. Software and Game Development is a small category browsed on purpose by the people the stream is for. |
| Title | `Coffee & musterd - watch musterd agents build the platform live` | The title is the directory card's whole text after the name. Its first three words carry nothing a stranger can act on, and "platform" is a brand.md §5 Not-word for Harness — the product's own name for itself is "coordination layer". |
| Tags | Not visible on the public pages; assumed unset (dashboard-only — **verify there**). | Twitch allows 10 and they are a directory filter and a search input. |
| Videos / past broadcasts | **Empty.** "Recent broadcasts" and "All videos" both show nothing, two hours after a 46-minute stream ended. | VOD storage is off, so **no session survives its own end**. Nothing to clip from afterwards, nothing to link to, nothing to search. |
| Clips | **7**, every one titled `nix pix`, 1–4 views each, **6–7 years old**, clipped by four accounts. | The account's prior life. The only permanent content on the channel is not about musterd, the same way the domain arrived with a gambling title ([url-canonicalisation](url-canonicalisation.md)). A stranger clicking Clips learns the wrong thing. |
| Schedule | Empty; "last streamed 2 hours ago". | No recurring block, so Twitch can neither surface an upcoming stream nor notify followers ahead of one. The /watch spec's rule holds: publish no schedule until the team keeps one. |
| About | `sandrise_ai streams Just Chatting.` — **no panels.** | Panels are where a landed stranger finds what this is, where the code is, and where to start. There is nothing to find. |
| Subscribe button | **Absent** (Follow and Turn on Notifications only). | Subscriptions exist only on Affiliate and Partner channels. No button means the account is neither. |

## Subscribers are not possible yet (2026-09-16; falsify: the Achievements card in the Creator Dashboard lists the Affiliate criteria and how many are met) <!-- claim: other -->

Twitch's published Affiliate criteria are all four of: **50 followers**, **500 total minutes broadcast** in the last 30 days, **7 unique broadcast days** in the last 30 days, and an **average of 3 concurrent viewers** in the last 30 days. At 5 followers the first is a tenth of the way there, and with no recorded sessions the other three are unmeasured from outside. Of the three things nick asked for, followers are the only one the channel can acquire today; subscribers are gated behind followers and consistency, in that order.

## The leverage order, argued

Cheapest and highest-leverage first. The first two are dashboard toggles; the rest are copy, and the copy is specified in [the channel copy spec](../design/twitch-channel-copy-spec.md).

1. **Turn on VOD storage, and clips.** Every session produces nothing that outlives it (2026-09-16; falsify: the public `/videos` page lists a past broadcast). Live concurrents for a niche engineering stream will stay small whatever the category; the return is that a session can be clipped at all. Do this before the next stream, not after — a broadcast that was not recorded cannot be clipped from. ~~"the asymmetric return is each session becoming a durable artifact that can be clipped, linked from a post, and found later" (2026-09-16)~~ CORRECTED the same day — a stored past broadcast is **not** durable on this channel; see [retention](#a-stored-vod-is-not-a-durable-artifact-it-is-deleted-after-7-days-on-this-channel-2026-09-16-falsify-twitchs-on-demand-content-help-article-states-the-retention-tier-for-each-account-type) below, and turn the two settings on together with the export path or the recording is gone in a week. <!-- claim: defect -->
2. **Move the category to Software and Game Development.** One dropdown. It changes which directory the card appears in and how deep. The ratio between the two categories' live-channel counts was not measured tonight (the directory pages render nothing readable to a logged-out fetch); the direction is not in doubt, the magnitude is unrecorded — measure it before quoting a number.
3. **Set all 10 tags.** Unset tags are a discovery input left at zero.
4. **Retitle so the first four words work on a stranger.** The card is read left to right and truncated; lead with the searchable claim.
5. **Fill three About panels.** What this is, where the code is, where to start.
6. **Decide the schedule question honestly.** Twitch rewards long, frequent, predictable streams; the team works in sessions. Either commit to recurring blocks that will actually be kept, or accept the point below and let the schedule stay empty rather than invented.

## A stored VOD is not a durable artifact — it is deleted after 7 days on this channel (2026-09-16; falsify: Twitch's On-Demand Content help article states the retention tier for each account type) <!-- claim: defect -->

This corrects the leverage-order item above, written earlier the same day. Turning Store Past Broadcasts on does not make a session permanent; it buys a retention window, and this channel is on the shortest one.

| Account type | Past broadcasts kept |
| --- | --- |
| Partner, Prime, Turbo | 60 days |
| Affiliate | 14 days |
| **Everyone else — including this channel** | **7 days** |

The channel has no Subscribe button, so it is neither Affiliate nor Partner ([above](#subscribers-are-not-possible-yet-2026-09-16-falsify-the-achievements-card-in-the-creator-dashboard-lists-the-affiliate-criteria-and-how-many-are-met)) — 7 days. Two consequences the first draft missed:

- **Clips, not VODs, are the durable asset.** Clips are stored indefinitely at every tier. A VOD is the week-long window in which a clip can still be cut. That strengthens rather than weakens the reading below — the clip was already named the acquisition asset; what is new is that the VOD it comes from expires.
- **Permanence off Twitch needs the export.** A Twitch account can be connected to YouTube, after which Video Producer offers **Export** on each video and uploads it without a local download. Without that connection, or a manual download, the recording is gone in a week whatever the toggle says.

Also load-bearing and easy to get wrong: **Uploads are Affiliate-only** (2026-09-16; falsify: the upload button appears above the video list in Video Producer). Externally edited video cannot be put on the channel at all until Affiliate, so YouTube is the home for anything cut outside Twitch until then. <!-- claim: other -->

## Where these settings actually live (2026-09-16; falsify: open each path — a moved menu is what would disprove it) <!-- claim: other -->

Recorded because all four were re-derived by hand once and none of them is where a first guess puts it.

| Thing | Path |
| --- | --- |
| Title, **category** and tags — one dialog | Creator Dashboard → **Stream Manager** → Edit Stream Info (`dashboard.twitch.tv/u/<channel>/stream-manager`). Not under Settings, which is where everyone looks first. Sticky between streams; edits apply immediately mid-stream. |
| Profile bio (the About description) | **account** settings: `twitch.tv/settings/profile` → Bio, 300 characters |
| Store Past Broadcasts, Always Publish VODs, Excluded Categories | Creator Dashboard → Settings → **Stream** (`dashboard.twitch.tv/u/<channel>/settings/stream`) |
| Clip Settings | the same page, **Clip Settings** section (`link.twitch.tv/ClipSettings`) |
| Clips Manager — where the old clips get deleted | Creator Dashboard → **Content → Clips** |
| Video Producer — download, Export to YouTube, publish/unpublish | Creator Dashboard → **Content → Video Producer** |
| YouTube connection | **account** settings, not the Creator Dashboard: `twitch.tv/settings/connections`, under Recommended Connections |

Two traps stated by Twitch and worth repeating (2026-09-16; falsify: the On-Demand Content help article drops either warning): Store Past Broadcasts is **web-only**, absent from the mobile app, and a broadcast that was not saved **cannot be recovered by Twitch Support** — the setting must be on before going live, not after. <!-- claim: other -->

## The tags in use describe the medium, not the content — measured against the live directories (2026-09-16; falsify: open `twitch.tv/directory/all/tags/<tag>` and count the cards) <!-- claim: defect -->

Each Twitch tag has its own public directory, so "is this tag worth a slot" is answerable rather than arguable. Live channels on page 1, read logged out:

| Tag | Live channels | Top channel |
| --- | --- | --- |
| `coding` | 30+ (page full) | 506 viewers |
| `programming` | 30+ (page full) | 109 |
| `softwaredevelopment` | 15 | 45 |
| `claude` | 7 | 19 |
| `buildinpublic` | 7 | 2 |
| `opensource` | 5 | 116 |
| `aiagents` | 2 | 1 |
| `agents` | **1 — this channel** | 2 |

The channel's ten at the time of measuring were `Coffee`, `AI`, `agents`, `Chatting`, `Claude`, `musterd`, `building`, `Broadcast`, `product`, `live`. Five of them — `Coffee`, `Chatting`, `Broadcast`, `product`, `live` — describe the medium or the host's mood and cannot narrow who arrives; every stream on Twitch is `live` and a `Broadcast`, and `Chatting` pulls back toward the category the channel is leaving. `building` collides with Minecraft. `agents` is not ownable, it is **empty**: one live channel, this one, which is a directory nobody browses.

What the numbers show that reasoning alone did not: the set has **no volume tag at all** (none of `coding`, `programming`, `softwaredevelopment`), and its one specific tag is `Claude` — which is the strongest slot on the board, seven channels deep and exactly the audience, and was already there by luck rather than choice. The replacement set is [copy spec §4](../design/twitch-channel-copy-spec.md).

**A tag earns a slot only if a stranger might filter for it and it narrows who arrives.** Twitch applies the category tag automatically, so the category name is never worth a slot, and language is a separate directory control rather than a tag.

**The measurement loop exists.** Twitch's Discovery Analytics reports which custom tag a viewer arrived through, so which of these ten actually carries the channel is measurable after a few streams rather than permanently a matter of taste.

## A tag-count query that ignored its own filter read as clean data (2026-09-16; falsify: re-run the same GraphQL query across two obviously different tags and compare the totals) <!-- claim: defect -->

The counts above were first taken from Twitch's GraphQL endpoint, one query per tag. It returned **identical channel counts and identical viewer totals for all sixteen tags** — the `tags:` argument was ignored and the same global top-30 came back every time. Had the tags been even roughly similar in size, that would have passed as a clean measurement and half this page would be wrong.

The tell was that the numbers were identical to the digit, which is why the check that caught it was comparing across tags rather than sanity-checking one. Recorded because it is the [wiki README](README.md) rule-3 shape in a fresh disguise: an instrument that answers the same way whether or not the claim holds. The directory pages, read as rendered HTML, were the instrument that could fail.

## The part that is not a Twitch setting (2026-09-16; falsify: after the settings above land, compare the referrer mix on the /watch page and the channel's own analytics — if Twitch directory browse is a majority source, this reading is wrong) <!-- claim: other -->

Nobody browses Twitch to find a software stream. For this channel, directory discovery is hygiene, not growth. The realistic path is **off-Twitch → Twitch**: a thirty-second clip of nine agents handing work to each other and one of them declining a merge is a post on X, Hacker News, r/programming or r/LocalLLaMA, and the stream is where that post sends people. That ordering is why item 1 above outranks item 2 — the clip is the acquisition asset and the category is where the arrivals land.

The owned half of that path is the [/watch page](../design/watch-page-copy-spec.md), spec'd 2026-09-16 and unmerged at the time of writing (PR #1468): one public, prerendered page whose whole job is to be the stream's front door and to rank for "watch agents build".

## What was not measured

- Live-channel counts per category (see item 2).
- Anything dashboard-only: tags as set, VOD/clip toggles as set, the Achievements card, past stream analytics. The rows above infer those from the public result; the dashboard is where the inference gets confirmed or corrected.
- Where the 5 followers came from.
- Whether a YouTube account is already connected, and whether it is verified (YouTube caps unverified uploads at 15 minutes, which is shorter than a typical session).
