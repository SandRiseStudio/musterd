# Twitch channel — copy spec for the dashboard strings

**Status:** spec, 2026-09-16. Copy is final; the dashboard changes are nick's to make (the channel is
his account). Lane `01M2NVJJ7D`. Every string traces to brand.md §4/§5, ADR 320's canonical
statement, or the [/watch spec](watch-page-copy-spec.md); the measurements it answers are in
[the channel audit](../wiki/twitch-channel-audit.md). Anything not on this page is not in the spec.

## 1. The rules that govern every string

Same as the /watch spec §2, restated because these strings ship to a stranger with no page around them:

- **The office is the window, not the product** (ADR 320 §1). Nothing here may read as "a
  visualizer for your agents". The stream shows *our* team building *this* product.
- **No hype** (brand.md §4). No "revolutionary", "first", "10x", "magic"; no exclamation marks.
- **Honest about the dark channel.** The team works in sessions; the channel is dark between them.
  No schedule is published until one is kept.
- **Glossary terms exact** (brand.md §5). Members, not "users"; the office, not "room"; the
  coordination layer, not "platform".
- **Every claim checkable.** A number in a title is a number that is true at the moment it is set.

## 2. Settings that are not copy, but gate it

| Setting | Value | Why |
| --- | --- | --- |
| Category | **Software and Game Development** | Audit §"leverage order" item 2. |
| Store past broadcasts | **On** | Nothing survives a session today. Clips need a recording to be cut from. |
| Clips | **On**, anyone can clip | The acquisition asset. |
| Old clips | Delete the seven `nix pix` clips (6–7 years old, prior life of the account) | The channel's only permanent content should be about the channel. |
| Schedule | **Leave empty** | /watch spec §2 and §9: publish no schedule until the team keeps one. |
| Always Publish VODs | **On**, Excluded Categories empty | Otherwise stored broadcasts sit unpublished and each needs reviewing by hand. |
| YouTube connection | **Connected and verified** — `twitch.tv/settings/connections` (account settings, not the Creator Dashboard) | Past broadcasts are deleted after **7 days** on this channel ([audit](../wiki/twitch-channel-audit.md)). The connection turns on Export in Video Producer, which is the only way a session survives the week without a manual download. Verify the YouTube account or uploads cap at 15 minutes, shorter than a session. |

**Where these are set.** Category is *not* under Settings — it is stream info, set in **Creator Dashboard → Stream Manager → Edit Stream Info** (`dashboard.twitch.tv/u/sandrise_ai/stream-manager`), which is the same dialog as the title (§3) and the tags (§4). It is sticky between streams and takes effect immediately when edited mid-stream, so all three can be fixed on a live channel without restarting. Everything else in the table above is Creator Dashboard → Settings → Stream, except the YouTube connection, which is account settings. `Cmd+/` opens Dashboard Search if a menu moves.

Two things Twitch states that decide the order: Store Past Broadcasts is **web-only** and must be on *before* going live — an unsaved broadcast cannot be recovered — and **Uploads are Affiliate-only**, so externally edited video cannot live on the channel yet. Clips are stored indefinitely at every tier; the VOD is only the window in which one can be cut.

## 3. Title

**Shipped, and the decision is nick's (2026-09-16):**

    Coffee & musterd - watch musterd agents build the platform live

He read the replacement below and kept this one. It stays; the spec records the channel rather
than arguing with it. Two consequences worth knowing rather than re-raising: past broadcasts
inherit the stream title, so the VOD archive carries it too, and "platform" is a brand.md §5
Not-word for Harness — tolerated here as the owner's call on his own channel, not a precedent for
musterd.io copy, where the gate still applies.

~~The formula below was the spec (2026-09-16)~~ NOT TAKEN the same day. Kept visible because the
reasoning is still the right reasoning for the next title, and because a spec that quietly deletes
what was rejected teaches nobody:

> **Formula:** `<what a stranger can see happening>, live — musterd`. The first four words carry
> the claim; the product name is the suffix, as on every musterd.io page (`pageTitle`). Under 60
> characters so the directory card does not clip it.
>
> | State | Exact string | Chars |
> | --- | --- | --- |
> | Default, any session | `AI agents build their own coordination layer, live — musterd` | 60 |
> | A session with a countable roster | `Watch 9 AI agents review each other's code, live — musterd` | 58 |
> | A session with a specific beat | `AI agents claim their own work and turn it down, live — musterd` | 62 |
>
> The roster number would be set by hand at stream start and must match the office at that moment
> (ADR 158 — attested, not declared). ~~"AI agents hand work off and accept merges"~~ was replaced
> before this section was: merges are this team's incidental instance of acceptance, not the claim.
> ADR 320 §3 makes the claim **peer, not contractor** — a member can claim work, decline it, and
> hold another to acceptance — and a title should carry that, not the git noun for it.

## 4. Tags (all 10)

`Claude` · `AI` · `Coding` · `Programming` · `SoftwareDevelopment` ·
`AIAgents` · `OpenSource` · `BuildInPublic` · `DevLog` · `musterd`

**Partly shipped 2026-09-16.** Verified from outside by which tag directories the channel appears
in — a positive sighting is reliable, so these four are set: `Claude`, `Coding`, `AIAgents`,
`OpenSource`. `Coffee` is gone, confirming the old set was replaced rather than added to.

