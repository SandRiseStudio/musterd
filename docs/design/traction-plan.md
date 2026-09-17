# Traction plan — the nine weeks to 2026-11-20, and what runs after

**Status:** plan, 2026-09-16. Agreed in a design conversation between nick and sloane
(product-communications) the same day; lane `01M2PA5TY9`. Positioning is decided
([ADR 320](../decisions/320-positioning-the-value-prop-decided.md) and its §5 amendment) and this
plan does not re-open it. Every commercial call in here — which batch to join, what to say to an
investor, whether to take a hire — is **nick's**; sloane executes the message. The dated log at the
bottom is the only part of this page that changes weekly.

## 1. Why this page exists

musterd has been built for a long time and nobody outside the team has used it. The public surfaces
exist — musterd.io, the GitHub repo, npm and Homebrew, the Twitch stream, three demo scripts, a
launch post in three lengths — and on 2026-09-16 they add up to **0 stars, 7 unique visitors in 14
days, 5 followers, and 12 of 13 dogfood runs never run**. nick wants to pursue musterd full time:
users, interest, a path to money (funding, a cohort, an acquisition or acqui-hire, or a hire on the
strength of the work), and open-source visibility and collaborators throughout.

There is a hard window. A baby is due **2026-11-20**. Household income is covered through roughly
May 2027, but nick's in-person time — demo nights, meetups, coffees — collapses on the due date.
So the plan is two-phase on that line: **nine weeks of in-person work**, then a machine that runs
from home, asynchronously, with days of silence in it.

## 2. The situation on 2026-09-16

Facts, each with where it was read:

- **GitHub** `SandRiseStudio/musterd`: public; 0 stars, 0 forks; 10 views / 7 uniques in the last
  14 days (`gh api .../traffic/views`). Clone counts are the auto-refresher, not people.
- **npm**: `@musterd/cli` `server` `mcp` `protocol` all at **0.4.2**, matching the repo. Not stale.
  The Homebrew tap is the README's first install line.
