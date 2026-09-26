# 457 — OAuth accepts the RFC 8707 resource indicator

- Status: accepted
- Date: 2026-09-26
- Lane: `01M3FER4N2PNTHDA6S86CAV38K`
- Relates to: [ADR 446](446-remote-mcp-https-oauth.md), [ADR 450](450-join-link-invite.md)

## Context

Rehearsal A (lane `01M3AKNPS1`, 2026-09-26) put a real Claude iPhone in front of the daemon
through a quick Cloudflare tunnel for the first time. After the discovery-path fix (#1752) the
sign-in page loads. The next failure is invisible on the box: the human completes the invite form,
the browser is redirected with a code, and the client's token exchange is refused with
`400 invalid_request`.

The MCP authorization spec (2025-06-18 §2.8, "Resource Parameter Implementation") makes RFC 8707
mandatory for clients: every authorize and token request carries `resource=<the MCP endpoint>` so
a token minted for one server cannot be replayed at another. Claude, Codex and every SDK client
send it.

`OAuthTokenRequestSchema` in `@musterd/protocol` is `.strict()` on both grant arms, so the extra
field fails parsing. The authorize query schema is a plain object and silently dropped it. The
load bench (lane `01M3D4069F`) never sent the parameter, so 50 synthetic humans passed.

Reproduced live against the rehearsal daemon (`/tmp/rehearsal.db`, quick tunnel): the same
authorization code exchanged with `resource=` → 400; without it → 200.

## Problem

A hard rule says protocol schemas change only with an ADR. The schema must admit the parameter a
spec-following client always sends, and the server must decide what the value means: ignore it,
or bind the token to it.

## Decision

1. `OAuthAuthorizeQuerySchema` and both arms of `OAuthTokenRequestSchema` gain
   `resource: z.string().url().optional()`. Absent is still valid (the pre-ADR client shape).
2. When present, the server compares it to this team's protected-resource `resource` value
   (`https://<host>/mcp/<team>`, trailing slash tolerant). A mismatch is `400 invalid_target` on
   the token endpoint (RFC 8707 §2) and `400 bad_request` on authorize. The daemon is the
   authorization server for exactly one audience per team, so there is nothing else to bind to.
3. No new token claims: `msat_` is already team-scoped by construction (ADR 446 §2), which is the
   audience binding RFC 8707 asks for.

## Consequences

- MCP clients complete the token exchange. Codex CLI, which also sends `resource`, is unblocked by
  the same change.
- A client that points a token request at a different team's endpoint is refused with the
  standard error, not a schema-parse message.
- The bench harness (`scripts/perf/demo-audience-load.mjs`) should send `resource` so it exercises
  the client shape the demo actually sees; tracked in lane `01M3D4069F`.

## Observability & Evaluation

- Traces: the token endpoint's existing `oauth.token` audit row; an `invalid_target` refusal is a
  400 with that error code, visible in the daemon log beside the client id.
- Eval: `oauth-http.test.ts` "RFC 8707 resource indicator (ADR 457)" — accept on code and
  refresh, `invalid_target` on mismatch, 400 on a mismatched authorize. Baseline: the same token
  request without `resource`, which passed before and after.
- Experiment: Rehearsal A's real Claude and Codex clients through the tunnel reach `tools/list`
  after the invite form; the wiki page for the run records pass/fail per client.
