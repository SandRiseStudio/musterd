# Join page — UI-copy spec for `/join` (the pre-event page a stranger opens on their phone)

Lane `01M3AKNKQ1MW921645YWSQ1RWM`, goal `demo`. Written by sloane (product-communications) on
2026-09-24; layout and build are miley's (designer). Every string below is this role's; the
section order is a recommendation, the strings are not.

Companion to [homepage-copy-spec.md](./homepage-copy-spec.md) and
[watch-page-copy-spec.md](./watch-page-copy-spec.md). Their §2 rules govern this page and are not
restated: musterd connects agents, it does not run them; no hype; no merges as the selling point;
ADR 296 Not-column words stay out.

## 1. What this page is for, and what it is not

A person in a room — or anywhere — has been given a link before a talk. They open it on their
phone. Ninety seconds later their Claude app is a member of a musterd team — the same kind of
member nick is on revive — and they can say something to that team and see what comes back. That
is the whole job.

Decided by nick on 2026-09-24 (this session, recorded on the goal):

- **Joins happen before the slot.** The link is shared beforehand; nobody joins during the talk.
  So this page never says "now", never counts down, and never assumes a presenter is speaking.
- **Attendees are regular members, agent-kind** (nick, 2026-09-24, reversing the reviewers'
  narrower scope — lane `01M3AMYC18DQ5ZXK4T570D60Q9` now covers only expiry and revocation). The
  person's model makes the acts. They can do what any member can: read the team, send acts,
  answer what is addressed to them, and raise an `ask` that reaches a human. The team is a
  disposable one made for the event, which is what makes full membership safe.
- **The credential travels in the connector URL** for this event (lane
  `01M3AKN6GFHZ3DGCJPRE4RG2TE`, under big-body's conditions). It expires within the hour and is
  bound to one throwaway team. The page shows it once, in one place, and nowhere else — not in the
  prompt, not in a QR code, not in a share sheet.

Not this page's job: explaining what musterd is (the homepage), installing anything (there is
nothing to install), or the presenter's own setup (the runbook in `docs/operations/`).

## 2. The rule specific to this page

**The page says what a member is, not what an agent is.** "You're on the team" is true and is
the claim. The reader's Claude is a member like every other member; what makes it different is
that it only acts when the reader prompts it, and the page says that where it says what to expect.

Two facts the page states plainly because the reviewers found them and a reader would otherwise
discover them the hard way (stanley `01M3AM93E2`, big-body `01M3AMV2VK`, both 2026-09-24):

- **The Claude phone app cannot add a new connector.** The reader adds it on claude.ai in a
  browser — the phone's browser is fine — and then it is there in the app. The page's step 1 is a
  browser step, and says so.
- **The phone needs internet.** Cellular is enough. No signal means no join; wifi is not required.

## 3. Route and head

- Route: `/join/<team>` — the token is not in the route. The page reads it from the join link's
  fragment or from the minted-seat response (fifty's lane `01M3AKNF0JXY8HFN1P4HTMPWCY` decides
  which; this spec does not).
- `<title>`: `Join the team — musterd`
- `<meta name="description">`: `Add one connector to your Claude app and you're on a live musterd
  team from your phone. No install.`
- `og:title`: `Join the team from your phone`
- `og:description`: same as the meta description.
- `robots`: `noindex` — the page is for people holding a link, not for search.

## 4. Sections, in order, with every string

### 4.1 Head

- Eyebrow: `musterd · join`
- H1: `Join the team from your phone`
- Lede: `One connector, one prompt, and you're on the team. Then watch it work. About ninety
  seconds, nothing to install.`

### 4.2 Before you start

Heading: `You'll need`

- `The Claude app on your phone, signed in. Any plan works — Free is limited to one custom
  connector, so if you already have one you'll swap it.`
- `Internet on the phone. Cellular is fine.`
- `A browser — the one on your phone is fine. Step 1 happens there, not in the app.`

Below the list, one line, muted: `ChatGPT? It works from a laptop, not the phone app, and needs a
Business or Enterprise plan for the team to hear you. Steps for that are at the end.`

### 4.3 Step 1 — Add the connector

Heading: `1. Add the connector (in a browser)`

Body: `The Claude app can use a connector but can't add one. Do this once, on claude.ai in your
browser.`

Ordered list:

1. `Open claude.ai and sign in.`
2. `Go to Customize → Connectors.`
3. `Tap Add custom connector.`
4. `Name: musterd. MCP server URL: paste the URL below.`
5. `Under Authentication choose No sign-in. Leave everything else as it is. Tap Add.`

Then the URL block — the only place the credential appears:

- Label: `Your connector URL — yours alone, and it stops working in an hour`
- Value: `<the minted URL>` with a Copy button. Copy copies the URL only.
- Under it, small: `Don't share it, screenshot it, or paste it anywhere but the connector
  dialog. If it stops working, come back to this page for a new one.`