**Not confirmed either way: `Programming`, `SoftwareDevelopment`, `BuildInPublic`.** The channel
did not appear in those three directories, and that is **not** evidence they are unset — a channel
at ~3 viewers sorts to the bottom of a busy directory and can fall off page 1 entirely, which is
exactly what `Programming` looked like when it was measured at 30+ cards. Absence here is
unreadable, not negative. The reliable check is the Edit Stream Info dialog, or Discovery
Analytics once a few streams have run. Recorded this way rather than reported as a gap, because
"the channel is missing three tags" would have been a finding built on a page-1 cutoff.

Chosen against measured directories rather than intuition — the counts and the method are on the
[audit page](../wiki/twitch-channel-audit.md). Two kinds of tag earn a slot and the set needs both:

- **Volume tags** — `Coding`, `Programming`, `SoftwareDevelopment`. Busy directories; the channel
  sits mid-pack, but that is where browsing happens.
- **Ownable tags** — `Claude`, `OpenSource`, `BuildInPublic`, `AIAgents`. Two to seven live
  channels each, so the channel can be at or near the top of them and stay there. `Claude` is the
  best single tag available: small enough to rank in, and exactly the audience.

`musterd` does no acquisition work and is kept only because it makes the channel findable by name
and the tenth slot has no better claimant. `DevLog` is the one unmeasured entry.

Two corrections to the first draft of this section, both the same mistake — spending a slot on
something Twitch already handles:

- ~~`English`, "because the language tag is a directory filter" (2026-09-16)~~ WRONG the same day:
  language is its own control in the directory, not a tag slot.
- **Never add the category name.** Twitch states that the category tag is applied automatically, so
  `Software and Game Development` as a tag is a wasted slot.

A tag earns its place only if a stranger might filter for it *and* it narrows who arrives. The
words that fail both tests are the ones describing the medium or the mood — see the audit's verdict
on the set this replaces.

## 5. The About surface — bio, then panels

### 5.1 Profile bio (the About description, 300-character cap)

Set at `twitch.tv/settings/profile` → **Bio** — account settings, not the Creator Dashboard.

**Shipped 2026-09-16, and this is the spec:**

> AI agents and humans on one team, building the thing that coordinates them - musterd.io.

88 characters of the 300 available. It keeps the hook — the team is building the thing that runs
the team, which is true and slightly strange, and that is what makes a stranger read the second
line. It sends them to musterd.io rather than the repository, which is the right door for someone
arriving cold.

**What the short form gives up, recorded so the trade is deliberate rather than forgotten:** it
does not carry ADR 320 §3's claim. "The agents are not assigned work — they claim it, hand it off,
and decline it" is the sentence that separates musterd from every "AI teammates" product, and 212
unused characters is room for it. Worth revisiting if the channel ever gets traffic that converts;
not worth re-opening now.

~~The 246-character version below was the spec (2026-09-16)~~ NOT TAKEN the same day, nick's call:

> AI agents and humans on one roster, building the thing that coordinates them. The agents are not assigned work — they claim it, hand it off, and decline it. Peers, not a fleet someone runs. Dark between sessions. github.com/SandRiseStudio/musterd

Neither version uses "coordination layer": ADR 320 §4 forbids the bare term and 300 characters has
no room to qualify it properly. The position survives without the contested label.

### 5.2 About panels (three, in this order)

Panel title / body. Verb-first links, outcome named (product-communications skill, UX-copy standards).

| # | Title | Body |
| --- | --- | --- |
| 1 | `What you are watching` | `musterd is built by a team running on musterd. The members you can see are agents and humans on one roster: they claim lanes, hand work off, raise asks, and accept each other's merges. The stream is that team at work, unedited. The team works in sessions, so the channel is dark between them — the work is public either way.` |
| 2 | `The code` | `Every act, decision record and merge is in the open repository. Read what the team is building: github.com/SandRiseStudio/musterd` (the panel links to the repository) |
| 3 | `Start your own team` | `Zero to a working team in one command. musterd.io/docs/getting-started` (the panel links to the docs) |

Panel 1 is the /watch spec's hero lede plus its dark-state line, verbatim, so the channel and the
page tell one story. Panel 3 reuses the home page's H2 verbatim for the same reason. No fourth
panel: the office is the window, and the panels hand off to the product in one line each.

## 6. Clip titling convention

A clip title is the act you saw, in plain words, present tense, no names a stranger cannot place:

- `an agent declines a merge and says why`
- `two agents hand a lane off mid-build`
- `the stream restarts because the team just deployed it`
- `a human raises an ask; three agents answer`

Never `nix pix`-style private titles, never a member's name alone, never "AMAZING" or "insane". The
clip is the post; its title is the post's first line.

## 7. Offline screen

One still of the office scene with members at desks, captured from a real session (same asset as
/watch spec §7), with the wordmark. Text on the image, one line: `between sessions — the work
continues at github.com/SandRiseStudio/musterd`. Never the word "offline" (reads as broken).

## 8. Acceptance

1. Category, VOD storage and clips are set as §2 and the seven old clips are gone — check the public
   `/clips` and `/videos` pages logged out after the next stream: videos non-empty, clips empty or
   ours only.
2. Title, tags, bio and panels match §3–§5 character for character on the public `/about` page,
   and the bio is under the 300-character cap.
3. `pnpm vocab:check` green on this file.
4. After the first stream under these settings, record on the audit page what the directory card
   looked like and where it sat in the Software and Game Development listing — the number the audit
   could not measure.
5. Within 7 days of that stream, at least one clip exists and the past broadcast has been exported
   to YouTube — check both before the retention window closes, because after it the recording is
   gone and neither can be done.
