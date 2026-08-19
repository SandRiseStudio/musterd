# Interactive Slack ask replies — design

## Goal

Let an explicitly linked human Member answer an existing `ask` from its Slack notification. The
result must be the exact ordinary musterd Act that `/live` would send: `accept`, `decline`, or `wait`.

## Scope

This is a Slack **ask-reply** Surface, not a chat integration. It uses Socket Mode so the local daemon
connects outward to Slack; it does not expose a public HTTP endpoint.

In scope:

- Block Kit controls on the existing ask webhook notification.
- Explicit admin link and unlink of a Slack user id to an existing human Member.
- Socket Mode connection, action validation, idempotency, and best-effort settled-message update.
- Envelope, audit, and `/live` parity tests.

Out of scope:

- Free-form Slack messages, a Slack inbox, or Slack-created Members.
- OAuth/Marketplace installation, Slack Connect, or public Event API ingress.
- Per-channel/per-tier routing, custom defer duration, and lifecycle-posting beyond the one settled
  notification update.

## Existing seam

ADR 149 already delivers raised asks through `ask_slack_webhook`. `/live` answers an ask by sending an
authenticated envelope to the existing messages route. The server's route path persists, delivers,
audits, and projects that reply for every other Surface.

Slack must reuse this seam. It cannot write a separate response table or mutate the ask row.

## Architecture

```
raised ask
  -> existing webhook POST with Block Kit controls
  -> Slack Socket Mode action
  -> Slack supervisor validates workspace + linked human Member + open eligible ask
  -> existing routeEnvelope(accept | decline | wait)
  -> message log, inbox delivery, audit, /live, CLI, MCP
```

The daemon runs one Socket Mode supervisor for each Team with complete Slack configuration. It opens
the dynamic Slack WebSocket using the app-level token, acknowledges every received Socket Mode envelope
promptly, reconnects with bounded backoff, replaces connections when Slack asks, and stops before the
daemon closes its database.

The existing incoming webhook remains the post target. Block Kit `action_id` selects the reply kind;
the button value holds only Team slug and ask id. That value is a lookup hint, never authorization.

## Data and admin boundary

`members.slack_user_id` is nullable and only valid for human Members. A unique index on
`(team_id, slack_user_id)` prevents a Slack account from representing two Members in one Team. It is
not returned on ordinary roster reads.

The Team's sparse policy gains:

- `ask_slack_workspace_id` — required alongside Socket Mode.
- `ask_slack_app_token` — an app-level token, admin-only and masked like the existing webhook URL.

An admin-only link API and CLI command set or clear the Member's Slack user id. The boundary parses
all command and HTTP input with protocol schemas; it rejects missing Members, agent Members, malformed
Slack ids, and a link already held by another Member.

`slack_interactions` stores a Team-scoped external delivery id and timestamp. Its uniqueness constraint
is the replay guard; it stores no raw Slack payload or secret. A completed or rejected delivery is
recorded before any repeat can route an Act.

## Action handling

For a Block Kit `block_actions` payload:

1. Acknowledge the Socket Mode envelope immediately.
2. Parse the outer envelope and inner interaction through protocol schemas.
3. Find the Team by configured Slack workspace id and fetch the linked Member by Slack user id.
4. Atomically reserve the external delivery id. A duplicate returns without composing an Act.
5. Re-fetch the referenced message and require a live `ask`; derive its current state and audience.
   The linked human must be eligible under the same rule the `/live` rail uses before it renders an
   action button.
6. Compose one ordinary reply envelope: `accept`, `decline`, or `wait` with `ask_ref` and `until: '1h'`.
   Route it using the existing server path under the linked Member.
7. Append a non-secret outcome audit. Then make a best-effort Slack response/update indicating the
   result. Failure here is recorded but never changes the routed Act.

An unlinked Member, wrong workspace, stale/closed ask, ineligible responder, malformed action, or
duplicate delivery never produces a reply Act. The human gets a short Slack-visible failure outcome
where Slack permits it; the daemon records only the category, not the payload.

## Security and failure handling

- Tokens, webhook URLs, raw Slack payloads, and ask bodies are never logged or audited.
- Socket Mode avoids an inbound public daemon port. A future Event API endpoint must be a separately
  designed secure-transport decision.
- The interaction's Slack user id is insufficient by itself: the stored Team-local link, workspace
  match, Member kind/status, ask state, and audience are all checked server-side.
- A Slack outage cannot delay the original ask send or undo a reply. The original webhook remains
  fire-and-forget; Socket Mode retry is isolated from request routing.
- Connection failures use bounded exponential backoff and surface a health/audit state without
  repeatedly creating work or sending duplicate replies.

## Verification

Unit tests cover Block Kit construction, parsing, workspace/user/action validation, reply-envelope
construction, redaction, and retry delay calculation.

Server integration tests use a fake Socket Mode transport and assert:

- a linked human's three actions produce `/live`-equivalent envelopes;
- an unlinked user, agent link, wrong workspace, stale ask, and ineligible Member are rejected;
- replay produces exactly one persisted reply;
- a failed Slack update does not affect routing;
- supervisor reconnect and shutdown leave no live timer/socket.

An owner-run dogfood check connects a development Slack app, links one human Member, raises one ask,
clicks each action in isolation, and verifies the resulting message and audit rows through `/live`.

## Documentation and rollout

The implementation updates `SPEC.md`, the protocol and server architecture chapters, the CLI help,
and the roadmap item to name the shipped interactive ask-reply scope while keeping a full Slack
Surface reserved. No credentials enter git: the setup guide names the required Slack app configuration
and the admin policy commands, but shows placeholder values only.

Rollout is off by default. Existing Teams continue receiving plain webhook notifications until an admin
sets both Socket Mode fields and explicitly links a human Member.
