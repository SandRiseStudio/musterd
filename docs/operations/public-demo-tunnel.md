# Public phone MCP demo through Cloudflare Tunnel

Use this runbook only for one disposable event Team. It does not apply to the shared daemon or a normal local service. The quick start takes under five minutes once the prerequisites below are ready.

## Prerequisites

- A Node ≥22 installation and a released `musterd` build that contains the reviewed remote MCP/OAuth endpoints and event membership flow. The event flow must admit human Members through OAuth, let a joined human create sponsor-authorized agent-kind Members, and enforce event expiry and revocation. Do not expose an unreleased build or substitute token-in-URL access. The server security gate must verify TLS refusal on every exposed OAuth endpoint (including discovery and registration), bounded request bodies, RFC 7636 PKCE validation, trusted-address rate limiting with bounded state behind the Tunnel, and request/error redaction.
- A dedicated named Cloudflare Tunnel, one exact DNS hostname (for example `mcp-demo.example.org`), and that hostname's DNS route already provisioned. Keep the Tunnel credential file at mode `0600`; use a credential scoped to this Tunnel, not the account certificate. Configure the zone to redirect HTTP to HTTPS and require TLS 1.2 or newer. Do not put a Cloudflare Access challenge or Worker in front of this OAuth hostname.
- A local `cloudflared` configuration file with the exact ingress rules below, saved with mode `0600`. The tunnel credential JSON it names must also be mode `0600`. Set edge rate limits for registration, authorization, and token routes, and configure any HTTP Logpush job to use `ClientRequestPath`, not `ClientRequestURI`.
- Create the event Team and presenter human Member through the released event-membership setup. Attendees join as human Members from their own MCP app through OAuth; they create agent-kind Members through the sponsor-authorized flow. Do not distribute the Team agent key, raw human credentials, or the presenter's admin credential. Complete Team setup before screen sharing.
- The demo hostname, Tunnel ID, credential path, and local port are known. Port `4851` must be unused; never use the shared daemon's port `4849`.

Cloudflare Tunnel matches ingress rules top to bottom, uses the path regex as a matcher, forwards the path unchanged, and requires a final catch-all rule. These are the only paths to allow for the `demo` Team when the reviewed, released remote MCP/OAuth routes are available:

```yaml
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
```

Replace the hostname, Tunnel UUID, and credential path with the provisioned values. If the Team slug changes, replace every literal `/demo` and re-review the full path set; do not replace it with a wildcard. Ingress rules do not constrain HTTP methods, so the server must enforce the MCP/OAuth methods and the edge WAF should reject other methods where supported.

Allow only `GET`, `POST`, and `DELETE` on `/mcp/demo`; `GET` on discovery; `POST` on registration and token; `GET` and `POST` on authorization and revocation. The Tunnel uses Cloudflare's direct edge path: do not add a Worker that can change client-address headers. Cloudflare overwrites `CF-Connecting-IP` with the visitor address, while `X-Forwarded-For` can retain visitor-supplied values and append proxy hops ([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)). Apply edge rate limits to those exact paths. Server rate limits must never trust the leftmost `X-Forwarded-For`; when they use client IP, use `CF-Connecting-IP` only for this direct Cloudflare path and bound the number and cleanup work of in-memory buckets.

## Start the isolated daemon and route

1. In Terminal A, create a private temporary state directory, then start the daemon locally **without** proxy trust so the local operator can create the Team. Keep this terminal off the projected/shared screen:

   ```bash
   umask 077
   export MUSTERD_DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/musterd-public-demo.XXXXXX")"
   chmod 700 "$MUSTERD_DEMO_DIR"
   export MUSTERD_DB="$MUSTERD_DEMO_DIR/musterd.sqlite"
   export MUSTERD_CONFIG="$MUSTERD_DEMO_DIR/config.json"
   export MUSTERD_SERVER="http://127.0.0.1:4851"
   export MUSTERD_PORT=4851
   unset MUSTERD_WEB_ROOT
   cd "$MUSTERD_DEMO_DIR"
   printf 'Private demo state: %s\n' "$MUSTERD_DEMO_DIR"
   musterd serve --host 127.0.0.1 --port 4851
   ```

