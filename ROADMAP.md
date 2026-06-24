# Roadmap

> **The item list below is generated** from `packages/web/src/content/roadmap.data.ts` — the single
> source of truth, and the same module the web roadmap map renders. **Edit that file, then run
> `pnpm roadmap:gen`.** Do not hand-edit between the generated markers; it will be overwritten. The
> intro and footer here are hand-authored and live outside the markers.

musterd v0.1 is deliberately small: a protocol (`SPEC.md`), a local team server, a human CLI, and a universal MCP adapter. The schema and wire format already **reserve** the fields the items below need, so adding them does not break v0.1 clients. Nothing here is required for v0.1 conformance.

<!-- BEGIN GENERATED ROADMAP — source: packages/web/src/content/roadmap.data.ts · regenerate: pnpm roadmap:gen -->

## Shipped

_Built and in the product today._

- **Driver co-presence** · Human ↔ agent loop — When a human steers an agent inside its session, the roster shows the human present — not offline. The founding dogfood wound: a human driving an agent used to read as absent. Pulled pre-launch because the headline is humans and agents as peers. ([ADR 021](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **The resolve act** · Human ↔ agent loop — A terminal "done" signal for a thread. accept is not finished; resolve closes the loop. A new collaboration act and a SPEC bump — it serves both progress-awareness and the future board layer. ([ADR 025](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **Reachability nudge** · Human ↔ agent loop — musterd notify pushes a localhost OS notification so an away human learns an agent needs them. The minimal down-payment on the notification protocol Co-Gym shows more than doubles collaboration win rate. Full notification tiers come with v0.3 governance. ([ADR 035](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [ADR 024](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **Telemetry — Layer 1** · Telemetry & observability — One OTLP span per Envelope on the validate → persist → route path, plus act and team metrics. Off by default, no phone-home. meta.otel carries W3C trace context so a handoff links the sender and receiver traces across runtimes and vendors. @musterd/mcp emits and honors it. ([ADR 015](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [ADR 011](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [observability.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/observability.md))
- **Cross-network teams** · Transport & topology — Two people on two machines can share a team today — run the daemon on a Tailscale/WireGuard overlay and point each member’s MUSTERD_SERVER at its overlay address. The topology framework is decided (one team = one daemon, not federation): overlay now, secured bind next, hosted relay later. The secured off-loopback bind shipped — the daemon refuses a non-loopback plaintext bind without TLS (wss://) or a trusted proxy, gates the WS upgrade on Origin/Host, and makes WAN timeouts tunable. Still ahead: the v0.3 credentialed remote join it carries, and a hosted relay for those who won’t run an overlay. ([ADRs 039–040](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [overlay guide](https://github.com/SandRiseStudio/musterd/blob/main/docs/guides/cross-network-overlay.md), [deployment-topology.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/deployment-topology.md))
- **Harness adapters** · Harness environment — Claude Code, Cursor, and Codex each get a rendered role MCP server. Codex writes a project-local .codex/config.toml. Plus the role-template format and built-in library, musterd role, an uninstall manifest, charter injection, and musterd uninstall. ([ADRs 029–031](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [provisioning-recipe.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/provisioning-recipe.md))
- **Claim on first use** · Harness environment — A folder claim policy and live claim bring a running pending session online — no relaunch, no wire change. musterd claim --for <code> drops an ephemeral resolved sidecar the adapter adopts. The binding stays the durable channel; the sidecar is the live overlay. ([ADRs 032–034](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))

## Near-term

_Next up — designed, evidence-backed, not yet built._

- **Notification tiers** · Human ↔ agent loop — The full reachability set: route an agent’s request for help to a human by salience and availability, not only when they are watching. Co-Gym’s ablation: removing the notification protocol more than halves the collaboration win rate (30% → 70%). This is where the measured value is. _Builds on Reachability nudge._ ([research-foundation.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/research-foundation.md))

## Reserved (in v0.1, built later)

_The schema and wire format already make room; built later._

- **Telemetry — Layer 2 + SDK** · Telemetry & observability — A full CLI/MCP telemetry SDK, then MAST-aware views over the act-typed log that agent-observability tools cannot see. The seed of a standalone coordination-observability product. _Builds on Telemetry — Layer 1._ ([observability.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/observability.md))
- **Step-level streaming transport** · Transport & topology — v0.1 sends whole Envelopes. A v2 transport adds step-level streaming, which beats wait-for-complete for collaborating agents. The broadcast recipient kind is already distinct on the wire to anticipate richer delivery semantics.
- **Team-to-team federation** · Transport & topology — A Member belongs to one Team today. Teams that address one another, and identities recognized across Teams, come later. _Builds on Cross-network teams._
- **Web dashboard** · Surfaces — A web surface for the same Members — designed now, built later. This page is the first foundation of it. The Surface enum already includes web, ios, slack. Same Member, more Presences.
- **iOS & Slack surfaces** · Surfaces — An iOS app and a Slack surface, so a Member is reachable wherever its human or agent already lives. _Builds on Web dashboard._
- **Work items, board & insight layer** · Work items & insight — A kanban-style board and team analytics — derived as views over the message log, never stored beside it. Time-to-unblock, cycle time, load distribution, bottlenecks — plus a declared backlog noun for planned work. The natural home is the web dashboard. _Builds on The resolve act, Web dashboard._ ([human-agent-dynamics.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/human-agent-dynamics.md))
- **Role templates & mixed-harness teams** · Harness environment — A Role becomes a harness-agnostic provisioning template, rendered per-harness — then musterd’s own harness, then mixed-harness teams. Provisioning is a starting point, not a security boundary. It stays additive, reversible, and non-obligating. _Builds on Harness adapters._ ([ADRs 026–030](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **Schedule & lifecycle enforcement** · Platform — availability and lifecycle: until are stored today but not enforced. Later: honor windows for routing and auto-expire members.
- **Sandboxed runtime** · Platform — musterd connects agents; it does not run them. A later, optional sandbox could host members with nowhere else to live.
- **Python client SDK** · Platform — A fast follow after launch. The protocol is language-neutral; the TypeScript client is the reference, not the only one.

## Out of scope (by principle, not timing)

_Excluded by principle, not by timing._

- **A planner / orchestrator role** · Platform — One member does the work; the team does the coordination. musterd never forces decomposition. A team of one agent, plus optionally a human, is a first-class — even default — configuration.
- **Running your agent** · Platform — Protocol over framework. We connect agents; we don’t own their execution loop.

## How priorities are decided

The wedge is persistent teams with identity, presence, and humans as peers — the coordination layer where about 79% of multi-agent failures actually happen. Work is weighed by whether it strengthens that layer, not by adding more agents or more orchestration. Human partnership ranks first, on evidence: collaborative agents beat fully autonomous ones on real-user preference, and removing the notification protocol more than halves the win rate.

See: [ROADMAP.md](https://github.com/SandRiseStudio/musterd/blob/main/ROADMAP.md), [research-foundation.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/research-foundation.md), [landscape.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/landscape.md).

<!-- END GENERATED ROADMAP -->

Changes to `SPEC.md` are versioned and gated by an ADR (`docs/decisions/`). New collaboration **acts** or envelope-required fields are a spec-version bump.
