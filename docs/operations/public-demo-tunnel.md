# Public phone MCP demo through Cloudflare Tunnel

The daemon and Cloudflare Tunnel connector run together on one dedicated Fly Machine. The presenter laptop runs the slides and client apps only. The quick start takes under five minutes once the Fly app, named Tunnel, and ordinary Team have been prepared.

## Prerequisites

- A Node 22 or newer released musterd build containing the reviewed remote MCP/OAuth endpoints and the general OAuth onboarding flow for ordinary Members. Do not expose an unreleased build or substitute token-in-URL access. If the general onboarding flow is not released and security-gated, keep the Tunnel closed. The server security gate must verify TLS refusal on every exposed OAuth endpoint (including discovery and registration), bounded request bodies, RFC 7636 PKCE validation, trusted-address rate limiting with bounded state behind the Tunnel, and request/error redaction.
- One dedicated Fly app with one Machine. Run the daemon and cloudflared on that same Machine. Bind the daemon to 127.0.0.1:4851 and do not configure a Fly Proxy HTTP service or public listener for the daemon; the Tunnel connector dials out. Keep the Machine isolated from the shared daemon.
- Mount a dedicated Fly Volume at /data and put the SQLite database, daemon config, and SQLite sidecar files there. Keep volume encryption enabled and make an encrypted backup outside this Machine with a restore procedure that has been exercised. Fly documents that Machine root filesystems are ephemeral, Volumes are persistent but local to one Machine, Volumes are not automatically replicated, and volume snapshots should not be the primary backup method. A one-Machine/one-Volume setup is not high availability.
- Use a Machine size selected from the load benchmark, not the presenter laptop. Keep one SQLite authority; do not add a second Machine with a copied, unreplicated database. If the availability target later requires failover, design database replication under a separate decision.
- A dedicated named Cloudflare Tunnel, one exact DNS hostname (for example mcp-demo.example.org), and its DNS route. Store the scoped Tunnel credential in the platform secret store, materialize it as a mode-0600 file only inside the Machine, and never bake it into the image or Team config. Configure HTTP-to-HTTPS redirect and TLS 1.2 or newer. Do not put Cloudflare Access or a Worker in front of this OAuth hostname.
- Restrict Cloudflare and Fly control-plane access to operators, use SSO/MFA where available, and keep API tokens narrowly scoped. Fly documents the operator responsibilities for platform account access and application configuration in its shared responsibility model.
- A cloudflared config containing the exact ingress rules below. Keep the credential file mode 0600. Set edge rate limits for registration, authorization, and token routes. If HTTP Logpush is enabled, select ClientRequestPath, not ClientRequestURI.
- A startup supervisor for the Fly Machine that validates the Tunnel config, starts the daemon with proxy trust enabled, waits for local daemon health, then starts cloudflared. It must keep both processes supervised and stop them together. Do not use a detached SSH shell as the long-running process manager.
- Create the Team once with the ordinary Team command, or reuse it across demonstrations. Attendees join as ordinary human Members through the released general OAuth onboarding flow. A Member expiry is optional and follows the ordinary per-Member lifecycle policy in [ADR 449](../decisions/449-member-expiry-sponsored-agents.md); a demo date does not expire the Team or its Members. Agent creation follows the Team's ordinary capabilities and lifecycle rules. Do not distribute the Team agent key, raw human credentials, or the presenter's admin credential.