- **musterd.io**: live; the blog section is withheld (404 by design, #1367); the analytics beacon
  has only been on the page since 2026-09-14, so there is no traffic history to read.
- **Twitch**: 5 followers, VODs on but deleted after 7 days, no discovery surface
  ([twitch-channel-audit](../wiki/twitch-channel-audit.md)); per-session titles specced but not
  yet a habit.
- **Demo scripts**: three, in [docs/demo.md](../demo.md) — the live crib sheet (§3), the 7–8 minute
  user-value cut (§4), the 6-minute pitch for a room that arrived afraid (§5). No 2-minute cut.
- **Launch post**: three lengths in [docs/launch-post.md](../launch-post.md) plus the blog draft,
  swept for ADR 320 §5 on 2026-09-16. Still headed **v0.3** while npm is 0.4.2. Its one open gate
  is the real 3-pane recording.
- **Dogfood**: runs 1–12 in [dogfood-scenarios.md](dogfood-scenarios.md) are open and unowned,
  including **run 4, cold start on a clean machine** — the run that decides whether a stranger can
  install it at all. Run 13 (open-weight model) is in progress.
- **Research**: [ADR 056](../decisions/056-research-as-first-class-practice.md) puts the
  coordination-traces dataset first on the ladder; [ADR 184](../decisions/184-dataset-consent-and-redaction.md)
  finds the consent half of its gate does not exist yet. Nothing published.
- **Standalone pieces**: `packages/whiteboard` (`agent-whiteboard` 0.1.0) is a complete standalone
  — its own MCP server, tldraw adapter, sync service, SKILL.md, and an extraction test proving it
  imports nothing from `@musterd/*` ([ADR 330](../decisions/330-agent-whiteboard.md)). Private,
  unpublished, README empty.
- **The market** ([landscape.md](landscape.md) §12–13): seed money is already in this cell — Band
  $17M, Pilot Protocol $4.5M, xpander $7.5M; Multica has ~47k stars one cell over; three labs now
  sell hosted "teammates." Every one of them stops at the wall musterd is built past: one owner's
  walls, no cross-owner identity, no teammate who can decline.

## 3. The north star and the constraints

- **North star:** a path to getting paid to keep building musterd, with open-source visibility and
  collaboration as a hard constraint, not a nice-to-have. This rules out a closed-source pivot and
  makes the open-source track load-bearing for every paid outcome — funding, a cohort, an
  acqui-hire, or a lab hire all read GitHub first.
- **First user:** a solo developer already running two or more agent sessions (Claude Code +
  Codex/Cursor) and losing track of who did what — one person, one machine, wants a team not a
  fleet. Second: a small dev team (2–5) sharing one repo with agents. The first is the same person
  who later brings it to the second.
- **What must be true on 2026-11-20:** the public launch is done; strangers are using it; a few
  serious conversations are open with a dated next step. After that date: YC/cohort applications
  and the conversations accelerate, from home.
- **Not re-litigated:** the positioning. Not built in the window: pricing, the paper, more Twitch
  growth than per-session titles.

## 4. The calendar

| Weeks | Dates | Phase | Done means |
|---|---|---|---|
| 1–2 | Sep 17 – Sep 30 | **Install truth + demo from day one** | A machine that is not nick's goes from musterd.io to first agent online in ≤10 min, twice, on two harnesses. The 2-minute demo exists and has been given at ≥2 events. `agent-whiteboard` is on npm in its own repo. |
| 3–6 | Oct 1 – Oct 28 | **Hand-to-hand** | 2–3 events a week. 10–20 installs done on the other person's laptop. 3–5 still active a week later, measured. Every quote in the quotes file. Weekly fix cycle. Startup Grind demo (Oct 7). |
| 6–7 | Oct 28 – Nov 2 | **Public launch** | Blog post live, Show HN, X, Reddit — carrying real quotes and numbers. YC W27 application in by Nov 2, 8pm PT, with the same numbers; a16z speedrun by Nov 1 if nick says so. |
| 8–9 | Nov 2 – Nov 20 | **Conversations + hand-over to async** | ≥3 investor / lab / company threads with a next step dated in Q1. Everything that must run without nick is running. |
| — | Nov 20 → May 2027 | **Async from home** | Small-things track continues; dataset gate; cohort applications; Q1 conversations. Sequenced in its own doc later, written from what the nine weeks taught. |

**Demoing starts in week 1.** A demo and an install are different acts: the demo is nick's
machine, nick's live team, two minutes; the install is the other person's laptop. The demo needs
nothing proven first, so weeks 1–2 are "prove the install *and* demo at every event you can get
into," not a quiet fortnight.

Two flags. The launch sits three weeks before the due date, so a one-week slip is fine and a
two-week slip is not — week 5 carries a go/no-go (§13). And YC's on-time deadline (Nov 2) falls
*inside* the window, not after it; late applications are still read, but without the Dec 11 decision.
a16z speedrun's priority window (Oct 12 – Nov 1) sits beside it (§12).

## 5. Weeks 1–2 — install truth, and the demo

**The 2-minute demo.** Cut from the 6-minute pitch ([demo.md §5](../demo.md)), built on the
centerpiece beat alone: a question reaches the human; the human declines; the work re-routes; a name
on every act. That is the Startup Grind format ("demo only, not a pitch") and it fits a hallway. The
6-minute version stays for a seated room. Both run against the live team, never a fixture; the
stream is the backup if the laptop dies. Owner: sloane (script), nick (delivery, from the first event).

**Install truth.** Run [dogfood run 4](dogfood-scenarios.md#4-cold-start-on-a-clean-machine) on a
machine that is not nick's — a new macOS user account is enough — on Claude Code and on Codex; then
[run 9](dogfood-scenarios.md#9-a-team-of-one-agent-and-one-human) as the first-session script.
Target: musterd.io → first agent online in ≤10 minutes with no step that needs nick in the room.
Fix the top three breaks; the rest become ordinary lanes on the board. Output: a one-page "first
ten minutes" that the README's Get Started already claims to be. Owner: a seat that is not nick,
on a fresh account; nick reads the findings.

This gates hand-to-hand (installing on strangers' laptops), **not** demoing.

## 6. Weeks 3–6 — hand-to-hand

At each event: demo → ask *"do you run more than one agent session?"* → if yes, install on their
laptop then and there → watch, and do not help until they are stuck → write down where they got
stuck. That last line is the product research; the install is the excuse for it.

Targets: 10–20 installs; 3–5 still active a week later, **measured** (their `/audit` or a one-line
check-in a week on — never guessed); every quote recorded in one file, `docs/design/quotes.md`, with
name, date, event, and what they were doing. Weekly: fix what broke, re-run run 4. The quotes file
is the launch post's evidence and the YC application's traction section, written as it happens.

The ask that closes each conversation is small and the same every time: *"try it with your team
for two weeks; I'll sit with you for the first hour."*

## 7. Weeks 6–7 — the public launch (Oct 28 – Nov 2)

What exists: three lengths of the post and the blog draft, all on-message. Two fixes before it
ships: the version (v0.3 → whatever npm says that morning), and the recording gate — a screen
recording of the 2-minute live demo beats the GIF placeholder, and is what should ship. What is
*new* by then and goes in: the quotes and the install count from §6.

Launch day, in order: the blog post goes live on musterd.io (un-withhold the section; the deploy is
miley's under [ADR 308](../decisions/308-public-site-deploy-authorization.md)); Show HN in the PT morning; the X thread the same
hour; Reddit (r/ClaudeAI, r/LocalLLaMA) the next day; each small-things repo (§9) gets its "from
the musterd team" pointer the same day; the stream is live with a per-session title that says so.
One person answers every comment for 48 hours — nick, with the seats drafting.

## 8. Weeks 8–9 — conversations, and the hand-over to async

**Conversations.** Sourced from the events: the people who say "we run agents at X" — get the
second meeting, not the card. Three lists (§11). The ask is the same small one as §6; funding, a
hire, or an acquisition grows from a team that has tried it, not from a deck. Target by Nov 20:
**three or more threads with a next step dated in Q1**. sloane supplies a one-page leave-behind per
audience (same story, different register) and a follow-up notes form.

**Hand-over.** Everything below must need no in-person time and tolerate days of silence:

- per-session stream titles set by whoever starts the stream
  ([twitch-channel-copy-spec](twitch-channel-copy-spec.md));
- GitHub issues triaged by a seat, with a stock human reply nick approves at a glance;
- the small-things repos on a "reply within 48h" rule the seats can keep;
- the dataset gate ([ADR 184](../decisions/184-dataset-consent-and-redaction.md) consent mechanism)
  as ordinary lanes — the one research artifact ADR 056 puts first, and the kind of work that fits
  broken nights;
- the research radar as a weekly digest to nick's inbox;
- cohort applications (the §12 table) and the Q1 follow-ups on one dated list.

The post-Nov-20 track gets its own sequencing doc, written from what these nine weeks taught.

## 9. Parallel track — small things that travel (starts now)

Each is a musterd *practice* that works with no daemon, and each is honest in its README about what
it cannot do without one — which is the doorway. Ordered by cheapness × reach; one lane each.

1. **`agent-whiteboard`** — exists, extraction-tested. Own repo, npm, README. Days.
2. **`cross-family-review`** skill — before merge, a review by a model of a different family than
   the author; the four-question verdict (intent / principles / usable / feel); accept is the
   verdict ([ADR 202](../decisions/202-the-verdict-moves-the-lane.md)). Pure SKILL.md, any
   harness. Its stated limit: nothing attests the reviewer's model actually differed — that is what
   the daemon records. Days.
3. **`board-loop`** skill + a minimal board — claim before you build, one owner per surface, submit
   → acceptance. The minimal board is a `LANES.md` convention plus a small script that renders and
   validates it. About a week.
4. **`harness-inbox`** — the acts vocabulary and the loop (inbox at task boundaries,
   `status_update`, `ask` with tiers) over a shared file between two sessions on one machine. The
   closest to the product itself; ships as "the protocol, minimally," with the roster and
   attestation limits spelled out, so it reads as a taste rather than a substitute. Last.

Plus one sweep, first week, sloane: **walk musterd end to end and list every practice that ships as
a skill** — there will be more than four.

Distribution for all of them: one `SandRiseStudio` repo each (or one `musterd-skills` repo with a
directory per skill — decide at #2), a Claude Code plugin marketplace listing, the skills
directories, and a "from the musterd team" line pointing at musterd.io. Every README carries the
same one-sentence positioning so the four tell one story.

## 10. Events — where to be

Sources checked 2026-09-16; dates are theirs, re-check before travelling. **Bold** = apply to
demo or speak; the rest are attend-and-work-the-room.

| Date | Event | Why | Move |
|---|---|---|---|
| Sep 17 | [Startup Grind AI Demo Series, September](https://luma.com/e36889su) — 15 founders × 2 min, VC panel | Applied, not selected. Go anyway: the format is the 2-minute cut and the panel's questions are the ones to rehearse against. | Attend; watch what the panel asks. |
| Sep 26 | Agent Arena Hackathon (via [Cerebral Valley](https://cerebralvalley.ai/events)) | Agent-infra crowd; the first user is in that room. | Attend or enter with the whiteboard skill as the build. |
| Sep 29 – Oct 1 | [The AI Conference](https://aiconference.com/), Pier 48 — 5,500 builders, an agentic-AI track | Biggest room of the window; ticket cost unknown. | Attend the agentic track days if the price is sane; hallway demos. |
| Oct 5 – 11 | [SF Tech Week](https://luma.com/sftw) | The densest week. Named so far: "Camp AI: Production-Ready Agents" (Ferry Building), "Demo Night @ WorkOS", "Ship it & Sip it: Software Factories Night", "init() by WorkOS" (SFJAZZ), "Agents & APIs SF Developer Meetup" (sold out — waitlist), YC Founders Mixer, Founder Friends SF (Hustle Fund, waitlist). | Register for five; **apply to Demo Night @ WorkOS**. |
| **Oct 7**, 5–8pm PT | [**Startup Grind AI Demo Series, October**](https://www.startupgrind.com/events/details/startup-grind-silicon-valley-san-francisco-bay-area-presents-ai-demo-startup-grind-amp-ai-collective-sftechweek/) at Pilot, 353 Sacramento — 10 founders, VC meetings for chosen founders | Applied. The one scheduled demo of the window. | **Demo if selected; attend regardless.** |
| by **Oct 11** | [AI Engineer Code Summit](https://ai.engineer/code/2026) speaker CFP closes (Sessionize) | See Nov 10 row. | **Submit a talk** — "a teammate who can decline: accountability primitives for coding agents," with the cookoff receipt. |
| Oct 16 – 25 | [Open Source AI Week](https://events.linuxfoundation.org/open-source-ai-week/) — PyTorch Conf (Oct 20–21), **AGNTCon + MCPCon NA (Oct 22–23)** | Agents and MCP, in one place, the week before launch. musterd *is* an MCP server on the team's side. | Attend AGNTCon/MCPCon; check for lightning-talk or demo slots. |
| Oct (TBC) | [SF Demo Night](https://luma.com/sfdn) — 8 curated pre-Series-A demos, AWS Builder Loft | Applications due the Thursday before; 100+ apply. | **Apply** when the October date posts. |
| Nov 10 – 12 | [AI Engineer Code Summit](https://ai.engineer/code/2026), Hilton Union Square — invitation-only, ~800, single track; OpenAI / Anthropic / Cursor / Cognition engineers | The exact room for the lab and harness conversations, eight days before the due date. | **Apply to attend now**; speak if the CFP lands. Go for one day if not all three. |
| weekly | [luma.com/ai-sf](https://luma.com/ai-sf), [luma.com/genai-sf](https://luma.com/genai-sf), [Cerebral Valley](https://cerebralvalley.ai/events), [Hidden Events](https://hiddenevents.online/sf/ai-events/) | The 2–3/week cadence comes from these calendars. | nick picks each Sunday; the log records which. |

Rule for choosing between two events on the same night: the one where the attendees run agents
themselves beats the one where they invest in people who do. Users first; the investors come to
the demo nights anyway.

## 11. People and companies — three lists, one ask

The ask to every one of them is the §6 ask — *try it with your team for two weeks* — and the
relationship is built from that trial, not from a pitch. Sourced from the landscape, so each name
carries the reason it is on the list.

**Harness and lab platform teams** — musterd runs across their products; the pitch to a platform
team is "your users already run two of these at once."

- Anthropic (Claude Code; Claude Managed Agents) — the harness this team is built in.
- OpenAI (Codex; the open Codex harness/app-server protocol, 2026-08-21).
- Cursor; GitHub Copilot CLI; OpenCode; Pi (pi.dev) — the smaller harnesses, quickest to reach.
- Nous Research (Hermes Agent, Bot Mode) — closest surface language to ours; single-user by design.

**Adjacent startups — collaborate, borrow, or be acquired by**

- Multica (~47k stars; agents as assignees across 20 harnesses) — the console cell; its users
  picture "agents on the team's board." A musterd integration is a natural collaboration.
- Band (band.ai; $17M seed) — the head-on protocol competitor. nick has met the team (Qoder event,
  2026-07-03). Worth a second coffee: they need cross-owner identity and accountability, which is
  what they do not have.
- Pilot Protocol ($4.5M; agent addresses and payments), Coral Protocol (AgentRadio) — the cross-org
  cell; coordination semantics on top of their substrate is unclaimed.
- xpander ($7.5M; enterprise control plane), Omnigent, AgentField — control-plane/runtime cells;
  potential integrations, and their customers are the Gartner-gap buyers.
- LangChain (Managed Deep Agents) — "teammates reachable over UI/API/channels"; an integration
  story.

**Investors** — the funds already in the cell are the map, and the demo nights bring more:

- Version One Ventures (led Pilot Protocol), Pico Venture Partners (led xpander), Sierra Ventures /
  Hetz Ventures / Team8 (led Band, per landscape §5) — the three funds that have already priced this cell.
- The Startup Grind and SF Demo Night VC panels — meet them after the demo, not before.

**Companies feeling the governance gap** (Gartner: >150,000 agents per Fortune 500 firm by 2028;
13% think their governance is adequate): sourced at events, not cold. Any team that says "we have
agents and nobody can say who did what" goes on the list with the date.

## 12. YC W27, a16z speedrun, and the cohorts

Two applications fall inside the window, off the same numbers:

- **YC W27**: on-time deadline **Nov 2, 8pm PT**; decision by Dec 11; batch Jan–Mar 2027 in SF
  ([apply](https://ycombinator.com/apply)). Apply on time, with the §6 numbers and launch-day
  numbers as of that morning; the video is the 2-minute demo. The batch overlaps the newborn months
  — that decision is nick's and can wait for the Dec 11 answer; the application is not harmed by
  deciding later.
- **a16z speedrun**: $500K–$1M plus credits, SF; applications are read year-round but the
  **priority window is Oct 12 – Nov 1** ([a16z](https://a16z.com/applications-for-a16z-speedrun-sr007-are-now-open/)).
  Same numbers, same video, one day earlier. Whether to run both is nick's call — added
  2026-09-16 after the cohort survey below.

**The rest**, on the post-Nov-20 list (dates read 2026-09-16 from each program's page or a dated
listing — verify before applying):

| Program | Terms | Timing | Read |
|---|---|---|---|
| Conviction Embed | $250K grant + credits; 10 AI startups per cohort | rolling; SF retreat; the page's dates are unclear | strong fit — AI-native, small ([embed.conviction.com](https://embed.conviction.com/)) |
| Neo Residency | $750K uncapped + ~$450K credits; 12–15 teams | 3 months SF + 2 weeks Oregon | check the next cohort's dates |
| South Park Commons Founder Fellowship | $1M terms | spring application ~Feb 1; bootcamp Mar–May | fall 2026 closed Aug 2 ([SPC](https://www.southparkcommons.com/news/f26-founder-fellowship/)) |
| Sequoia Arc | $500K–$1M | spring open call ~Feb, if run | no 2026 call announced as of this survey ([arc](https://sequoiacap.com/arc)) |
| OpenAI Grove | $50K credits; ~15 founders; 5 weeks SF | cohort 2 closed Jan 2026; expect early 2027 | pre-idea / early; Codex-adjacent |
| PearX · AI Grant | $250K–$2M / $250K uncapped + credits | rolling | lightweight paths |
| HF0 | $1M / 5% uncapped; ~10 teams | rolling, unpublished | repeat-founder bias — long shot |
| Mozilla Builders | open-source grants / incubator | between cohorts; rolling review | matches the open-source track ([programs](https://builders.mozilla.org/programs/)) |
| Google for Startups Accelerator | equity-free; 12 weeks; cloud credits | about twice a year | later |
| Claude for Startups | credits + priority limits | open | needs institutional equity — after a raise ([programs/startups](https://claude.com/programs/startups)) |
| Techstars SF · Antler SF · Alchemist · 500 Global | generalist | various | fallbacks |

## 13. Measures — what tells us the plan is failing, week by week

Each number is a diagnostic, not a target to game — the same rule
[ADR 056](../decisions/056-research-as-first-class-practice.md) puts on published metrics.

| By | Measure | Failing looks like |
|---|---|---|
| Sep 30 | Run 4 on a foreign machine ≤10 min, two harnesses | Any step needs nick in the room → hand-to-hand slips a week; demoing continues. |
| Sep 30 | `agent-whiteboard` on npm in its own repo | Not published → the parallel track has no cadence; fix the cadence before adding skills. |
| Sep 30 | 2-minute demo given at ≥2 events | Fewer → the calendar (§10) is wrong for nick's week; re-pick. |
| Oct 14 | ≥5 hand installs; ≥2 events/week; ≥2 skills shipped | <3 installs → the demo works and the ask does not; change the ask, not the product. |
| Oct 28 | ≥10 installs; ≥3 active a week later; ≥5 quotes | <3 active → **launch go/no-go**: launch with honest numbers, or slip one week — never two. |
| Nov 2 | Launch out; YC in (speedrun by Nov 1 if chosen) | — |
| Nov 20 | ≥3 conversations with a dated Q1 next step; the §8 list running | <2 → the post-baby plan leads with conversations, not the dataset. |

## 14. Lanes and ownership

| Work | Owner | Notes |
|---|---|---|
| This plan; the weekly log | sloane | lane `01M2PA5TY9` |
| 2-minute demo cut; leave-behinds; follow-up form; GitHub stock reply | sloane | copy, per charter |
| Skills e2e sweep (§9) | sloane | first week |
| `agent-whiteboard` extraction + publish | engineering seat, nick picks | one lane |
| `cross-family-review`, `board-loop`, `harness-inbox` | engineering seats, one lane each | in that order |
| Dogfood run 4 and run 9 | a seat that is not nick, fresh account | findings to the board |
| Launch-day deploy | miley | ADR 308 |
| Attending, demoing, installing on laptops, every conversation | **nick** | the plan cannot do these |

## 15. What this plan does not do

- Re-open the positioning (ADR 320) or the vocabulary (ADR 296).
- Write the pricing/business-model doc (lane `01M08Y95JD` stays open; advise-only for sloane).
- Publish the dataset or the paper inside the window — the consent gate is not open, and ADR 056
  says dataset first.
- Grow the Twitch channel beyond per-session titles.
- Decide whether nick does the YC batch. That is nick's, in December.

## 16. The PM track — a fourth paid outcome, in the same hours

Added 2026-09-16 at nick's ask. nick has prior PM experience and then built musterd; a product
role for AI agents — broadly, not only agents-as-teammates — at a startup or a company is a real
outcome, and it grows from the same conversations as the other three: the team that says yes to
*"try it with your team for two weeks"* is also the team that might want the person who built it.

**The story, one paragraph (sloane keeps it current; nick says it):** a PM who ships. Built musterd
— the coordination layer where agents and humans are peers — solo, with a team of agents on musterd
itself: hundreds of dated decisions, a decided positioning, a public site, a protocol, a research
program, and every product call written down where a stranger can read it. The repo is the
portfolio: [PRODUCT.md](../../PRODUCT.md), [ADR 320](../decisions/320-positioning-the-value-prop-decided.md),
[landscape.md](landscape.md), [ROADMAP.md](../../ROADMAP.md) "How priorities are decided",
[dogfood-scenarios.md](dogfood-scenarios.md), [demo.md](../demo.md), this plan.

**What exists today, read 2026-09-16:**

- **sandrise.io/nicksanders** (`~/sandrise`, Astro): the studio portfolio with 20 case studies
  (ring, izzocam, techflow… ) and Exploring Next, the daily AI-hosted podcast with its own API and
  MCP server. **No musterd case study.** That is the gap that matters most.
- **Ring** (`~/ring`): a PM-role alert agent, running under launchd, texting matches to the phone
  from ~270 boards (Greenhouse, Ashby, Lever, SmartRecruiters, Workable, Workday, Microsoft, Amazon,
  Google, Apple; 3-day window; Slack on). Broad net; nobody is reading it.
- `~/lab/ai-training`: the AI training material nick has run for groups — a second proof of the
  "explains agents to people" skill.

**Targets, three tiers.** Tier 1 is where musterd's problem *is* the roadmap: Anthropic (Claude
Code, Managed Agents), OpenAI (Codex as a platform), Cursor, GitHub (Copilot agents), Cognition,
LangChain (Deep Agents), Replit, Sourcegraph, Factory, Warp, Nous Research — and the adjacent
startups where the role is PM #1 or #2: Multica, Band, xpander. Tier 2 is agent products with PM
roles broadly: Vercel, Supabase, PostHog, Linear, Notion, Perplexity, Modal, Together, Fireworks,
Anyscale, Cohere, Mistral, Scale, Sierra, Decagon, Glean, Harvey, Writer, Zapier, Retool, Hugging
Face. Tier 3 is Ring's net. Ring already watches every tier-2 name and most of tier 1; it does not
watch GitHub, Factory, Multica, Band, xpander, or Nous.

**In the window:**

- *Weeks 1–2:* the musterd case study on sandrise.io (sloane writes it in the portfolio's register;
  nick ships it); the one-paragraph story on LinkedIn and the resume; Ring gains the six missing
  tier-1 boards and a "tier 1" Slack channel so those alerts are read, with the rest as a weekly
  digest; a 15-minute Sunday triage, logged here.
- *Weeks 3–6:* warm before cold. Every tier-1/2 conversation carries one extra sentence — *"and I'd
  build this inside a team, if the team were right."* Cold applications only to open tier-1 roles,
  at most five in the window, timed so first rounds land late October.
- *Weeks 7–9:* interviews if they come; the launch numbers are the interview story.
- *After Nov 20:* PM loops run 6–10 weeks and are mostly remote-friendly; January is the natural
  cold-application month (budgets reset), offers by March, a start before income ends in May.
  Check parental-leave eligibility on any offer — most employers gate it on tenure; California PFL
  applies regardless.

**Measures:** by Sep 30, the case study is live and Ring's tier-1 channel exists; by Oct 28, ≥3
tier-1/2 teams know nick is open, in writing; by Nov 20, ≥1 active loop or a dated January list.

**Ownership:** applications, interviews, and the Ring config are nick's (his repo — changes here
are proposed, not made). The case study, the story paragraph, the resume lines, and a one-page
"what I decided and why" reading list for interviewers are sloane's.

## 17. Weekly log

Appended each Sunday: events attended, demos given, installs (name/date/harness), active-a-week-later
count, what broke, quotes added, conversations opened, measures hit or missed. Dated entries only.

- **2026-09-16** — plan agreed and written. Lane `01M2PA5TY9` opened. Baseline: 0 stars, 7 uniques/14d,
  5 followers, run 4 unrun, whiteboard unpublished, launch post at v0.3.
- **2026-09-16** (later) — plan merged (#1527, a61f1eac); child lanes open. §16 PM track added. Cohort survey added to §12:
  a16z speedrun's priority window (Oct 12 – Nov 1) is inside the window, beside YC. One-page visual
  of the plan published for nick as a claude.ai artifact.
