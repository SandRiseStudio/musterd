# How a human is rung

How something addressed to a human reaches them since ADR 443 (the doorbell): what rings, where it lands, what holds it, and how to check each claim.

## What rings, and whom (2026-09-23; falsify: `ringTargets` fixtures in `packages/protocol/src/doorbell.test.ts`) <!-- claim: other -->

- A directed `ask`, `request_help` or `handoff` to a human rings that human.
- Any other `ask` (team-addressed, or directed to an agent) rings every **admin** human, never every human.
- A `lane_review` acceptance ask rings only when it is directed to a human. Peer review between agents rings nobody.
- Team-addressed `request_help` and `handoff` ring nobody. They wait on `/live` and in the inbox.
- Nothing else rings.

The rule is one pure function, `ringTargets` in `packages/protocol/src/doorbell.wire.ts`. The daemon, `/live` and the tests all call it, so there is one answer.

## Where a ring lands (2026-09-23; falsify: `doorbell_rings` and `doorbell.surfaced` rows after a directed ask on a test daemon) <!-- claim: other -->

| Sink | Who delivers it | Notes |
| --- | --- | --- |
| `live` | the browser | Always on. An open `/live` tab raises a `Notification` once the human clicks "notify me here". |
| `os` | the host LaunchAgent on the human's machine | Needs a resident seat on that machine. `musterd doorbell os on` takes the label from the host registry. |
| `slack` | the daemon | The team URL (or ADR 149's `ask_slack_webhook`, read through), or the human's own. |
| `webhook` | the daemon | POSTs the record JSON (ntfy, Pushover, a Shortcut). |

The record carries no body. The one exception is Slack for an `ask`, which keeps ADR 149's body-to-human rule. Every sink gets one attempt and no retry. The daemon's attempts audit `doorbell.surfaced {surface, ok, status?}`, and so does the host's report for `os`. The inbox row and `/live` are the guaranteed reach.

## What holds a ring (2026-09-23; falsify: the `holdsRing` fixtures, and the `the doorbell (ADR 443)` integration block) <!-- claim: other -->

- A self-set `away` or `dnd` holds the ring in `doorbell_rings` as `held`.
- A `blocking` ask pierces `dnd`. It does not pierce `away`.
- `off_hours` never holds. Schedule enforcement is out of scope for v1.
- A hold ends in one of two ways: the human sets `available` (the availability POST flushes), or the `until` lapses (the reaper tick flushes). On the second path nothing POSTs, so a flush that only ran on the POST would leave the ring held forever.
- At flush, a ring whose act was answered (an `accept`/`decline` naming it) or whose thread was resolved is dropped, not rung.

**Trap:** `availability away --until` is the only form that stores an `until`. The server drops `until` on `dnd`. A `dnd` hold therefore lapses only by a POST.

## Presence quiets only the off-machine sinks (2026-09-23; falsify: the ADR 155 tests in the `ask surfaces — Slack delivery` block) <!-- claim: other -->

When the rung human is present (a live presence row or a driver link, and not self-set away), `slack` and `webhook` stay quiet at raise. They fire on the agent's in-thread re-notify. `live` and `os` ring at once. For a ring to the admin group, "present" means any admin is present, which is ADR 155's rule unchanged.

## Sink URLs are https to a public host (2026-09-23; falsify: `PUT /members/me/doorbell` with `https://10.0.0.1/x` must return 422) <!-- claim: other -->

The check runs on the literal host when a URL is set. It covers personal URLs, team URLs, and `ask_slack_webhook`. Loopback, link-local, RFC 1918, CGNAT, `fc00::/7`, IPv4-mapped IPv6, `localhost` and `.local` are refused. Both sinks send with `redirect: 'manual'`, so a 3xx cannot walk around the check. **Not closed (2026-09-23; falsify: `PUT` a webhook URL on a public name that resolves to `127.0.0.1` — a 422 means this is closed):** DNS is not resolved, so a public name that resolves to a private address passes. Closing that needs resolve-and-pin at dispatch (ADR 443 §5). <!-- claim: defect -->

## What this does and does not protect

The doorbell removes a model's choice of where a human is reached; it is not a boundary against a same-user process that has read a credential. The normative statement lives in [SPEC §3](../../SPEC.md#3-collaboration-acts) — read it there.