Fly Volume details are in the [Fly Volumes overview](https://docs.fly.io/volumes/overview/), and the operator's application/network responsibilities are in Fly's [shared responsibility model](https://docs.fly.io/security/shared-responsibility/).

Cloudflare Tunnel matches ingress rules top to bottom, uses the path regex as a matcher, forwards the path unchanged, and requires a final catch-all rule. These are the only paths to allow for the demo Team when the reviewed, released remote MCP/OAuth routes are available:

    tunnel: <TUNNEL-UUID>
    credentials-file: <PATH-TO-SCOPED-TUNNEL-CREDENTIALS.json>

    ingress:
      - hostname: mcp-demo.example.org
        path: '^/mcp/demo$'
        service: http://127.0.0.1:4851
      - hostname: mcp-demo.example.org
        path: '^/oauth/demo/(register|authorize|token|revoke)$'
        service: http://127.0.0.1:4851
      - hostname: mcp-demo.example.org
        path: '^/\.well-known/oauth-protected-resource/mcp/demo$'
        service: http://127.0.0.1:4851
      - hostname: mcp-demo.example.org
        path: '^/\.well-known/oauth-authorization-server/demo$'
        service: http://127.0.0.1:4851
      - hostname: mcp-demo.example.org
        path: '^/oauth/demo/\.well-known/oauth-authorization-server$'
        service: http://127.0.0.1:4851
      - service: http_status:404

Replace the hostname, Tunnel UUID, and credential path with the provisioned values. If the Team slug changes, replace every literal /demo and re-review the full path set; do not replace it with a wildcard. Ingress rules do not constrain HTTP methods, so the server must enforce the MCP/OAuth methods and the edge WAF should reject other methods where supported.

Allow only GET, POST, and DELETE on /mcp/demo; GET on discovery; POST on registration and token; GET and POST on authorization and revocation. The Tunnel uses Cloudflare's direct edge path: do not add a Worker that can change client-address headers. Cloudflare overwrites CF-Connecting-IP with the visitor address, while X-Forwarded-For can retain visitor-supplied values and append proxy hops ([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)). Apply edge rate limits to those exact paths. Server rate limits must never trust the leftmost X-Forwarded-For; when they use client IP, use CF-Connecting-IP only for this direct Cloudflare path and bound the number and cleanup work of in-memory buckets.

## One-time setup

1. Create a dedicated Fly app and a single Machine with a persistent encrypted Volume mounted at /data. Do not configure a Fly HTTP service or public listener for port 4851. Keep the Machine and Volume in the same region, and size the Machine from the benchmark. Set the database and config paths to the Volume:

       MUSTERD_DB=/data/musterd.sqlite
       MUSTERD_CONFIG=/data/config.json
       MUSTERD_SERVER=http://127.0.0.1:4851
       MUSTERD_PORT=4851

   Set a restrictive umask and keep the database directory private to the daemon user. The Tunnel credential must come from the platform secret store, not from the Volume backup.

2. Start the daemon once in its normal loopback-trusted mode, with cloudflared stopped, and create the ordinary Team and presenter Member through the released CLI. Run this command on the Fly Machine and keep its output off the projected/shared screen:

       umask 077
       MUSTERD_DB=/data/musterd.sqlite \
       MUSTERD_CONFIG=/data/config.json \
       MUSTERD_SERVER=http://127.0.0.1:4851 \
       musterd team create demo --member presenter

   This creates the Team and the presenter as its first human Member. Apply the normal Team policy and any optional per-Member expiry through the supported controls. Do not create a disposable event Team or enable event-only membership behavior.

3. Configure the Machine's supervised daemon command to keep the bind on loopback and enable proxy trust:

       MUSTERD_ALLOWED_HOSTS=mcp-demo.example.org \
       musterd serve --host 127.0.0.1 --port 4851 --insecure-trust-proxy

   `MUSTERD_ALLOWED_HOSTS` must name the public hostname exactly. The daemon's Host/Origin gate admits only loopback, the bound host, and that list, so without it every tunneled request — OAuth registration included — is refused 403 before any route runs (found 2026-09-26 by the tunnel load bench, lane 01M3D4069F). The proxy-trust flag makes requests from the local connector count as remote for server trust checks; it does not bind the daemon publicly. Cloudflare overwrites a visitor-supplied X-Forwarded-Proto with the protocol used at the edge, which is how the OAuth server distinguishes the HTTPS public request. A local process that can reach loopback remains trusted by the host boundary.

4. Validate the config in the Fly Machine image before enabling the Tunnel:

       cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress validate
       cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress rule https://mcp-demo.example.org/mcp/demo
       cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress rule https://mcp-demo.example.org/oauth/demo/authorize
       cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress rule https://mcp-demo.example.org/health
       cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress rule https://mcp-demo.example.org/teams

   The /health and /teams probes must select the final http_status:404 rule. Also probe /ws, /live, a made-up path, and each discovery path from the config.

5. Create an encrypted off-Machine database backup and perform a restore rehearsal before the first public demo. Retain the backup according to the normal Team data-retention policy. Fly's volume snapshots help recover a Volume but are not the only copy.

## Start the demo

1. Start the dedicated Fly Machine if it is stopped. Wait for its daemon health check and supervised cloudflared process to report healthy. Confirm the expected daemon build SHA before presenting the hostname.
2. From an outside network, confirm the OAuth protected-resource discovery URL returns metadata, unsupported paths return 404, and an HTTP URL redirects to HTTPS. A 403 `request Host or Origin is not allowed` on any of these means `MUSTERD_ALLOWED_HOSTS` is missing the hostname (step 3). Confirm the hostname reaches the dedicated Machine only through the Tunnel.
3. Mint the room's invite before sharing anything (ADR 450): from the presenter's Workspace run `musterd team invite create --expires 3h` (add `--member-until <duration>` if attendees' memberships should lapse). It prints the room code and the join-link value once; put the code on the slide and keep the invite id for `musterd team invite revoke` if the code leaks. Attendees type the code (or paste the link value) into the "Invite" field on the OAuth sign-in page and pick a name; each becomes a new human Member. `musterd team invite list` shows uses and failures during the run.
4. Mint the invite the attendees will type (ADR 450) from the presenter Workspace, and keep its output off the shared screen until the join slide is up:

       musterd team invite create --expires 3h

   It prints the room code (`SEL-XXXX-XXXX`) and the link value once. Without an invite the sign-in page's "I'm new" form has nothing to accept, and every attendee is refused. Then complete the released general OAuth onboarding flow as an ordinary human Member. Confirm the new Member appears on the Team roster and can use the remote MCP route. Verify the Team has no event-only lifecycle state.
5. Run the load rehearsal through this public hostname. The merged Fly benchmark did not exercise the Tunnel path. For the demo target, measure 50 remote human clients, their agents, and live viewers; record Machine size, build SHA, p95 latency, and error rate. Target p95 under one second at that load.

Stop and fix the run if any unrelated path reaches the daemon, a TLS check accepts a plaintext request, changing a forged X-Forwarded-For value changes rate-limit identity, or the released OAuth flow does not behave like ordinary Team membership.

Cloudflare cloudflared logs at debug include request URLs and headers. Keep info during the public run. If HTTP Logpush is configured, ClientRequestURI includes query strings; choose ClientRequestPath or omit URI fields. Cloudflare Tunnel DNS records are independent of the connector process, so stopping the Machine alone does not remove its DNS record.

## Pause or retire the route

1. When the public route is not needed, stop the Cloudflare Tunnel connector and remove the hostname's DNS route if the demo will remain offline. Stopping cloudflared alone does not remove DNS.
2. Stop the Fly Machine to remove the public origin process. Keep the persistent Volume, database, daemon config, Team, Members, and audit history for reuse. Do not revoke ordinary Members or delete the database because a demo ended.
3. For another demo, restore the DNS route if it was removed, start the same Machine, wait for the health checks, and repeat the external route probes.
4. If the Team or Tunnel is permanently retired, use normal Team archive/retirement and secret-revocation procedures. Preserve and delete data only under the normal backup and retention policy; do not use event end as a deletion trigger.
5. From a phone on cellular or another external network, verify the hostname no longer reaches the daemon when the route is paused or retired. Confirm a restart preserves the Team from its Volume and that the backup restore procedure works.

## References

- [Locally managed Tunnel configuration and ingress rules](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)
- [Tunnel DNS routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)
- [Cloudflare HTTP headers (X-Forwarded-Proto)](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
- [cloudflared run parameters and log levels](https://developers.cloudflare.com/tunnel/reference/run-parameters/)
- [HTTP Requests Logpush fields](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/)
- [Fly Volumes overview](https://docs.fly.io/volumes/overview/)
- [Fly shared responsibility model](https://docs.fly.io/security/shared-responsibility/)
