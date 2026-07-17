# 149 — Ask surfaces: Slack delivery + the loud /live asks strip

- Status: accepted — 2026-07-17. Implements the third backlog item ADR 145 re-sequenced
  (`ask-surfaces`) — the surfaces ADR 145 §3.2 says ship _with_ the stream, not after it.
- Date: 2026-07-17
- Builds on: [ADR 147](147-human-ask-stream.md) (the ask stream this surfaces — species/tier/contract,
  the four `ask.*` audit rows, `deliverToAdmins`), [ADR 145](145-human-role-refounded.md) §3.2 (the
  decision: "a Slack message naming what needs approving/deciding, and a loud, prominent asks/approvals
  element on /live"), [ADR 035](035-localhost-notify-daemon.md)/[ADR 044](044-notification-tiers-localhost.md)
  (the client-side notification ladder this deliberately steps outside, and why), [ADR 061](061-team-firehose-observer-stream.md)/[ADR 063](063-hidden-readonly-observer.md)
  (the firehose + observer substrate the /live strip renders from), [ADR 076](076-v0.3-p3-agent-key-grants-policy.md)
  (the team policy the webhook knob rides), [ADR 042](042-humans-multi-presence.md) (human fan-out —
  why a human seat can answer from the browser while present elsewhere)

## Context

ADR 147 shipped the spine: agents reach a human through one act (`ask`) that carries a contract. But it
deliberately rode "today's surfaces" — admin live-push, the CLI inbox, the /live firehose — and the
record is unambiguous about those: **a channel the human doesn't inhabit is a dead letter box, however
good its acts** (ADR 145 Context: nick never once opened the CLI inbox; the notification ladder carried
zero traffic to him). The founder named the two surfaces he actually lives in (ADR 145 Appendix A, A3):
a Slack message naming what needs deciding, and a loud element on the /live office screen. The
sequencing rule ("surfaces before more acts") makes this the mandatory next increment: the stream is
live, and until it is loud it reproduces the dead inbox with more machinery.

## Problem

Deliver an `ask` to Slack and to /live such that (a) delivery cannot depend on a client process the
human forgot to run — the exact failure mode `musterd notify` (ADR 035) leaves open, (b) the daemon's
send path never blocks or fails on a slow/dead external endpoint, (c) no secret lands in git or in a
non-admin read, and (d) the /live element is answerable — an ask a human sees should be a click, not a
context switch to a CLI he has never opened.

## Decision

Two surfaces, one substrate. Both render/deliver the ADR 147 stream as-is — no new acts, no new tables,
no wire-version bump.

### 1. Slack delivery is the daemon's job — the one outbound call musterd makes

ADR 035/044 kept notification **client-side** on principle ("the server is a clean coordination core"),
and the record then showed the principle's cost: a client-side notifier only reaches a human who keeps a
client running, and this human doesn't. An ask's delivery guarantee ("escalations always technically
reach the human", ADR 145 §3.1) cannot rest on a LaunchAgent the human never installed. So Slack
delivery runs **in the daemon**, on the same seam as the admin live-push (`routeEnvelope`'s
`act === 'ask'` branch):

- **Config**: one optional team-policy field, `ask_slack_webhook` (a Slack _incoming-webhook_ URL) on
  `PolicySchema` (ADR 076), set via `musterd team policy --ask-slack-webhook <url|off>` (the same
  read-merge-write the other knobs use, audited `policy.change`). Unset (the default) means the feature
  is entirely off — no outbound call ever. The URL is a secret: policy is admin-only readable
  (`GET /policy` is `authAdmin`), `team export` (ADR 058) serializes seats/lifecycle only and never
  policy, and the CLI's policy display masks the URL to its host. It is never audited or logged.
- **Dispatch**: on `ask.raised`, if the webhook is set, the daemon fires **one fire-and-forget POST**
  (global `fetch`, no new dependency; 5s abort). It runs _after_ persist + deliver, detached from the
  request path: a slow or dead Slack can neither delay nor fail the send. No retry, no queue — the
  durable message row and the admin push (ADR 147 §3) remain the guaranteed reach; Slack is the _loud_
  reach, best-effort by design (exactly the posture `appendAudit` itself takes).
- **Message**: text-only payload naming what the tier machinery knows — who asks, the species verb
  ("asks what you think" / "escalated to you" / "needs your approval", the `notify/select.ts` phrasing),
  the tier and its contract in words ("blocking — holds after 15m without an answer"), the body, and
  the answer affordance ("answer on /live, or: musterd send --act accept …"). Bodies go to Slack by
  intent — this is delivery to the human, not telemetry (the ADR 051 no-bodies rule governs traces, not
  the inbox).
- **Trace**: each attempt audits `ask.surfaced` — detail `{ surface: 'slack', ok, status? }`, never the
  URL, never the body. The row sits beside `ask.raised`, so "was the loud reach attempted, did the
  endpoint take it" is one audit query.

Not built: per-species/per-tier routing to different channels, Slack _interactive_ answers (buttons →
daemon callbacks require public ingress — musterd is loopback-bound, ADR 039/040), and posting
lifecycle rows (`deferred`/`held`/`risk_accepted`) to Slack. All are seams on this one dispatch point.

### 2. The /live asks strip — loud, above the fold, answerable

A dedicated **asks & approvals strip across the top of the /live canvas** (the "own component" option
ADR 145 §3.2 names) — not a fourth column, because loud means _first thing seen_, not _fourth panel
scanned_:

- **Derivation is client-side and pure**: the page already holds every envelope (backfill + `team-all`
  firehose, ADR 061); a new `deriveAsks(envelopes)` folds them into ask threads — the ask, its
  species/tier, and its resolution state: **open** (unanswered, with a live countdown against
  `ASK_TIER_DEFAULTS` — the same protocol constant the agent's clock reads, so the surface and the
  agent agree on the deadline), **answered** (an `accept`/`decline` referencing it), **deferred**
  (`wait` + `meta.ask_ref`, showing ⟨until⟩), **held**, or **risk-accepted** (`status_update` +
  `meta.ask_outcome`). No new endpoint, no polling.
- **Loud**: when any ask is open the strip is impossible to miss — accent-bordered cards, count in the
  page title, the office's attention grammar. With nothing open it collapses to one quiet line; with no
  asks in history it renders nothing. An `ask` also joins the stream's act grammar (tone/glyph/label +
  arrival chime) so the firehose row reads as what it is.
- **Answerable, by the seat you actually are**: the strip shows answer affordances — **accept**,
  **decline**, and **"deciding — check back in ⟨1h⟩"** (the ADR 147 §5 `wait` + `ask_ref`/`until`
  reply) — exactly when the connected seat is a real roster member (the existing "Advanced — connect as
  a specific seat" sign-in, their `mscr_` credential). Answers are ordinary envelopes through the
  existing `POST /messages` (member-authed; `in_reply_to`/`thread` bind them to the ask, so the CLI,
  MCP, and audit see a browser answer identically to any other). The default auto-provisioned observer
  is read-only by construction (ADR 063) and sees the strip without buttons — a watch-link viewer can
  never answer an ask.
- **Approvals ride along**: the strip's title is "asks & approvals" — seat-claim requests (the ADR 077
  lane) keep their `/approvals` page, which the strip links to when the connected seat is an admin with
  pending requests, so one glance at /live covers both kinds of waiting-on-you. (Merging the two queues
  into one component is deliberately not done: they answer through different verbs against different
  substrates, and the strip must stay one screen tall.)

### What this deliberately does not build

- **Answer-from-Slack** (interactive buttons) — needs public ingress or a Slack app + socket mode;
  named seam, revisit if/when musterd runs off-loopback (ADR 039/040 already secured that bind).
- **Presence-aware delivery** ("suppress Slack when the human is visibly on /live") — that is the
  presence ladder, item 4 (`human-presence-ladder`); until it ships, Slack fires on every ask, which
  errs loud — the correct error for a stream whose baseline is zero traffic ever reaching the human.
- **The fallback routing surface** (`ask_fallback_to_nonadmin`, ADR 147 §6) — the flag exists; showing
  non-admin humans their fallback asks distinctly is `multi-human-admin` territory (needs a second real
  human).

## Consequences

- **The daemon makes its first outbound network call** — opt-in, per-team, to an admin-configured URL,
  fire-and-forget, after the send path completes. The "clean coordination core" posture (ADR 035 §3)
  is narrowed, not abandoned: the server still runs no notification _policy_ (no tiering, no
  suppression, no retry state) — it executes one delivery instruction the team configured, because the
  alternative provably delivers nothing.
- **One policy field, one audit action, zero schema changes.** `ask_slack_webhook` rides the policy
  JSON blob; `ask.surfaced` appends to the `AuditAction` union; the web surface is pure derivation over
  existing reads.
- **A browser answer is a first-class answer.** It flows through the same envelope validation, loop-
  closure metrics (ADR 082), and ask lifecycle audit as a CLI answer — surfaces multiplied, semantics
  unchanged.
- **The webhook URL is team-trusted, not verified.** An admin can point it anywhere; the daemon POSTs
  ask summaries (including bodies) to it. That is the admin's call, matching how the admin could
  already read everything the webhook receives.

## Observability & Evaluation

**Traces** — `ask.surfaced` (detail `{ surface: 'slack', ok, status? }`) beside each `ask.raised`: the
loud reach's attempt + outcome, one row per ask, no URL and no body. The /live strip adds no rows — it
is a pure view over the message log; its answers land as ordinary envelopes and the existing ADR 147
lifecycle rows (`ask.deferred` etc.) record them.

**Eval** — headline, inherited from ADR 147 and now actually movable: **latency-to-human-answer**
(`ask.raised.ts` → answering reply ts), cut by species/tier — the pre-registered ADR 145 experiment
asks whether a tiered stream _on lived-in surfaces_ produces non-zero human-answer traffic where the
ladder produced none; this increment is the "lived-in surfaces" arm. Secondary: **share of asks
answered before their tier timeout** (did the loud reach beat the agent's clock?) and **share of
`ask.surfaced` with `ok: false`** (a misconfigured webhook should be visible in one query, not
discovered by silence). Guard metrics (must not move): the send path's latency and failure rate on
teams with the webhook set vs unset (fire-and-forget means Slack's health never shows up there), and
zero `ask.surfaced` rows on teams that never set the knob (the default is genuinely off). Dataset: the
dogfood team's audit log; baseline: ADR 147's shipped state (asks reach the admin push and an inbox
the human doesn't open).
