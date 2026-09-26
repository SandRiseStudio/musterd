# Rehearsal A, 2026-09-26 — a real phone joins through the tunnel

The first real Claude iPhone against the daemon through a Cloudflare tunnel found two OAuth blockers the load bench could not see, and each is measured, fixed and dated here.

## The rig

- Fly app `musterd-loadbench`, machine `811096a9576268` (izzo's bench box, `performance-8x`), image built from a `main` containing #1735 and #1742. Only `@musterd/server...` was built in the image; the CLI needed `pnpm --filter "@musterd/cli..." build` on the box (bare `@musterd/cli` fails: `@musterd/mcp` unbuilt).
- Quick tunnel (`cloudflared tunnel --url http://127.0.0.1:4851`), so numbers here are **quick-tunnel**, not the named-tunnel route in [the runbook](../operations/public-demo-tunnel.md). Daemon on loopback with `--insecure-trust-proxy` and `MUSTERD_ALLOWED_HOSTS=<tunnel host>`; DB in `/tmp`; team `demo`, member `presenter`; invite minted with `team invite create --expires 3h`.
- Stand-up scripts were shipped to the box as one base64 line inside `fly ssh console -C`; a multi-line quoted `-C` command exits `4294967295` with no output (2026-09-26; falsify: pass a multi-line `sh -c '…'` to `fly ssh console -C` and see output). <!-- claim: other -->

## Outside-in probes (before any phone)

From a laptop on another network, via the tunnel: both discovery documents 200, `/health` 200, `/teams` and a made-up path 404. Plain `http://` is **403** from the quick-tunnel edge, not a redirect to https as the runbook expects of the named route (2026-09-26; falsify: `curl -sI http://<quick-tunnel-host>/mcp/demo` returning 301/308). <!-- claim: other -->

## Blocker 1 — "could not start sign in" (Claude iOS, cellular)

The app failed before the sign-in page loaded. The issuer is `https://<host>/oauth/demo`, so an MCP client fetches RFC 8414 path-inserted `/.well-known/oauth-authorization-server/oauth/demo`, then the two OpenID forms. All three 404'd; only the team-slug shorthand and the path-appended form existed. ~~Serves AS metadata at the wrong path (2026-09-26; falsify: `curl -s -o /dev/null -w '%{http_code}' https://<host>/.well-known/oauth-authorization-server/oauth/demo` returning 200)~~ FIXED 2026-09-26 by #1752 (test red on main, green with the fix). <!-- claim: defect -->

Why the bench missed it: `demo-audience-load.mjs` reads the metadata URL it already knows; it never discovers.

## Blocker 2 — token exchange 400 after the invite form (found by emulation)

Emulating the client from a laptop: register 201 → authorize 200 → invite form POST 302 with a code → token exchange **with** `resource=<MCP endpoint>` 400 `invalid_request`; the same code **without** it 200. The MCP auth spec (2025-06-18 §2.8) makes RFC 8707 `resource` mandatory for clients, and `OAuthTokenRequestSchema` was `.strict()`. ~~Rejects the resource indicator (2026-09-26; falsify: the token exchange above returning 200 with `resource=` set)~~ FIXED 2026-09-26 by #1754, [ADR 457](../decisions/457-oauth-resource-indicator.md). <!-- claim: defect -->

Nobody had reached this step on a real client; the bench does not send `resource` either.

## Client landscape (researched 2026-09-26)

- Claude iOS/Android: custom connectors on Free (one), Pro, Max, Team, Enterprise. Adding on mobile is beta; the primary path is add on claude.ai web or desktop, then it appears on the phone. Claude reaches the MCP server from Anthropic's cloud, so "a phone on cellular" only exercises the sign-in page.
- Cowork and Claude Desktop share the account's connectors: same family, one row.
- ChatGPT: custom MCP needs Developer mode on a paid plan and is web only; the mobile apps cannot add or use one. Rehearsal B stays a laptop.
- Codex CLI, desktop and IDE extension share `~/.codex/config.toml` and do OAuth (`codex mcp login <name>`, DCR + PKCE). Codex cloud and the Codex tab in the ChatGPT app: no documented MCP OAuth.

## Timings

None yet: attempt 1 failed at blocker 1 and the session ended before a retry. Pending: per-phone add→first tool call, mistypes per admission, `/live` at 60 s, a wrong code, the link-value paste.
