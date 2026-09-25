# 451 — durable ordinary Team behind the public demo Tunnel

- Status: proposed — 2026-09-25
- Date: 2026-09-25
- Lane: 01M3AKNAW6S9XB5B7FTZYPH0QK (goal demo)
- Supersedes: ADR 448 Decisions 2, 5, and 7 only where they require a fresh/disposable Team, event-specific membership, or event-end revocation and data deletion. ADR 448’s dedicated Tunnel, loopback trust boundary, exact paths, TLS, rate-limit, and logging controls remain.
- Builds on: ADR 039 (one Team, one authority), ADR 040 (guarded off-loopback bind), ADR 448 (Cloudflare Tunnel route), and ADR 449 (ordinary per-Member lifecycle).

## Context

The demo needs phone and desktop MCP clients to reach one Team over the public internet. ADR 448 chose a named Cloudflare Tunnel and a narrow, loopback-only origin, but its initial runbook assumed that the presenter laptop hosted the daemon and that each run used a disposable Team and database.

The demo load benchmark showed that the presenter laptop is not a suitable daemon host at the target audience size: it stalled under load, while a Fly performance Machine handled about 75 humans, agents, and live viewers per population with p95 under one second after the roster refetch was coalesced. The benchmark has not yet exercised the Cloudflare Tunnel path. The presenter laptop should present the demo; a separate, isolated Fly Machine should run the daemon and Tunnel connector.

Nick’s 2026-09-25 steer keeps Teams and Members ordinary. A Member may have the normal, configurable lifecycle expiry on any Team; there is no event-Member kind or Team event clock. Agent creation and any resulting Member lifecycle follow the ordinary Team capabilities and lifecycle rules.

## Problem

Keep the public endpoint narrow and the daemon isolated while supporting a persistent Team that can be reused across demos. The route must not depend on the presenter laptop’s capacity, introduce event-only membership behavior, or destroy ordinary Team state when a presentation ends.

## Decision

1. **Run the daemon and Tunnel connector on one dedicated Fly Machine.** Keep one daemon authority and one isolated Fly app for this public demo. Run cloudflared beside the daemon so its origin remains 127.0.0.1:4851. Do not configure a Fly Proxy HTTP service, public listener, or inbound port for the daemon; Cloudflare Tunnel is the only public ingress. The presenter laptop runs the presentation and client apps only. Size the Machine from the load benchmark and repeat the measurement through the Tunnel before rehearsal.

   Store the SQLite database and daemon config under a mounted Fly Volume, not the Machine’s ephemeral root filesystem. Keep volume encryption enabled. A single Machine and volume are a single failure domain, not high availability: maintain an encrypted backup outside the Machine and rehearse restoring it. Fly documents that Volumes are machine-local, are not automatically replicated, and have encryption at rest enabled by default; see the [Fly Volumes overview](https://docs.fly.io/volumes/overview/).

2. **Use an ordinary Team and ordinary Members.** Create or reuse the demo Team through the normal Team command and let the released, general OAuth onboarding flow admit ordinary human Members. Do not require an event-only membership mode, event room-code prover, or event clock as a condition for exposing this route. If the general remote MCP/OAuth onboarding flow is not released and security-gated, keep the Tunnel closed.

   Configure a Member expiry only through the ordinary per-Member lifecycle setting and Team policy. Human Members remain ordinary human Members. Agent creation uses the same capabilities and ordinary lifecycle rules that apply to the Team; this route adds no event-only sponsor gate or agent cap.

3. **Retain ADR 448’s public edge and proxy controls.** Use one named Cloudflare Tunnel and hostname, with the exact Team-scoped ingress paths and final 404 rule in the [operator runbook](../operations/public-demo-tunnel.md). Do not expose the daemon through Fly Proxy, a router port, or a second hostname. Cloudflare terminates public TLS; the daemon remains bound to loopback and uses the acknowledged proxy-trust mode only with cloudflared on the same trusted host. Do not put a Cloudflare Access challenge or a Worker in front of the OAuth hostname.

   Keep the released-server security gate for TLS refusal on every exposed OAuth endpoint, bounded request bodies, RFC 7636 PKCE, credential-free logs, Cloudflare-edge rate limits, trusted client-address handling for the direct Cloudflare path, and bounded server rate-limit state. The server remains responsible for authentication, authorization, and methods.

4. **Separate public-route teardown from Team lifecycle.** When a demo ends, stop the Tunnel connector or remove its DNS route if the public endpoint is no longer needed. Preserve the Fly Volume, database, config, Team, and Member history. Do not revoke ordinary Members or delete the database just because the demo ended. Any configured Member expiry continues to follow the ordinary lifecycle policy; admins revoke credentials or archive the Team through the normal controls.

## Consequences

- ADR 448 remains the source for Tunnel paths, proxy trust, TLS, edge policy, and request logging. This record changes only the host placement and the lifetime of Team state and membership.
- The Fly Machine is a dedicated, persistent single-daemon deployment. Volume encryption at rest does not replace database backups or access controls; Fly’s [shared responsibility model](https://docs.fly.io/security/shared-responsibility/) leaves application and service configuration to the operator.
- Reusing the Team preserves its roster, messages, lanes, audit history, and OAuth identity across demo dates. Routine lifecycle policy, credential revocation, and Team retirement remain the controls for ordinary membership.
- No protocol schema, server behavior, or runtime dependency is added by this route decision. This lane documents a release gate; it does not provision the Fly app or deploy the Tunnel.
- Follows-up: 01M3AKN6GFHZ3DGCJPRE4RG2TE — released remote MCP/OAuth routes.
- Follows-up: 01M3AKNF0JXY8HFN1P4HTMPWCY — released general OAuth onboarding for ordinary Members.
- Follows-up: 01M3D4069FVNH89ZN9ZQFRK3P3 — measure the released flow through the public Tunnel before Rehearsal A.
- Follows-up: deferred — multi-Machine availability only if the product’s availability target requires failover; a second Machine must not use an unreplicated copy of the SQLite volume (2026-09-25).

## Observability & Evaluation

- **Traces:** Keep the controls from ADR 448: cloudflared at info level, daemon request paths redacted, and no credential-bearing request or error logs. Record Machine health and build provenance without logging OAuth secrets.
- **Eval:** The daemon accepts traffic only over loopback from its co-located Tunnel connector; the Fly app has no public daemon service; only the literal MCP/OAuth route set reaches the server; an ordinary human Member completes OAuth; restarting or redeploying the Machine preserves Team data from the mounted Volume; and an external backup can restore the isolated database. The baseline is ADR 448’s presenter-laptop runbook and the non-Tunnel Fly benchmark in docs/perf/daemon-load-baseline.md.
- **Experiment:** Before Rehearsal A, run 50 remote human clients, their agents, and live viewers through the actual Cloudflare hostname to the Fly-hosted daemon. Record the Machine size, build SHA, p95 latency, error rate, and path probes. Pass only if the ordinary OAuth flow works, unlisted paths return 404, TLS and proxy-trust checks hold, and p95 stays under one second at that load. The merged benchmark did not exercise this Tunnel path.
