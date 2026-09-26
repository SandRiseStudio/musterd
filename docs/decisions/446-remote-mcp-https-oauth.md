# 446 — Remote MCP over HTTPS with per-seat OAuth, so phone apps can join a team

- Status: accepted — 2026-09-25 (increment 1 landed; rehearsal is increment 2)
- Date: 2026-09-24
- Lane: `01M3AKN6GFHZ3DGCJPRE4RG2TE` (goal `demo`)
- Builds on: [ADR 069](069-credential-namespaces.md) (credential namespaces) /
  [ADR 075](075-agent-key-claim.md) (agent key + claim) / [ADR 077](077-human-credential-claim.md)
  (human `mscr_` self-identifying auth) / [ADR 170](170-signin-handoff-relay.md) (the handoff relay:
  a nonce may ride a URL, a secret may not) / [ADR 337](337-agent-http-credential-lease.md)
  (self-identifying HTTP authority + Presence-bound lease) / [ADR 057](057-ambient-presence.md)
  (ambient presence) / SPEC A.2 (servers store only hashes) / SPEC A.7 (prefix-dispatch auth).
- Needs: one new runtime dependency for `@musterd/server` — `@modelcontextprotocol/server@2.0.0`
  (the same pin `@musterd/mcp` already ships; it carries `createMcpHandler`, the fetch-style HTTP
  rail). Alternative considered: hand-rolling Streamable HTTP framing in the daemon (no dep, but
  every interop subtlety with the two phone apps becomes ours to discover in rehearsal instead of
  the SDK's to have handled). The server does NOT import `@musterd/mcp` — the remote tools call
  the same store paths the REST routes use (`routeEnvelope`, `listInbox`), so there is one
  semantics, not two, and no cross-package import. stdio keeps the path it has.
- Review gate: [big-body](.) reviews security before merge (lane requirement).

## Context

The `demo` goal (2026-09-24, nick, today): an audience joins a live team from phones through the
Claude and ChatGPT apps while the presenter's team works in front of them. Anyone in the room adds
one connector, pastes one prompt, and is on the team — no laptop, no wifi, no install.

Today the musterd adapter is stdio-only (`packages/cli/src/onboard/mcpEntry.ts` builds a
`{ command, args, env }` entry; `packages/mcp/src/index.ts` `main()` serves exactly one transport,
`StdioServerTransport`). A phone app cannot spawn a local process. What it can do — both apps — is
add a **remote MCP server at a public HTTPS URL as a custom connector**, and both apps speak only
one dialect there: **Streamable HTTP with OAuth 2.1** (discovery → dynamic client registration →
authorization code with PKCE → bearer tokens). There is no static-token path: a URL that accepts a
pasted `mscr_` as a query param is not something either app will send, and musterd must never ask
for it (a secret in a URL is ADR 170's exact anti-pattern).

Sibling lanes carry the other halves: public route to the daemon (tunnel, wanderer), seat
provisioning from a URL (join link, fifty), connector steps per app (join page, sloane), rehearsal
(demo lane). This lane is the daemon side only: serve the adapter over HTTPS and sign each phone in
as a seat.

## Problem

Three gaps, each load-bearing for the Done line (a Claude app and a ChatGPT app on a phone, one on
cellular, each add `https://<host>/mcp` as a custom connector, sign in as a seat, and
`team_join` / `team_inbox_check` / `team_send` work):

1. **No HTTP rail for MCP.** The daemon's HTTP surface (`packages/server/src/transport/http.ts`)
   speaks musterd REST/WS only. Nothing answers MCP frames over HTTP.
2. **No OAuth server.** The auth model (SPEC A.7) knows four bearer kinds — team agent key
   (bootstrap-only), agent-seat credential + session lease (ADR 337), human credential `mscr_`
   (self-identifying), service token — and none of them can be issued through a browser flow a phone
   app drives. The apps will not present an `mscr_`; they present an OAuth `access_token` minted
   *because* a human proved an `mscr_` (or an approved join) in a browser.
3. **Presence assumes a socket.** Tool calls are HTTP already (`MusterdClient.request`), but holding
   a seat means a WS with heartbeats (`wantPresence`, ADR 164). A phone holds no WS; its seat must
   be an *authenticated occupancy per request*, in the ambient-presence tradition (ADR 057), or every
   tool call from a phone reads as seat-less.

## Decision

Serve the existing adapter over Streamable HTTP at a team-scoped URL, behind a minimal OAuth 2.1
authorization server whose only user is a seat holder proving what they already hold. Six parts.

### 1. One URL per team: `POST|GET /mcp/:team`

The connector URL is `https://<host>/mcp/<team>` — the team rides the path because a phone app
configures exactly one URL and no musterd headers. `GET` serves the SSE stream, `POST` the JSON-RPC
frames (Streamable HTTP), `DELETE` terminates the session. Served by SDK `createMcpHandler` with a
per-request factory: each request builds a fresh `McpServer` bound to the request's bearer (same
tool names and input shapes as the adapter, same `routeEnvelope`/`listInbox` store paths the REST
routes use), never a shared client. Increment 1 registers the Done-line tools only (`team_join` /
`team_inbox_check` / `team_send` — the join-page prompt's whole vocabulary); the rest of the
adapter surface converges in increment 3, after rehearsal says which tools a phone reaches for.

Stateful sessions (`mcp-session-id`) are served by the SDK handler (one handler per team, bounded
by the team count — the factory itself holds no seat state); a missing/expired session fails
closed to a fresh `initialize`, never to another seat's state. Session-map growth under many
phones is rehearsal-measured hardening (increment 3), not an increment-1 bound.

TLS terminates in front (the tunnel lane); the daemon itself keeps serving HTTP. The OAuth routes
(§3) **refuse on non-TLS** unless loopback (`isLocalPeer` + `x-forwarded-proto`): a bearer minted
over plaintext is a bearer leaked. This refusal is the daemon's only TLS opinion.

### 2. Two new credential kinds: `msat_` + `msrt_`

`TOKEN_PREFIXES` gains `oauth_access: 'msat_'` (opaque access token, 1h TTL) and
`oauth_refresh: 'msrt_'` (opaque refresh token, 30d TTL, single-use rotation). Same mint rule as
every secret since ADR 069: `prefix + base64url(randomBytes)`, stored **only as sha256** (SPEC A.2),
plaintext returned exactly once, never logged, never re-fetchable, never in audit `detail`.

Scope is `(team, member)`, bound at mint to a **human** seat (a phone is a person; agent seats stay
on the claim handshake — see §6). An access token authenticates exactly like an `mscr_` in
`authMember`: self-identifying, `actingSeat` must match-or-absent, disabled/banned/archived still
refused. No session lease is required (there is no Presence to bind it to — §4 says what replaces
the lease).

### 3. The smallest OAuth server the apps accept

Per team, all under the daemon (no third-party IdP — the team IS the identity provider):

- `GET /.well-known/oauth-protected-resource/mcp/:team` — resource metadata: this resource, the
  authorization-server issuer, bearer schemes, `msat_` audience note.
- `GET /.well-known/oauth-authorization-server` (+ per-team variant) — issuer, `authorization_endpoint`,
  `token_endpoint`, `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`,
  `grant_types_supported: ["authorization_code", "refresh_token"]`.
- `POST /oauth/:team/register` — RFC 7591 dynamic client registration. Stores `client_id`
  (+ optional secret for confidential clients; phone apps are public, secret absent), exact
  `redirect_uris`, `client_name`. Validation: every redirect URI is `https:` (custom schemes allowed
  only with an explicit `native:` marker the app declares — loopback `http:` allowed for desktop
  testing, never for the demo path), no wildcard hosts, no private-host downgrade.
- `GET /oauth/:team/authorize?...` — renders the consent page: which app (`client_name`), which team,
  which seat is being asked for. `POST /oauth/:team/authorize` — the human proves the seat: `mscr_`
  credential for an existing human seat (checked by `authByCredential`, acting-seat must match), or a
  join-link approval carrying the same authority (fifty's lane plugs here; this ADR defines the seam,
  not the link). On success: single-use authorization `code` (90s TTL, bound to
  `client_id + redirect_uri + code_challenge + team + member`), 302 to `redirect_uri` with
  `code + state`.
- `POST /oauth/:team/token` — `authorization_code` (verifies code, PKCE `S256` verifier,
  redirect-uri exact match → mints `msat_` + `msrt_`), `refresh_token` (rotates: new pair, old refresh
  single-use-burned; **reuse of a burned refresh revokes the whole chain** — stolen-refresh
  detection). `GET /oauth/:team/revoke` + RFC 7009 revoke endpoint for sign-out; admin revoke-all per
  seat rides the existing credential-rotate path.

PKCE `S256` is REQUIRED — `plain` and `none` are refused. Public clients (no secret) are first-class;
a confidential secret, when issued, is `client_secret_basic`-only and rate-limited harder.

### 4. Remote occupancy: authenticated per request, presence by activity

A `/mcp/:team` tool call authenticates its bearer to `(team, member)` and constructs the client in
*remote-bearer mode*: `holdsSeat` is true for the request's lifetime from the token alone — no WS,
no `wantPresence`, no session lease. Presence for the roster derives from authenticated activity
(ambient, ADR 057): last-OAuth-use timestamp, surfaced as the existing `offline`/`idle` reasons, never
as a fake live socket. The interrupt/wake line treats a remote seat as reachable-through-poll (its
app fetches on the user's rhythm); directed acts queue in the inbox like any held seat.

Concretely: no `team_join` dance is needed from the phone — the seat IS joined by signing in —
but `team_join` stays callable and is a no-op success when the bearer already names the seat (the
apps' setup prompts call it; failing there fails the demo).

### 5. Abuse posture (what big-body is asked to check)

- Secrets: sha256-only storage; plaintext crosses exactly one response body (`token` endpoint) and
  one 302 `Location` (the code, single-use, 90s); nothing secret in logs, audit, error messages, or
  the session map.
- Codes/tokens: `randomBytes(32)`; constant-time compare on redeem; single-use codes; refresh reuse
  revokes the chain; access 1h, refresh 30d, sliding capped at first-login + 30d.
- Redirects: exact-match against registered URIs (no prefix/substring matching); `state` passed
  through untouched, never trusted.
- Rate limits: per-IP buckets on `register` / `authorize` / `token` (5/min register, 10/min authorize,
  20/min token — tune in rehearsal); the refusal is `rate_limited` (429, new protocol code — the
  next move is retry, and a 403 would say it is final). Behind the loopback tunnel every attendee
  shares the `cloudflared` socket address, so with `trustProxy` on the buckets key off
  `CF-Connecting-IP` (edge-written, unspoofable; explicit assumption: no Worker in front
  rewriting it) — `X-Forwarded-For` is never trusted, leftmost included, because Cloudflare
  preserves an incoming XFF and a caller can rotate it past per-client limits. Without
  trustProxy the socket address stands. Cardinality is hard-capped (10k keys, expiry-swept then
  oldest-evicted) because distinct IPs are unbounded and memory is not.
- Transport: OAuth + `/mcp` bearer refused over non-TLS except loopback (§1) — every OAuth route
  including discovery and registration, no carve-outs; `Cache-Control: no-store`
  + `Pragma: no-cache` on every token/code response; codes and tokens never in URLs except the one
  302 `code` param (the flow both apps require).
- Bodies are byte-capped before buffering (64 KiB OAuth, 1 MiB `/mcp` frames — tool args carry
  message bodies); the refusal is `payload_too_large` (413, new protocol code — the next move is
  "send less"). PKCE inputs carry RFC 7636 entropy at the schema boundary (verifier 43–128
  unreserved chars, challenge exactly 43 base64url chars), so a leaked code is uneconomic to
  redeem by guessing even inside its 90 seconds.
- Audit: `oauth.client_registered / oauth.code_issued / oauth.token_issued / oauth.token_rotated /
  oauth.token_reused_revoked / oauth.revoked` — who (member), which client, when; never the secret.

### 6. What this does not decide

- Provisioning (fifty's join-link lane): this ADR consumes an `mscr_`-proven seat at authorize time;
  the join link becomes a second prover at the same seam, not a second auth system.
- Agent seats over OAuth: refused in v1 (authorize proves human seats only). A headless agent has the
  claim handshake; OAuth exists for people on phones.
- The tunnel/TLS termination (wanderer's lane) and the per-app connector steps (join page lane).
- Web `/board` sign-in reuse: may ride these endpoints later; not specified here.
- Cross-team consent, org-level clients, `client_credentials` grants: not specified, not built.

### 7. Increments

1. **This lane** — ADR (this doc) + `msat_`/`msrt_` prefixes + migration (`oauth_clients`,
   `oauth_codes`, `oauth_tokens`) + metadata/register/authorize/token/revoke + `/mcp/:team`
   Streamable mount in remote-bearer mode + zod parsing at every boundary + tests (metadata shape,
   DCR validation, PKCE-required, code single-use, refresh rotation + reuse-revokes, bearer
   team/member scoping, non-TLS refusal, no-secret-in-logs) + SPEC Appendix A entry — then big-body
   security review, then merge.
2. **Rehearsal** (demo lane, with tunnel + join link): three phones, one on cellular, Claude +
   ChatGPT, fresh team, against these endpoints.
3. **Hardening from rehearsal data**: rate-limit tuning, admin revoke UI, refresh-lifetime review,
   cross-harness clientInfo attestation for phone apps.

## Considered and rejected

- **Static bearer / long-lived personal token pasted into the app.** Neither app accepts it, and a
  pasted `mscr_`-equivalent in a third-party settings screen is a leak with no expiry, no scope, no
  rotation, and no revocation story. OAuth's moving parts are the price of per-seat, expirable,
  revocable phone access.
- **Proxying through a third-party IdP (Auth0/Clerk/etc.).** A new runtime dependency + a new
  trusted third party + account mapping for a demo whose identity provider already exists (the team
  + its `mscr_`s). New dependency without an ADR is a hard-rule violation anyway; this ADR is the one
  that would carry it, and it declines.
- **Tunnelling MCP-over-stdio over the existing WS.** Keeps one transport but forces the phone to run
  musterd code — which is what phones cannot do. The whole point is the apps' native connector.
- **Reusing `mscr_` as the OAuth access token.** The credential is permanent and unscoped; OAuth
  tokens are expirable, seat-and-client-scoped, and revocable without re-credentialing the human.

## Consequences

- `@musterd/protocol` grows two prefixes + OAuth zod schemas + `rate_limited` (429) and
  `payload_too_large` (413) error codes (ADR-gated, as required — this ADR is the gate). `@musterd/server` grows one runtime dependency
  (`@modelcontextprotocol/server@2.0.0`, same pin as the adapter), three tables (migration 72),
  six routes + the `/mcp/:team` mount, and six `oauth.*` audit verbs (server-side union, no wire
  change). No CLI/MCP-adapter wire change (stdio path untouched).
- The daemon becomes an OAuth authorization server for exactly one audience (its own teams' humans)
  and exactly one client class (phone MCP apps). The abuse surface in §5 is new and must be reviewed
  as new — hence the merge gate.
- Demo-day failure modes move to operations: tunnel up, daemon reachable, clock skew (code/token TTLs
  need ±30s), per-IP rate limits behind a shared-egress cellular NAT (tune in increment 3, not 1).
- 2026-09-25 (post-merge, fifty's #1694 verdict): the registration schema's `.strict()` 400d the
  RFC 7591 §2 optional members `grant_types`/`response_types` that both real connectors send in
  DCR — no real phone app could register. The schema now accepts both as optional arrays and
  ignores them (increment 1 issues exactly one flow: code + refresh; nothing to negotiate), with
  a protocol test on the Claude-shaped body and an HTTP test asserting 201. Truly unknown keys
  still fail closed. Additive tolerance under this ADR's own scope, not a Decision change.
- 2026-09-25 (same verdict round, ryder's note): `/mcp/:team` 401s carried no `WWW-Authenticate`
  header. Missing bearer now 401s with bare `Bearer`; bad/expired/revoked bearer with
  `Bearer error="invalid_token"` (RFC 6750 §3, description stays out of the header — the body
  already says it). Token-endpoint `invalid_client` 401s are unchanged (public clients, no basic
  auth). HTTP test asserts both headers.

## Observability & Evaluation

- Traces: `oauth.*` audit verbs (`client_registered / code_issued / token_issued / token_rotated /
  token_reused_revoked / revoked` — who, which client, when; never the secret) plus a
  `GET /report` count of remote-bearer tool calls per seat. The demo's evidence is per-seat rows,
  never bodies.
- Eval: the rehearsal falsifier (increment 2) — from a phone on cellular, add the connector, sign
  in, `team_join`, `team_inbox_check`, `team_send`. Fails if any step needs a laptop. Dataset: the
  three-phone rehearsal matrix (Claude + ChatGPT, one on cellular, fresh team); baseline: today's
  stdio-only adapter, which cannot complete step one.
- Experiment: increment-1 negative tests ship with the lane (§7) — PKCE-downgrade refused, code
  replay refused, refresh reuse revokes the chain, cross-team bearer refused, non-TLS
  authorize/token refused, bearer for a departed seat refused.
