# 443 — The doorbell: humans are rung through musterd surfaces only

**Date:** 2026-09-23
**Status:** Accepted
**Lane:** 01M37QFX4M6MFXJB3Z1KYEQMZE
**Extends:** [ADR 149](149-ask-surfaces.md) (Slack delivery moves behind a sink interface),
[ADR 222](222-answerable-asks-on-live.md) (the `/live` strip gains a browser notification)
**Builds on:** [ADR 147](147-human-ask-stream.md) (ask routing to admin humans),
[ADR 044](044-notification-tiers-localhost.md) (`blocking` pierces `dnd`),
[ADR 155](155-human-presence-ladder.md) (present-admin quiet at raise),
[ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) §4 (daemon-composed lines carry structured fields only)
**Spec:** `docs/superpowers/specs/2026-09-23-reach-and-boundaries-design.md` §1, §7
**Plan:** `docs/superpowers/plans/2026-09-23-the-doorbell.md` (reviewed by dolly, 2026-09-23)

## Context

On 2026-09-22 a woken seat raised an `ask` to nick. The daemon returned a `delivery_hint` because
nick had fresh presence, and the relay skill told the seat to pick "a session the human is actively
driving". The seat picked a non-musterd session, which then ran `musterd inbox --as nick`. The spec
records the whole chain. The wall (spec §2, lane 1) removes the relay and every `delivery_hint`.

The wall takes away the only path that reached a human's desk quickly. Before this ADR, the reach
to a human was: the durable inbox row, the admin live-push, the `/live` asks strip (ADR 149, ADR
222), and one team Slack webhook for asks only (ADR 149). A handoff or `request_help` directed to a
human rang nothing. There was no OS banner unless the human ran `musterd notify` (ADR 035), and
nick does not run it.

## Problem

Ring a human when something is addressed to them. The ring must:

- go only through surfaces musterd owns, never through a harness session;
- carry no body, except where ADR 149 already decided a body goes to the human;
- respect the human's own availability and choices;
- never slow or fail the send path;
- keep personal endpoints private.

## Decision

### 1. The record

The daemon composes one **doorbell record** per rung human, from structured fields only (the ADR
088 §4 discipline): `team`, `from`, `act`, `species?`, `tier?`, `act_id`, `deadline_ms?`,
`answer_path` (`/live?act=<id>`). The record has **no body**, and the schema is strict, so it
rejects one. The record is what the ring queue stores and what a `webhook` sink POSTs.

The one exception is the `slack` sink for an `ask`. It keeps ADR 149's deliberate body-to-human
rule. The body is read from the envelope at dispatch and is never stored in the record, the ring
queue, or an audit row. A handoff's or `request_help`'s body is not an ask's, so ADR 149's exception
does not cover it, and Slack names only who and what.

### 2. What rings

- **`ask`**, every tier. A directed ask to a human rings that human. **A team-addressed ask rings
  every admin human (ADR 147 routing), never every human; spec §1's "team-addressed acts do not
  ring" covers `request_help`, `handoff` and review acts only.** An ask directed to an agent also
  rings the admin humans, as ADR 147 routes it today.
- **`request_help`, `handoff`, and review/acceptance asks** ring only when **directed** to a human
  member. Team-addressed ones wait on `/live` and in the inbox.
- Nothing else rings: `message`, `status_update`, `steer`, `insight`, `accept`, `decline`,
  `resolve`, and the rest.

The rule is one pure protocol function, `ringTargets`. The server passes the roster facts in.

### 3. The sinks

