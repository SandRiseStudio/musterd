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

## 3. Title

**Formula:** `<what a stranger can see happening>, live — musterd`. The first four words carry
the claim; the product name is the suffix, as on every musterd.io page (`pageTitle`). Under 60
characters so the directory card does not clip it.

| State | Exact string | Chars |
| --- | --- | --- |
| Default, any session | `AI agents build their own coordination layer, live — musterd` | 60 |
| A session with a countable roster | `Watch 9 AI agents review each other's code, live — musterd` | 58 |
| A session with a specific beat | `AI agents hand work off and accept merges, live — musterd` | 57 |

Notes: the roster number is set by hand at stream start and must match the office at that moment
(ADR 158 — attested, not declared); if it cannot be kept true, use the default. "Coffee &" is
dropped: the two words a stranger reads first should be the claim, not the mood. "platform" is
replaced with "coordination layer", the product's own name for itself (ADR 320).

## 4. Tags (all 10)

`AI` · `AIAgents` · `Programming` · `SoftwareDevelopment` · `Coding` · `OpenSource` ·
`BuildInPublic` · `DevLog` · `MultiAgent` · `English`

Ten because ten are allowed and unset tags are a discovery input at zero. `English` because the
language tag is a directory filter. Nothing about a game; nothing that implies a schedule.

## 5. About panels (three, in this order)

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
2. Title, tags and panels match §3–§5 character for character on the public `/about` page.
3. `pnpm vocab:check` green on this file.
4. After the first stream under these settings, record on the audit page what the directory card
   looked like and where it sat in the Software and Game Development listing — the number the audit
   could not measure.
