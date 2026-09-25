# 448 — public demo route through a dedicated Cloudflare Tunnel

- Status: accepted — 2026-09-25, by nick in session ("i want to the most secure/best practice/long term
  solution").
- Date: 2026-09-25
- Lane: `01M3AKNAW6S9XB5B7FTZYPH0QK` (goal `demo`)
- Builds on: [ADR 039](039-cross-network-topology.md) (one Team, one authority; overlay-first
  topology) and
  [ADR 040](040-secured-off-loopback-bind.md) (TLS and explicit trust-proxy guard). Requires a
  released remote MCP/OAuth route and general OAuth onboarding for ordinary Members; otherwise do
  not expose the hostname.

## Context

The demo goal needs remote MCP clients to reach one Team over the public internet. The initial
proposal placed the daemon on the presenter's laptop; the later load benchmark moved it to a
dedicated Fly Machine ([ADR 451](451-public-demo-ordinary-members.md)). A private overlay is the
right default for teams whose Members can join it ([ADR 039](039-cross-network-topology.md)); an
audience at an event cannot be asked to install or join one. A public hostname is therefore needed
for the phone-app flow.

The shared daemon is not a suitable origin: it serves every Team, has unrelated HTTP surfaces, and is already under load. The daemon's secured-bind guard ([ADR 040](040-secured-off-loopback-bind.md)) already supports a loopback origin behind an acknowledged TLS-terminating proxy. The missing decision is the public edge's narrow scope and the trust boundary around that proxy.

## Problem

Expose the minimum public surface needed by the phone MCP flow without turning the shared daemon into a public service, bypassing the daemon's TLS checks, or leaving a persistent public route and credentials after the demo.

## Decision

1. **Use a named Cloudflare Tunnel for a dedicated demo hostname.** Cloudflare terminates browser/app TLS; the authenticated Tunnel carries traffic to `cloudflared`, which connects to the daemon on loopback. Do not open a router port, bind the daemon to a LAN/WAN address, or use a quick `trycloudflare.com` tunnel. The tunnel is dedicated to the demo and its credential is scoped to that tunnel, stored with mode `0600`, and never placed in the Team config.

2. **Run one disposable daemon and one fresh Team.** Give the run its own SQLite database, CLI config, and unused local port. Never route a shared or service-installed daemon. Keep the server bound to `127.0.0.1`. Bootstrap the Team while the daemon is in its normal loopback-trusted mode, then restart it with `--insecure-trust-proxy` before starting the Tunnel. This flag makes loopback peers count as remote for authorization checks; without it, a request arriving from `cloudflared` would be misclassified as local. Do not set the flag on a shared daemon or pair it with a non-loopback bind.

   _(Amended 2026-09-25: ADR 451 replaces disposable state and a fresh Team with dedicated persistent state and an ordinary reusable Team. The daemon remains isolated and loopback-bound; see the dated note in Consequences.)_

   The remote MCP/OAuth server must judge TLS from `X-Forwarded-Proto`. Cloudflare overwrites a visitor-supplied `X-Forwarded-Proto` with the protocol the visitor used to reach Cloudflare ([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)). The loopback-only bind is load-bearing: the server does not authenticate `cloudflared` as a process, so every local process able to connect to the port remains inside the host trust boundary and can supply local headers.

3. **Allow only the exact phone-flow paths for the one Team.** The literal path list is in the [operator runbook](../operations/public-demo-tunnel.md): `/mcp/demo`, the `/oauth/demo/` authorization endpoints, and their Team-specific OAuth discovery endpoints. Keep the hostname literal, every path anchored, and the final ingress rule a 404. The route must not expose `/teams`, `/health`, `/ws`, `/live`, root OAuth discovery, or another Team's paths. `cloudflared` path rules match without rewriting the path, so the server receives the same Team-scoped path ([Tunnel ingress rules](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)). The server remains responsible for authentication, authorization, and allowed HTTP methods.

4. **Use musterd OAuth for the app's identity checks.** Do not add a Cloudflare Access challenge to this hostname's MCP/OAuth routes: the phone clients use musterd's OAuth/Bearer flow, and a separate Access JWT requirement would be another credential/header the clients must supply. Restrict Cloudflare account and Tunnel administration to the operators; use edge WAF/rate limiting on the exact public routes. Do not rely on a server rate limiter keyed only to `req.socket.remoteAddress` for client-level limits, because origin requests arrive from the local connector.

5. **Treat public routing as gated on the released OAuth and event-membership flows.** Do not start the Tunnel until the deployed server build implements the remote MCP/OAuth routes and the released event flow supports expiring human Members, sponsor-authorized agent-kind Members, and revocation. Its security gate must cover TLS refusal on every exposed OAuth endpoint (including discovery and registration), bounded request bodies, RFC 7636 PKCE validation, and credential-free request/error logs. Rate limits must be effective behind a shared Tunnel connector: use edge limits, key server limits to a Cloudflare-authenticated client address only on the direct Cloudflare path (`CF-Connecting-IP`; no Worker in front), never trust the visitor-supplied leftmost `X-Forwarded-For`, and hard-bound per-process buckets and cleanup work. The MCP/OAuth protocol is not widened by this ADR. The path list must track the released server route contract; anything absent from the allowlist stays unreachable.

   _(Amended 2026-09-25: ADR 451 replaces the event-membership prerequisite with released general OAuth onboarding for ordinary Members. Any expiry follows ordinary per-Member lifecycle policy; see the dated note in Consequences.)_

6. **Keep logs and credentials out of the public run.** Run `cloudflared` at `info` level; never enable `debug` for live traffic because Cloudflare documents that it emits request URLs and headers ([run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/)). In any configured HTTP Logpush job, select path-only `ClientRequestPath` or omit URI fields; `ClientRequestURI` includes the query string ([HTTP requests dataset](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/)). The local daemon build must include request-path redaction. Assume Cloudflare processes the public request metadata at its edge.

7. **Teardown is part of the run.** Revoke every human Member and sponsored agent-kind Member through the released event-membership controls, stop the connector and daemon, remove the hostname's DNS route, remove the dedicated Tunnel/credential, and delete the temporary config/database directory. Verify the hostname is unreachable from an outside network. Stopping `cloudflared` alone does not remove its DNS record ([Tunnel DNS routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)).

   _(Amended 2026-09-25: ADR 451 replaces event-end revocation and database deletion with normal Member lifecycle and Team-retirement policy. End the public route when it is not needed; preserve ordinary Team state. See the dated note in Consequences.)_

## Alternatives considered

- **Expose the shared daemon through the Tunnel.** Rejected: a path mistake would widen access to other Teams and unrelated routes, and the shared daemon is not sized for an event.
- **Bind the daemon publicly or forward a router port.** Rejected: it creates a directly reachable origin, expands the host firewall/certificate surface, and is unnecessary for a connector that dials out.
- **Put Cloudflare Access in front of the MCP/OAuth hostname.** Rejected for this client flow: the phone connectors cannot supply a separate Access assertion. The application OAuth flow is the identity boundary for these routes; Cloudflare account and Tunnel administration remains restricted to operators.
- **Use a quick Tunnel URL.** Rejected: a named hostname with reviewed ingress rules, a scoped credential, edge policy, and explicit DNS teardown gives the operator a repeatable and auditable control surface.

## Consequences

- A demo has a distinct daemon authority and isolated persistent state on its dedicated Fly Machine. No protocol schema, runtime dependency, or shared-daemon configuration changes.
- TLS terminates at Cloudflare; the connector-to-daemon hop is HTTP over loopback inside the dedicated host. The proxy-trust flag is safe only while that origin remains loopback-only and the host remains trusted.
- Public OAuth discovery and registration routes remain reachable at the Cloudflare edge because the phone flow needs them; server TLS checks, input bounds, PKCE, trusted-address rate limits with bounded buckets, log redaction, and edge rate limits are launch gates, not optional follow-up hardening.
- The named demo Tunnel's DNS route and scoped credential outlive a stopped connector unless explicitly removed. Stop the public route when it is not needed; retain the ordinary Team database and Member state under normal lifecycle and retention policy.
- Follows-up: `01M3AKN6GFHZ3DGCJPRE4RG2TE` — released remote MCP/OAuth route and general OAuth onboarding.

2026-09-25 — ADR 451 records the accepted host and lifecycle correction: the daemon and Tunnel connector run on an isolated Fly Machine with persistent state, while the presenter laptop only presents. Ordinary Teams and Members persist across demo dates; configured generic Member expiry and normal admin revocation continue to apply. ADR 448 Decisions 2, 5, and 7 are amended only as marked above; the Tunnel, TLS, path, rate-limit, and logging controls remain.

## Observability & Evaluation

- **Traces:** Cloudflare Tunnel operational logs at `info`; daemon request logs with the request path redacted; Cloudflare edge request logs only if configured by the operator. No request-body or credential logging is part of the route.
- **Eval:** `cloudflared tunnel ingress validate` passes; rule probes route every listed path to `127.0.0.1:<port>` and route `/health`, `/teams`, `/ws`, `/live`, and an unknown path to `http_status:404`; forged `X-Forwarded-For` values do not change server rate-limit identity and request churn cannot grow rate-limit state without bound; public HTTP redirects to HTTPS; an ordinary Member completes the phone MCP/OAuth flow over the HTTPS hostname; after route teardown the hostname fails from an outside network while the Team database remains on its persistent volume. Baseline is no public hostname.
- **Experiment:** During preflight, probe every allowed path and method, send a forged `X-Forwarded-For`, and churn source addresses; the server must preserve the trusted rate-limit identity and stay within its fixed bucket bound while every unlisted path returns 404.
