# 289 — Interactive Slack ask replies

- Status: accepted
- Date: 2026-08-19
- Builds on: [ADR 149](149-ask-surfaces.md), [ADR 147](147-human-ask-stream.md), and
  [ADR 145](145-human-role-refounded.md)

## Context

ADR 149 made Slack the loud outbound surface for a raised `ask`: an optional incoming webhook gets
the ask body and its tier contract, while the daemon remains the source of truth. The human can reply
from `/live`, where an authenticated Member emits an ordinary `accept`, `decline`, or `wait` Act.

That still requires a context switch. The generic Slack-surface item is reserved because a full Slack
Surface would broaden musterd into chat integration. The narrow next increment is to let a human take
one of those existing ask-reply actions from the Slack notification itself.

## Problem

An interactive Slack control needs an inbound transport and a trustworthy mapping from a Slack account
to a durable human Member. A public Slack Request URL would require a publicly reachable HTTPS daemon,
which conflicts with musterd's local-first deployment. Accepting an arbitrary Slack click, or asking
a person to paste an `mscr_` credential into Slack, would violate Member identity and credential
boundaries.

## Decision

Use Slack Socket Mode for a narrowly scoped, opt-in ask-reply Surface.

- A Team configures its Slack workspace id and app-level Socket Mode token; its existing
  `ask_slack_webhook` remains the outbound delivery endpoint. These values are admin-only secrets,
  masked on display and never logged or audited.
- An admin explicitly links a Slack user id to one existing active human Member. The mapping is
  durable and unique within the Team. Slack never creates a Member, and an agent Member cannot be
  linked.
- Slack notifications render Block Kit controls for **Approve**, **Deny**, and **Deciding — 1h**.
  A received action is accepted only when its workspace, linked Member, open ask, and ask audience
  all validate. It composes the same ordinary `accept`, `decline`, or `wait` envelope `/live` emits,
  then calls the existing routing path. Slack owns no decision state.
- Socket Mode is outbound from the daemon. It acknowledges delivery promptly, reconnects with bounded
  backoff, and supports Slack-requested connection replacement. A durable external-delivery key makes
  retries idempotent before an Act can be appended.
- A best-effort Slack update may mark the notification settled after routing succeeds. It is cosmetic:
  no Slack network failure can roll back or delay the durable musterd Act.

This increment does not add Slack free-form messaging, Slack-created Members, per-channel routing,
public HTTP ingress, OAuth distribution, or a general Slack inbox.

## Consequences

- Add a nullable Slack user id to the `members` projection and a unique `(team_id, slack_user_id)`
  index, plus an admin-only link/unlink command and HTTP boundary.
- Add sparse Team policy fields for the Socket Mode app token and Slack workspace id, following the
  existing webhook-secret handling. Update `@musterd/protocol` schemas, `SPEC.md`, the server data
  model, CLI help, and architecture documentation together.
- Add a server-owned Socket Mode supervisor and a small durable interaction-dedup store. No new
  runtime dependency is introduced; the existing WebSocket runtime is used.
- Audit non-secret facts only: link/unlink, inbound action accepted/rejected, replay discarded, and
  delivery/update outcome. Existing `ask.raised` and reply Acts remain the semantic lifecycle record.
- Socket Mode is appropriate for a Team-installed app, not a Slack Marketplace app. A future public
  HTTP/OAuth distribution path is a separate decision.

## Observability & Evaluation

**Traces** — record a Slack interaction outcome with Team, linked Member, ask id, action kind, and
non-secret result; never raw payloads, tokens, webhook URLs, or bodies. Correlate accepted actions to
the ordinary reply envelope and existing `ask.*` audit chain.

**Eval** — measure the share and latency of asks answered from Slack, compared with `/live`, while
requiring zero duplicate reply Acts under simulated redelivery and zero accepted clicks from an
unlinked or ineligible Member. The baseline is ADR 149's outbound-only Slack surface.

**Experiment** — dogfood one explicitly linked human Member with Socket Mode enabled. Success is a
real ask answered from Slack that appears indistinguishably in `/live`, CLI, MCP, and audit; any
identity mismatch, replay, or Slack outage must leave the message log correct.
