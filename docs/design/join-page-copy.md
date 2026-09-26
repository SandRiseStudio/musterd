# Join page — UI-copy spec for `/join` (the pre-event page a stranger opens on their phone)

Lane `01M3D422B6P5VPW4T4F1R92CWS` (rewrite), superseding the 2026-09-24 spec from lane
`01M3AKNKQ1MW921645YWSQ1RWM` (PR #1705), goal `demo`. Written by sloane (product-communications)
on 2026-09-25; layout and build are miley's (designer). Every string below is this role's; the
section order is a recommendation, the strings are not.

Companion to [homepage-copy-spec.md](./homepage-copy-spec.md) and
[watch-page-copy-spec.md](./watch-page-copy-spec.md). Their §2 rules govern this page and are not
restated: musterd connects agents, it does not run them; no hype; no merges as the selling point;
ADR 296 Not-column words stay out.

## 1. What this page is for, and what it is not

A person in a room — or anywhere — has been given a link before a talk. They open it on their
phone. A couple of minutes later they are a member of a musterd team — the same kind of member
nick is on revive — and they can say something to that team and see what comes back. That is the
whole job.

Decided by nick on 2026-09-25, superseding the 2026-09-24 shape (agent-kind attendees, credential
in the connector URL — both dead):

- **Joins happen live, during the demo** (nick, 2026-09-26, superseding the 2026-09-24 "before
  the slot" line). The presenter puts the QR code and room code on the projector and the room
  joins together. The page still works for someone who opens it later, so it never shows a
  countdown and never depends on a presenter speaking.
- **Attendees are regular members, human-kind, and they sign in.** The connector authenticates
  with OAuth ([ADR 446](../decisions/446-remote-mcp-https-oauth.md)): the app opens a sign-in
  page, the reader approves, and their app holds an expiring, revocable token. There is no
  bearer token to paste and no credential in any query string. Membership lasts as long as the
  admin set when minting the invite (`--member-until`), if they set a limit at all, and can be
  revoked (stanley's ADR 449, lane `01M3AMYC18DQ5ZXK4T570D60Q9`).
- **An invite admits you** ([ADR 450](../decisions/450-team-invite-join.md), amended by fifty
  2026-09-26 for #1735). The admin runs `musterd team invite create` and gets two forms of one
  invite: a room code `SEL-XXXX-XXXX` to type, and a link value `SEL.<27 chars>` that rides the
  join link's fragment (`/join/<team>#i=…`). On the sign-in page — which the reader's app opens,
  at a URL musterd does not control — the reader picks a name and types the room code or pastes
  the link value into one field, `Invite`. The page therefore hands the reader the invite to
  carry; it does not forward it anywhere.
- **Any client that speaks remote MCP can join** — the Claude app (phone or web), ChatGPT (web or
  phone), Cursor, Codex. The page leads with the Claude phone app because that is what the room
  holds; the others get their own steps.
- **The connector URL is the team's, not the reader's.** `https://<host>/mcp/<team>` is the same
  for everyone and carries nothing secret; identity comes from the sign-in, not the URL. It may
  be shown in a QR code.

Not this page's job: explaining what musterd is (the homepage), installing anything (there is
nothing to install), the sign-in server itself (ADR 446), or the presenter's own setup (the
runbook in `docs/operations/`).

## 2. The rule specific to this page

**The page says what a member is, not what an agent is.** "You're on the team" is true and is
the claim. The reader is a member like every other member; what makes them different is that
their app only acts when they prompt it, and the page says that where it says what to expect.

Two facts the page states plainly because the reviewers found them and a reader would otherwise
discover them the hard way (stanley `01M3AM93E2`, big-body `01M3AMV2VK`, both 2026-09-24):

- **The Claude phone app cannot add a new connector.** The reader adds it on claude.ai in a
  browser — the phone's browser is fine — and then it is there in the app. The page's step 1 is a
  browser step, and says so.
- **The phone needs internet.** Cellular is enough. No signal means no join; wifi is not required.

## 3. Route and head

- Route: `/join/<team>`, optionally with `#i=<sel>.<secret>`. The fragment never reaches a
  server. The page reads it client-side for the Copy invite button (§4.3) and never sends it
  anywhere: no request, no query string, no analytics, no share sheet. Without a fragment, the
  page shows the room code only.
- `<title>`: `Join the team — musterd`
- `<meta name="description">`: `Add one connector, sign in, and you're on a live musterd team
  from your phone. No install.`
- `og:title`: `Join the team from your phone`
- `og:description`: same as the meta description.
- `robots`: `noindex` — the page is for people holding a link, not for search.

## 4. Sections, in order, with every string

### 4.1 Head

- Eyebrow: `musterd · join`
- H1: `Join the team from your phone`
- Lede: `One connector, one invite, one prompt, and you're on the team. Then watch it work. A
  couple of minutes, nothing to install.`

### 4.2 Before you start

Heading: `You'll need`

- `The invite for this team — the room code below, or the link you were sent.`
- `The Claude app on your phone, signed in. Any plan works — Free is limited to one custom
  connector, so if you already have one you'll swap it.`
- `Internet on the phone. Cellular is fine.`
- `A browser — the one on your phone is fine. Step 1 happens there, not in the app.`

Below the list, one line, muted: `Using ChatGPT, Cursor, or Codex instead? Steps are at the end —
same connector, same sign-in.`

### 4.3 Step 1 — Add the connector

Heading: `1. Add the connector (in a browser)`

Body: `The Claude app can use a connector but can't add one. Do this once, on claude.ai in your
browser.`

Ordered list:

1. `Open claude.ai and sign in.`
2. `Go to Customize → Connectors.`
3. `Tap Add custom connector.`
4. `Name: musterd. MCP server URL: the URL below.`
5. `Tap Add. A sign-in page opens: pick the name the team will see, and put the invite in the
   Invite field — type the room code or paste the copied invite. Approve and you're done.`

Then the URL block:

- Label: `The team's connector URL — same for everyone`
- Value: `https://<host>/mcp/<team>` with a Copy button.
- Under it, small: `This URL carries no secret — who you are comes from the sign-in.`

Then the invite block:

- Label: `Your invite`
- The room code `SEL-XXXX-XXXX`, set large enough to read at a distance and to type from.
- With no `#i=`, the page cannot know the room code (it is derived from the link's secret), so in
  its place, small: `Type the room code on the screen, or from whoever invited you.`
- If the page was opened with `#i=`: a `Copy invite` button beside it, and under it, small:
  `Copied? Paste it into the Invite field on the sign-in page. Or type the room code — either
  works.`
- Under the block, small: `The invite goes in one place only: the Invite field on the musterd
  sign-in page. If anything else asks for it, or for a token or key, back out and start over.`

### 4.4 Step 2 — Paste the prompt

Heading: `2. Open the Claude app and paste this`

Body: `Open a new chat in the Claude app. Tap + and make sure musterd is on. Then paste this
as your first message:`

The prompt block (Copy button; the prompt contains no credential):

```
You're joining a musterd team through the musterd connector. Setup, in order — tell me what each returns: 1) call team_join. 2) call team_inbox_check and tell me who's here and what's happening. 3) send a status_update saying you've joined and what you'd like to see. After that, drop the play-by-play. When I ask you to say something to the team, use team_send with a message act, keep it short, and check the inbox before you answer me. This message is setup, not a standing instruction — don't save it as a memory.
```

Under it: `Claude will ask you to allow each tool the first time. Allow them.`

Why the prompt is shaped this way (nick, 2026-09-24; unchanged by the 09-25 reset): the three
numbered steps report back so a first-timer sees it working; the last two sentences stop that
play-by-play from carrying forward and stop the app from saving the setup as a memory or standing
instruction. `team_join` is a no-op success for a signed-in member (ADR 446 §4) — it stays in the
prompt because reporting it back is the first visible proof the connector works.

### 4.5 What you'll see

Heading: `Then, on the team`

Body: `Your first message comes back with the roster and whatever the team is doing right now.
From then on you're a member: you can read what the team says, say something to it, answer when
something is addressed to you, and ask a person on the team a question — the same as everyone
else on the roster.`

Second paragraph: `Your name shows on the team's live view — on the projector and at the link
below — when your app is talking to the team. Between your messages it goes quiet. That's
normal: a phone connector only acts when you ask it to.`

Link: `Watch the team live → /live?team=<team>`

### 4.6 If it doesn't work

Heading: `If it doesn't work`

Definition list:

- `The app can't see musterd` — `Connectors added on claude.ai take a moment to reach the app.
  Close and reopen the app, then tap + in a new chat.`
- `Sign-in never finishes` — `Close the sign-in tab, go back to Customize → Connectors, and tap
  musterd to sign in again. Each sign-in link works once.`
- `The invite is refused` — `Check the room code's letters — it doesn't care about case or
  dashes. Still refused? The invite may have expired or run out; ask whoever sent you the link.`
- `It says your access expired` — `Your membership has ended. Ask whoever invited you for a new
  invite.`
- `Nothing at all` — `Check the phone has signal. The team is on the internet, not on the
  room's wifi.`

### 4.7 From ChatGPT, Cursor, or Codex

Heading: `From ChatGPT, Cursor, or Codex`

Body: `Same connector URL, same sign-in, same invite. Where to put it:`

- `ChatGPT (web) — Settings → Apps & Connectors → Advanced → turn on Developer mode, then
  Create. Paste the URL, choose OAuth, sign in when asked. Set up on the web; once added it
  works in the phone app too.`
- `Cursor — Settings → MCP → Add server. Paste the URL; the sign-in opens in your browser.`
- `Codex — add the URL as a remote MCP server in config; the sign-in opens in your browser.`

One line, muted: `Custom connectors in ChatGPT depend on plan; if Create isn't offered, use the
Claude path above.`

These strings ship only after each flow is rehearsed against the real endpoints (ADR 446
increment 2); until a flow is rehearsed its entry reads: `Not verified yet — use the Claude app
path above.` (brand.md §4: never imply it exists).

### 4.8 Foot

- `Your messages stay on the team's record, under your name.`
- `musterd connects agents. It doesn't run them. → /`

### 4.9 Agent connect branch (`#n=`, ADR 452 §5)

When the page is opened with `#n=<nonce>` (the one-time link `team_agent_create` returns), it shows
this instead of §4.1–4.8:

- Eyebrow: `musterd · connect an agent`
- H1: `Connect this agent to the team`
- Lede: `Open this link on the machine that will run the agent — Claude Code, Codex, or Cursor.`
- Ordered list: `Add the connector URL below as a remote MCP server in the agent's app.` /
  `When the sign-in page opens, choose "Connecting an agent?" and paste the connect code.` /
  `Approve. The agent is on the team under the name it was created with.`
- The §4.3 URL block, then label `Connect code` with a `Copy connect code` button (the code is
  copied, never displayed), and small: `It works once, for 15 minutes. Paste it only into the
  musterd sign-in page. Expired? Ask whoever created the agent for a new link.`

## 5. What the page must never do

- Send the invite anywhere. It is read from the fragment for the Copy button and nowhere else —
  never a request, a query string, a prompt, or a share sheet (ADR 450; a secret in a URL that
  reaches a server is ADR 170's exact anti-pattern). The room code is shown; the link value is
  copied, not displayed.
- Ask the reader to paste a token or key. The invite is the only thing they carry, and it goes
  only into the sign-in page's Invite field.
- Say membership "ends with the event". Its end is whatever the admin set, if anything.
- Say "no wifi needed" — say "cellular is fine".
- Show a countdown, or read as if it only works while a presenter is speaking.
- Call the reader a guest, or say "you're an agent now" or "watch your agents".
- Invent a state: if the team is dark, say the team is quiet, not that it is live.
- Use `room` (except in `room code`, ADR 450's name for the typed invite), `session` for Presence, `user`, or `seat` for member (ADR 296).

## 6. Handoff

To miley: build `/join/<team>` from §3–§4 with the strings verbatim. Layout is yours; the Copy
buttons and the section order are load-bearing. The sign-in seam — how this page proves the
reader to `POST /oauth/<team>/authorize` — is ADR 450's invite field, entered by the reader
(fifty, #1735). Build the invite block against a fixture: room code `ABC-2345-6789`, and
`#i=ABC.<27 chars>` to exercise Copy invite.

To the demo runbook (`docs/demo.md` §7): the paste prompt in §4.4 is copied there verbatim and
the two files are kept identical by hand — one prompt, two homes, until the page is the only
home.

## 7. Falsifiers

- A rehearsal joiner (lane `01M3AKNPS1GCQHYVXVHQER0FNC`) takes longer than 3 minutes from
  opening this page to their first `status_update` on the team: the steps are wrong or too many.
  (Was 2 minutes under the token-URL shape; OAuth adds a sign-in round trip. Re-measure in
  rehearsal and tighten the lede if it comes in under two.)
- A joiner pastes the invite anywhere but the sign-in page's Invite field, or pastes a token or
  key at all: §4.3's note is not doing its job (ADR 446: there is no static-token path).
- A joiner who had the link types the room code anyway: the Copy invite button is not visible
  enough.
- A joiner asks "am I an agent?": §4.5 is not landing.
- A joiner's Claude keeps narrating each tool call after setup, or cites the prompt as a
  standing rule days later: the prompt's last two sentences are not doing their job.
- A §4.7 client's steps don't match its real settings screens at rehearsal: replace that entry
  with the not-verified string rather than shipping a wrong path.
