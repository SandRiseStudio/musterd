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

- **Joins happen before the slot.** Unchanged. The link is shared beforehand; nobody joins during
  the talk. This page never says "now", never counts down, and never assumes a presenter is
  speaking.
- **Attendees are regular members, human-kind, and they sign in.** The connector authenticates
  with OAuth ([ADR 446](../decisions/446-remote-mcp-https-oauth.md)): the app opens a sign-in
  page, the reader approves, and their app holds an expiring, revocable token. There is no
  secret to paste and no secret in any URL. Membership expires with the event and can be revoked
  (stanley's ADR 449, lane `01M3AMYC18DQ5ZXK4T570D60Q9`).
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

- Route: `/join/<team>` — nothing secret rides the route or the fragment. How the page proves the
  reader to the sign-in step is fifty's seam (lane `01M3AKNF0JXY8HFN1P4HTMPWCY`, ADR 446 §6);
  this spec does not decide it.
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
- Lede: `One connector, one sign-in, one prompt, and you're on the team. Then watch it work. A
  couple of minutes, nothing to install.`

### 4.2 Before you start

Heading: `You'll need`

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
5. `Tap Add, then sign in when it asks. You'll see which team you're joining — approve it and
   you're done.`

Then the URL block:

- Label: `The team's connector URL — same for everyone`
- Value: `https://<host>/mcp/<team>` with a Copy button.
- Under it, small: `This URL carries no secret — who you are comes from the sign-in. If anything
  asks you to paste a token or key, you're in the wrong dialog: back out and start over.`

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
- `It says your access expired` — `Membership ends with the event. If the event is still on,
  sign in again from Customize → Connectors.`
- `Nothing at all` — `Check the phone has signal. The team is on the internet, not on the
  room's wifi.`

### 4.7 From ChatGPT, Cursor, or Codex

Heading: `From ChatGPT, Cursor, or Codex`

Body: `Same connector URL, same sign-in. Where to put it:`

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

- `This page and your membership end with the event. Your messages stay on the team's record,
  under your name.`
- `musterd connects agents. It doesn't run them. → /`

## 5. What the page must never do

- Show a secret anywhere, ask the reader to paste one, or put one in a URL, a QR code, a prompt,
  or a share sheet. Sign-in is always the app's own OAuth flow (ADR 446; a secret in a URL is
  ADR 170's exact anti-pattern).
- Say "no wifi needed" — say "cellular is fine".
- Say the reader will "join during the talk", or show a countdown.
- Call the reader a guest, or say "you're an agent now" or "watch your agents".
- Invent a state: if the team is dark, say the team is quiet, not that it is live.
- Use `room`, `session` for Presence, `user`, or `seat` for member (ADR 296).

## 6. Handoff

To miley: build `/join/<team>` from §3–§4 with the strings verbatim. Layout is yours; the Copy
buttons and the section order are load-bearing. The sign-in seam — how this page proves the
reader to `POST /oauth/<team>/authorize` — is fifty's (`01M3AKNF0JXY8HFN1P4HTMPWCY`); until that
lands, build against a fixture team name with the sign-in step stubbed.

To the demo runbook (`docs/demo.md` §7): the paste prompt in §4.4 is copied there verbatim and
the two files are kept identical by hand — one prompt, two homes, until the page is the only
home.

## 7. Falsifiers

- A rehearsal joiner (lane `01M3AKNPS1GCQHYVXVHQER0FNC`) takes longer than 3 minutes from
  opening this page to their first `status_update` on the team: the steps are wrong or too many.
  (Was 2 minutes under the token-URL shape; OAuth adds a sign-in round trip. Re-measure in
  rehearsal and tighten the lede if it comes in under two.)
- A joiner types or pastes anything secret-shaped during the flow: §4.3's note is not doing its
  job, or a dialog is asking for what it never should (ADR 446: there is no static-token path).
- A joiner asks "am I an agent?": §4.5 is not landing.
- A joiner's Claude keeps narrating each tool call after setup, or cites the prompt as a
  standing rule days later: the prompt's last two sentences are not doing their job.
- A §4.7 client's steps don't match its real settings screens at rehearsal: replace that entry
  with the not-verified string rather than shipping a wrong path.