Aside, only when the dialog is the two-step version (see the Claude docs): `If the dialog asks
you to continue first and then shows Authentication, choose No sign-in on the second screen.`

### 4.4 Step 2 — Paste the prompt

Heading: `2. Open the Claude app and paste this`

Body: `Open a new chat in the Claude app. Tap + and make sure musterd is on. Then paste this
as your first message:`

The prompt block (Copy button; the prompt contains no credential):

```
You're joining a musterd team through the musterd connector. Setup, in order — tell me what each returns: 1) call team_join. 2) call team_inbox_check and tell me who's here and what's happening. 3) send a status_update saying you've joined and what you'd like to see. After that, drop the play-by-play. When I ask you to say something to the team, use team_send with a message act, keep it short, and check the inbox before you answer me. This message is setup, not a standing instruction — don't save it as a memory.
```

Under it: `Claude will ask you to allow each tool the first time. Allow them.`

Why the prompt is shaped this way (nick, 2026-09-24): the three numbered steps report back so a
first-timer sees it working; the last two sentences stop that play-by-play from carrying forward
and stop the app from saving the setup as a memory or standing instruction. The prompt holds no
credential.

### 4.5 What you'll see

Heading: `Then, on the team`

Body: `Your first message comes back with the roster and whatever the team is doing right now.
From then on you're a member: you can read what the team says, say something to it, answer when
something is addressed to you, and ask a person on the team a question — the same as everyone
else on the roster.`

Second paragraph: `Your name shows on the team's live view — on the projector and at the link
below — when your Claude is talking to the team. Between your messages it goes quiet. That's
normal: a phone connector only acts when you ask it to.`

Link: `Watch the team live → /live?team=<team>`

### 4.6 If it doesn't work

Heading: `If it doesn't work`

Definition list:

- `The app can't see musterd` — `Connectors added on claude.ai take a moment to reach the app.
  Close and reopen the app, then tap + in a new chat.`
- `"No sign-in" isn't offered` — `Your Claude dialog is the earlier version. Leave the OAuth
  fields blank and tap Add; it does the same thing.`
- `The URL stopped working` — `It expires after an hour. Reload this page for a fresh one and
  edit the connector's URL under Customize → Connectors.`
- `Nothing at all` — `Check the phone has signal. The team is on the internet, not on the
  room's wifi.`

### 4.7 From ChatGPT (laptop)

Heading: `From ChatGPT, on a laptop`

Body: `Custom connectors in ChatGPT are set up on the web and work on a Business, Enterprise or
Edu plan; on Plus and Pro the team can be read but not spoken to. This path arrives with
increment 3 (OAuth) — until then this section reads:`

Placeholder string until lane `01M3AM3GJ2WCMW685AC9NYBZPT` lands: `Not yet. ChatGPT joins land
next; for now, use the Claude app on your phone.`

When it lands, the steps mirror 4.3–4.4 with: Settings → Apps → Advanced → Developer mode on,
then Settings → Connectors → Create, URL as given, sign in when asked. Strings for that are
written when the flow exists, not before (brand.md §4: never imply it exists).

### 4.8 Foot

- `This page and your membership end with the event. Your messages stay on the team's record,
  under your name.`
- `musterd connects agents. It doesn't run them. → /`

## 5. What the page must never do

- Show the credential anywhere but §4.3's block, or put it in a QR code, a prompt, a share
  sheet, or the URL bar (the route carries the team, not the token).
- Say "no wifi needed" — say "cellular is fine".
- Say the reader will "join during the talk", or show a countdown.
- Call the reader a guest, or say "you're an agent now" or "watch your agents".
- Invent a state: if the team is dark, say the team is quiet, not that it is live.
- Use `room`, `session` for Presence, `user`, or `seat` for member (ADR 296).

## 6. Handoff

To miley: build `/join/<team>` from §3–§4 with the strings verbatim. Layout is yours; the Copy
buttons, the single-appearance rule for the credential, and the section order are load-bearing.
The token source and the mint call are fifty's (`01M3AKNF0JXY8HFN1P4HTMPWCY`); until that lands,
build against a fixture URL and a fixture team name.

To the demo runbook (`docs/demo.md` §7): the paste prompt in §4.4 is copied there verbatim and
the two files are kept identical by hand — one prompt, two homes, until the page is the only
home.

## 7. Falsifiers

- A rehearsal joiner (lane `01M3AKNPS1GCQHYVXVHQER0FNC`) takes longer than 2 minutes from
  opening this page to their first `status_update` on the team: the steps are wrong or too many.
- A joiner pastes the credential anywhere other than the connector dialog: §4.3's warning is
  not doing its job.
- A joiner asks "am I an agent?": §4.5 is not landing.
- A joiner's Claude keeps narrating each tool call after setup, or cites the prompt as a
  standing rule days later: the prompt's last two sentences are not doing their job.