| Sink | Surface | Where it runs |
| --- | --- | --- |
| `live` | the `/live` asks strip, plus a browser `Notification` from an open tab | the browser — always on, cannot be switched off |
| `os` | an OS banner | the **host** LaunchAgent on the human's machine polls its rings and raises the banner |
| `slack` | a Slack incoming webhook | the daemon (ADR 149's dispatch, moved behind the sink interface) |
| `webhook` | a generic POST of the record (ntfy, Pushover, an iOS Shortcut) | the daemon |

The `os` sink runs on the host, not in the daemon. The daemon may be a synced peer on another
machine. The host is the one process already running on the human's own machine. A ring carries a
host label, and only the host enrolled under that label raises it.

Each sink gets one attempt, detached from the send path, and never throws into `routeEnvelope`. A
team URL shared by several rung humans is POSTed once per act, not once per human. Each attempt
audits **`doorbell.surfaced {surface, ok, status?}`**: never the URL, never a body. This generalizes
ADR 149's `ask.surfaced`. New rows use the new action; the old action stays in the audit union, so
old rows still read.

### 4. Routing

- **Team policy** (`PolicySchema.doorbell`) holds the **allow-list** of sinks, the **defaults**, and
  the team's Slack and webhook URLs. Admins set it.
- **Each human** overrides within the allow-list: which sinks are on, per-tier rules, a personal
  Slack or webhook URL, and the `os` sink's host label. A personal URL wins over the team URL for
  that human.
- `live` is always in the route.
- **Availability.** A self-set `away` or `dnd` **holds** the ring. `blocking` pierces `dnd` (ADR
  044). `off_hours` does **not** hold: schedule enforcement is out of scope for v1 (AGENTS.md). A
  held ring is flushed when the human sets `available`, and on the daemon's sweep when the
  availability lapses by its `until`. At flush, a ring whose act has been answered — an `accept` or
  `decline` replying to it, or a `resolve` of its thread — is dropped, not rung. An unanswered ask
  still rings at flush after its deadline has passed and its contract has PROCEEDed: the ask is
  still open, and the human can still answer it. A ring for a human who has left, or on an
  archived team, is closed at the sweep, not rung.
- **Held is not unreachable.** A held ring is delayed, not lost. So a human who is `away` with an
  off-machine sink still counts as reachable for ask routing (ADR 147) — the same as before this
  ADR. Do not change that into "away is unreachable": it would strand asks that the flush delivers.
- **Retention.** `done` rings, and `queued` rings no host claimed, are deleted after 30 days on the
  daemon's sweep. `held` rings are kept for as long as the hold lasts.
- **Presence (ADR 155 Increment 2) applies to the off-machine sinks only.** When an admin human
  composes as present, `slack` and `webhook` stay quiet at raise and fire on the agent's in-thread
  re-notify. `live` and `os` ring at once. This can only under-ring, never mis-deliver.

**A deliberate change from ADR 149.** Before this ADR, Slack fired at raise when every admin was
away, on the reasoning that an away human is best reached off-machine. Under the spec, a self-set
`away` or `dnd` is the human's own "hold my rings", and `blocking` is what pierces `dnd`. An `away`
human still gets every held ring the moment they come back. `off_hours` is not a hold, so the
"reach me while I am not at my desk" case keeps working through it.

### 5. Personal URLs are private, and public

A human's personal URL is readable only by that human. An admin reading a teammate's doorbell sees
`{sink, on, personal: true}` and never the URL. One function, `maskPrefs`, serves every non-self
read. A URL is never logged, audited, or echoed in an error.

Every sink URL, personal or team, must be `https` to a public host. A `PUT` with an `http` URL, or a
host that is loopback, link-local, or private (RFC 1918, `fc00::/7`), is rejected with 422, naming
the sink. Otherwise a non-admin human's personal URL makes the daemon POST into the local network.
The check is on the literal host at `PUT`; it does not resolve DNS. A public name that resolves to a
private address is not caught. That is recorded, not closed: closing it needs a resolve-and-pin at
dispatch.

### 6. Compatibility

`ask_slack_webhook` stays in `PolicySchema`. When `doorbell.slack_url` is unset, `getPolicy` reads
`ask_slack_webhook` through as the team's `slack` URL, with `slack` in the defaults. The stored blob
is not rewritten. `musterd team policy --ask-slack-webhook` keeps working unchanged.

`adminHumanReachable` (ADR 153) counts a team as notifiable when any admin human has an off-machine
sink configured, not only when `ask_slack_webhook` is set.

### 7. No agent configures a human's doorbell

`musterd doorbell` is a CLI command for human members. There is no MCP tool for it. Agents do not
choose where a human is rung.

### What this does and does not protect (spec §7)

The wall (§2), the pointer rule (§4) and binding-only identity (§6) prevent **cross-session and
cross-identity mistakes by models** — the incident's class. They are **not** a boundary against a
**hostile process under the same OS user**: such a process can read any binding or config file,
`cd` into any Workspace, or call the daemon's HTTP API directly with a credential it read. Closing
that is credential custody — ADR 200 and ADR 341 (agents under distinct OS users), and §8's
credential work. The same holds for §6's layout and admin rule: they prevent mistakes; same-user
filesystem access and direct HTTP are outside this boundary.

The doorbell is the same: it removes the model's choice of where a human is reached. It does not
stop a same-user process from reading the ring queue or a human's prefs with a credential it read.

## Considered and rejected

- **A desk session**: the human names one harness session as theirs, and rings land there. It adds a
  binding that must itself be policed, and a stale binding reproduces the incident (spec §1).
- **Relaying into any seat session the human drives.** That is the incident.
- **An `os` sink in the daemon.** The daemon may not be on the human's machine.
- **Retrying or queueing off-machine sinks.** ADR 149's posture stands: the inbox row and `/live` are
  the guaranteed reach. The loud reach is best-effort, and a retry queue is a second delivery system
  to keep correct.
- **Answering from Slack.** Buttons need public ingress, and the daemon is loopback-bound (ADR 149).

## Consequences

- A handoff or `request_help` directed to a human rings them. Before, nothing did.
- A human sees an OS banner without running `musterd notify`.
- Team admins choose which sinks exist. Each human chooses which of those ring them.
- `ask.surfaced` rows stop being written. Queries that want both read `ask.surfaced` and
  `doorbell.surfaced`.
- A held ring is state the daemon keeps (`doorbell_rings`). A ring is `held`, `queued` (waiting for
  the host), or `done`.
- **2026-09-23 — which host label rings (the plan's Task 5 spike, landed with PR B).** The host
  polls once per (daemon, team, label) group in its registry, and the labels are the ones its
  resident seats enrolled under (ADR 131). A human's `os` sink stores one of those labels, and
  `musterd doorbell os on`, run on the human's machine, picks it from that machine's host registry.
  The ring poll uses the wake-lease poll's auth: the team agent key, or, after the bootstrap
  cutover, a credential scoped to exactly that label. So a host-scoped credential can claim only its
  own machine's rings. The host claims its rings in one transaction that marks them `done`. A second
  poll raises nothing twice, and a banner lost to a crash between claim and banner is not retried,
  like every other sink. A machine that runs no resident seat for the team has no host process, so
  it has no `os` sink. `live` and the off-machine sinks still reach that human. An agent holding the
  legacy team agent key can read the ring records for any label. Those records are the same
  structured fields the firehose already shows it, with no body. The host reports each banner once:
  `ok` is the notifier process's exit, not the call having returned, and a second report — or one
  for a ring claimed but not returned — is refused (409).
- **2026-09-23 — the ring rule is also on the zod-free wire entry (PR C).** `ringTargets`,
  `actMayRing`, `DOORBELL_SINKS` and `OFF_MACHINE_SINKS` moved to `doorbell.wire.ts` and are
  exported from `@musterd/protocol/wire`, so `/live` folds the same rule the daemon routes with,
  without shipping zod to the browser. `@musterd/protocol` re-exports them unchanged: no schema, no
  behavior and no import path changed for existing callers.

## Observability & Evaluation

- Traces: one `doorbell.surfaced` audit row per off-machine sink attempt, `{surface, ok, status?}`,
  with no URL and no body, beside the act's own row:
  `SELECT json_extract(detail,'$.surface'), json_extract(detail,'$.ok'), COUNT(*) FROM audit WHERE
  action = 'doorbell.surfaced' GROUP BY 1, 2;`. Holds are rows in `doorbell_rings` with
  `state = 'held'`. A held ring older than a day on a member who is `available` is a flush bug.
  `ask.surfaced` rows stop after this ADR ships; a new one means a path still calls the old dispatch.
- Eval: the dataset is the doorbell integration fixtures (`the doorbell (ADR 443)` in
  `transport/integration.test.ts`) and the protocol fixtures (`doorbell.test.ts`): what rings, holds,
  lapses, answered-meanwhile drops, URL privacy and the public-host check. The baseline is ADR 149's
  behavior: only an `ask` rang anything, only to one team Slack URL, and a directed handoff to a human
  rang nothing. Each fixture asserts the new behavior against it. The ADR 149 Slack fixtures still
  pass, moved from `away` to `off_hours`.
- Experiment: after the `os` sink ships, a directed ask to nick with only `live` and `os` on raises
  one banner on his machine within one host tick. If no banner appears, or any `doorbell.surfaced`
  row, log line or error carries a URL or a body, this decision is not implemented.
