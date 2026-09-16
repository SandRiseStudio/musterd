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

1. **Turn on VOD storage, and clips.** Every session produces nothing that outlives it (2026-09-16; falsify: the public `/videos` page lists a past broadcast). Live concurrents for a niche engineering stream will stay small whatever the category; the asymmetric return is each session becoming a durable artifact that can be clipped, linked from a post, and found later. Do this before the next stream, not after — a broadcast that was not recorded cannot be clipped from. <!-- claim: defect -->
2. **Move the category to Software and Game Development.** One dropdown. It changes which directory the card appears in and how deep. The ratio between the two categories' live-channel counts was not measured tonight (the directory pages render nothing readable to a logged-out fetch); the direction is not in doubt, the magnitude is unrecorded — measure it before quoting a number.
3. **Set all 10 tags.** Unset tags are a discovery input left at zero.
4. **Retitle so the first four words work on a stranger.** The card is read left to right and truncated; lead with the searchable claim.
5. **Fill three About panels.** What this is, where the code is, where to start.
6. **Decide the schedule question honestly.** Twitch rewards long, frequent, predictable streams; the team works in sessions. Either commit to recurring blocks that will actually be kept, or accept the point below and let the schedule stay empty rather than invented.

## The part that is not a Twitch setting (2026-09-16; falsify: after the settings above land, compare the referrer mix on the /watch page and the channel's own analytics — if Twitch directory browse is a majority source, this reading is wrong) <!-- claim: other -->

Nobody browses Twitch to find a software stream. For this channel, directory discovery is hygiene, not growth. The realistic path is **off-Twitch → Twitch**: a thirty-second clip of nine agents handing work to each other and one of them declining a merge is a post on X, Hacker News, r/programming or r/LocalLLaMA, and the stream is where that post sends people. That ordering is why item 1 above outranks item 2 — the clip is the acquisition asset and the category is where the arrivals land.

The owned half of that path is the [/watch page](../design/watch-page-copy-spec.md), spec'd 2026-09-16 and unmerged at the time of writing (PR #1468): one public, prerendered page whose whole job is to be the stream's front door and to rank for "watch agents build".

## What was not measured

- Live-channel counts per category (see item 2).
- Anything dashboard-only: tags as set, VOD/clip toggles as set, the Achievements card, past stream analytics. The rows above infer those from the public result; the dashboard is where the inference gets confirmed or corrected.
- Where the 5 followers came from.