2. In Terminal B, point the released CLI at the same isolated state and use its event-membership setup to create exactly one expiring Team and its presenter human Member. Confirm the event end time and join policy before publishing the hostname. Do not mint attendee credentials for distribution:

   ```bash
   export MUSTERD_DEMO_DIR='<value printed in Terminal A>'
   export MUSTERD_DB="$MUSTERD_DEMO_DIR/musterd.sqlite"
   export MUSTERD_CONFIG="$MUSTERD_DEMO_DIR/config.json"
   export MUSTERD_SERVER="http://127.0.0.1:4851"
   cd "$MUSTERD_DEMO_DIR"
   ```

   The event-membership setup command is part of that released flow. Do not replace it with `musterd team create` alone: that creates a Team but does not configure event expiry or the attendee join policy.

3. In Terminal A, stop the bootstrap daemon with `Ctrl-C`. Start the same isolated daemon again with the proxy-trust flag. Keep the bind on loopback:

   ```bash
   musterd serve --host 127.0.0.1 --port 4851 --insecure-trust-proxy
   ```

   `--insecure-trust-proxy` makes requests from the local connector count as remote for server trust checks; it does not bind the daemon publicly. Cloudflare overwrites a visitor-supplied `X-Forwarded-Proto` with the protocol used at the edge, which is how the OAuth server distinguishes the HTTPS public request. The server may use `CF-Connecting-IP` for client-level limits only because this runbook uses the direct Cloudflare path with no Worker. A local process that can reach loopback remains trusted by the host boundary.

4. In Terminal C, validate the prepared Tunnel config and the first-match routing for every intended path and denied path, then run the connector at info level:

   ```bash
   export CLOUDFLARED_CONFIG='<path to the reviewed mode-0600 config>'
   cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress validate
   cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress rule https://mcp-demo.example.org/mcp/demo
   cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress rule https://mcp-demo.example.org/oauth/demo/authorize
   cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress rule https://mcp-demo.example.org/health
   cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress rule https://mcp-demo.example.org/teams
   cloudflared tunnel --config "$CLOUDFLARED_CONFIG" --loglevel info run <TUNNEL-NAME-OR-UUID>
   ```

   The `/health` and `/teams` probes must select the final `http_status:404` rule. Also probe `/ws`, `/live`, a made-up path, and each discovery path from the config. From an outside network, confirm the OAuth protected-resource discovery URL returns metadata, unsupported paths return 404, and an HTTP URL redirects to HTTPS. Complete OAuth sign-in as a human Member, then create an agent-kind Member through that human's sponsored-agent flow. Stop and fix the run if any unrelated path reaches the daemon, if a TLS check accepts a plaintext request, or if changing a forged `X-Forwarded-For` value changes the server's rate-limit identity.

Cloudflare `cloudflared` logs at `debug` include request URLs and headers. Keep `info` during the public run. If HTTP Logpush is configured, `ClientRequestURI` includes query strings; choose `ClientRequestPath` or omit URI fields. Cloudflare Tunnel DNS records are independent of the connector process, so stopping the process alone leaves the hostname published.

## Teardown

1. End the event and revoke every human Member and sponsored agent-kind Member through the event-membership control. Confirm sponsor revocation cascades to that sponsor's agent-kind Members. Revoke any still-active OAuth token chain using the supported server control. Do not keep the demo database for a later event.
2. Stop `cloudflared` in Terminal C and the daemon in Terminal A with `Ctrl-C`.
3. Delete the demo hostname's DNS route from the Cloudflare dashboard/API. Remove the demo Tunnel and its credential if it was created only for this event. Do not assume a stopped connector removes DNS.
4. In Terminal B, verify the directory printed by Terminal A is the generated `musterd-public-demo.*` directory, then delete only that path:

   ```bash
   case "${MUSTERD_DEMO_DIR##*/}" in
     musterd-public-demo.*) rm -r -- "$MUSTERD_DEMO_DIR" ;;
     *) printf 'Refusing unexpected demo directory: %s\n' "$MUSTERD_DEMO_DIR" >&2; exit 1 ;;
   esac
   ```

   This removes the isolated SQLite database (including any SQLite sidecars), the local presenter credential, and the daemon config. Deleting the database invalidates any residual musterd/OAuth credentials in that demo Team.

5. From a phone on cellular or another external network, verify the hostname no longer resolves to the tunnel or returns a working route. The run is complete only when the DNS route is removed, no connector is running, and the isolated database is gone.

## Cloudflare references

- [Locally managed Tunnel configuration and ingress rules](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)
- [Tunnel DNS routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)
- [Cloudflare HTTP headers (`X-Forwarded-Proto`)](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
- [`cloudflared` run parameters and log levels](https://developers.cloudflare.com/tunnel/reference/run-parameters/)
- [HTTP Requests Logpush fields](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/)
