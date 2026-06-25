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
- **Availability axis + urgent breakthrough** · Human ↔ agent loop — A human sets their own availability (available/away/dnd, away_until); an urgent flag with a required reason breaks through an away/dnd hold, and the notify loop tiers delivery by it. The localhost down-payment on the governed model: availability is stored and on the roster, urgent rides meta with no version bump, tiering runs client-side. can_flag_urgent gating, audit, and the wasnt_urgent feedback are the v0.3 superset. _Builds on Reachability nudge._ ([ADR 044](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [SPEC A.6a](https://github.com/SandRiseStudio/musterd/blob/main/SPEC.md))
- **Agent-side reachability** · Human ↔ agent loop — The agent half of the reachability loop: a directed act waiting for an agent surfaces on every command it runs, so a heads-down agent can’t miss a request_help addressed to it. The mirror of ADR 024’s human comeback summary, on the agent side. A dogfood finding — a seat-holding agent read its inbox once and left a directed request_help unanswered. A one-line stderr nudge appended to every acting command, built from the same pending-action predicate; client-side, no wire change. _Builds on Reachability nudge._ ([ADR 046](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [research-foundation.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/research-foundation.md))
- **Telemetry — Layer 1** · Telemetry & observability — One OTLP span per Envelope on the validate → persist → route path, plus act and team metrics. Off by default, no phone-home. meta.otel carries W3C trace context so a handoff links the sender and receiver traces across runtimes and vendors. @musterd/mcp emits and honors it. ([ADR 015](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [ADR 011](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [observability.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/observability.md))
- **Cross-network teams** · Transport & topology — Two people on two machines can share a team today — run the daemon on a Tailscale/WireGuard overlay and point each member’s MUSTERD_SERVER at its overlay address. The topology framework is decided (one team = one daemon, not federation): overlay now, secured bind next, hosted relay later. The secured off-loopback bind shipped — the daemon refuses a non-loopback plaintext bind without TLS (wss://) or a trusted proxy, gates the WS upgrade on Origin/Host, and makes WAN timeouts tunable. Still ahead: the v0.3 credentialed remote join it carries, and a hosted relay for those who won’t run an overlay. ([ADRs 039–040](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [overlay guide](https://github.com/SandRiseStudio/musterd/blob/main/docs/guides/cross-network-overlay.md), [deployment-topology.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/deployment-topology.md))
- **Harness adapters** · Harness environment — Claude Code, Cursor, and Codex each get a rendered role MCP server. Codex writes a project-local .codex/config.toml. Plus the role-template format and built-in library, musterd role, an uninstall manifest, charter injection, and musterd uninstall. ([ADRs 029–031](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [provisioning-recipe.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/provisioning-recipe.md))
- **Claim on first use** · Harness environment — A folder claim policy and live claim bring a running pending session online — no relaunch, no wire change. musterd claim --for <code> drops an ephemeral resolved sidecar the adapter adopts. The binding stays the durable channel; the sidecar is the live overlay. ([ADRs 032–034](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **Daemon service lifecycle** · Platform — musterd service runs the daemon as a background service that survives a closed terminal, restarts on crash, and starts at login — without raw launchctl. A per-user macOS LaunchAgent today; systemd (--user) and Windows are the named seam. The CLI manages musterd’s own daemon’s lifecycle — not member agents — so the clean-core principle stays intact. ([ADR 045](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **Service guardrails** · Platform — musterd service stop/restart refuses when other members hold live sessions, so bouncing a shared daemon doesn’t silently drop a teammate. Ties the daemon lifecycle command to roster awareness. A dogfood finding — a shared daemon was restarted three times under a live teammate with no in-band heads-up. The CLI reads a derived connections count from /health and refuses by default; --force overrides, and it fails open when the daemon is unreachable. The daemon stays a clean core that only reports. _Builds on Daemon service lifecycle._ ([ADR 047](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))

## Near-term

_Next up — designed, evidence-backed, not yet built._

- **Ambient agent presence** · Human ↔ agent loop — An agent doing bursty one-shot CLI work shows present on the roster instead of offline until it opens a watch socket. Today presence needs a resident WS session; a sequence of one-shots reads as offline. A short-TTL presence touch on each authenticated command closes the gap — liveness from real actions, while working: <x> still comes from a self-reported status_update. Needs its own ADR (presence-write semantics). ([ADR 010](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [ADR 017](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **Inbox reaches a blocked agent** · Human ↔ agent loop — A teammate’s message reaches an agent parked on an approval prompt — surfaced into the terminal the human is already at — and the sender sees “blocked awaiting approval” instead of silence. A dogfood finding: with per-tool approval on, an agent frozen on a permission prompt runs no command, so ADR 046’s per-command nudge can’t fire and the message waits until the human hand-relays it — the message-bus regression. Allowlisting musterd commands doesn’t help; the block is on the agent’s own gated work. The fix is push, not pull: provisioning installs a Claude Code Notification hook that prints unread directed acts at the approval-prompt moment, and the same hook marks the seat blocked_on_approval so the sender knows to nudge. Harness-provisioned, reversible via the manifest, no wire change. _Builds on Agent-side reachability._ ([ADR 053](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [ADR 046](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [ADR 030](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **Wake on message** · Human ↔ agent loop — An idle agent blocks until its next directed act arrives and resumes immediately — instead of polling on a timer or missing the message in the gap. A dogfood finding: asked to “wake when the other agent messages,” an agent bolted inbox-polling onto /loop — a workaround that burns turns and trades latency for cost. Add musterd inbox --wait, a blocking one-shot over the existing watch socket that exits on the first directed act, and bless the musterd inbox --wait + /loop idiom in the AGENTS.md primer. The free-agent complement to ADR 053’s blocked-agent push; neither reaches a frozen loop, so they pair. _Builds on Ambient agent presence._ ([ADR 054](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [ADR 012](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **Traces & evals first-class gate** · Telemetry & observability — Every agent-facing feature ships with its traces and an eval, the way it ships with tests — an ADR-template section and a format:check guard enforce it. The cheap, compounding half of the trace → eval → experiment flywheel: an "Observability & Evaluation" section in the ADR template (traces, eval metric + dataset + baseline, experiment) and an obs-evals:check step in format:check, modeled on the arch-tree checker (presence and shape, not content). So features built through later waves carry telemetry by default and batond never retrofits. ([ADR 052](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [ADR 051](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [observability.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/observability.md))
- **Frictionless seat binding** · Harness environment — A low-friction way to bind a working folder to a seat, so an agent shelling out repeatedly doesn’t re-export identity env on every call. The mechanism exists (musterd claim writes .musterd/binding.json); the gap is making it the obvious default for a long-lived working seat. A dogfood finding — ~6 repeated MUSTERD_* env exports in one session. ([ADR 036](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [ADRs 032–034](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **CLI ergonomics** · Platform — Unknown flags warn instead of being silently dropped, and inbox gains --act/--from filters. Dogfood papercuts: inbox --act handoff silently ignored the flag and printed everything. Small and additive.
- **Notification tiers** · Human ↔ agent loop — The full reachability set: route an agent’s request for help to a human by salience and availability, not only when they are watching. Co-Gym’s ablation: removing the notification protocol more than halves the collaboration win rate (30% → 70%). This is where the measured value is. The localhost availability + urgent down-payment shipped; the governed superset (can_flag_urgent, audit, wasnt_urgent, off_hours) needs the v0.3 capability model. _Builds on Reachability nudge, Availability axis + urgent breakthrough, v0.3 governance — seats, grants, capabilities._ ([research-foundation.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/research-foundation.md))
- **v0.3 governance — seats, grants, capabilities** · Platform — Seats with account status, roles with default capabilities, per-seat narrowing, issued grants, and credentialed remote join — the enforced layer the wire already anticipates. Designed in SPEC A.7/A.9 and spec-v0.3-draft.md. The prerequisite rock for the full notification tiers (can_flag_urgent, audit, wasnt_urgent), schedule enforcement, and safe multi-user/remote teams. Includes the members→seats migration and the credentialed remote join cross-network carries. _Builds on Cross-network teams._ ([spec-v0.3-draft.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/spec-v0.3-draft.md), [SPEC A.7/A.9](https://github.com/SandRiseStudio/musterd/blob/main/SPEC.md))

## Reserved (in v0.1, built later)

_The schema and wire format already make room; built later._

- **Schedule & lifecycle enforcement** · Platform — availability and lifecycle: until are stored today but not enforced. Later: honor windows for routing and auto-expire members. _Builds on v0.3 governance — seats, grants, capabilities._
- **Telemetry — Layer 2 + SDK** · Telemetry & observability — A full CLI/MCP telemetry SDK, then MAST-aware views over the act-typed log that agent-observability tools cannot see. The seed of a standalone coordination-observability product. _Builds on Telemetry — Layer 1._ ([observability.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/observability.md))
- **Web dashboard** · Surfaces — A web surface for the same Members — designed now, built later. This page is the first foundation of it. The Surface enum already includes web, ios, slack. Same Member, more Presences.
- **iOS & Slack surfaces** · Surfaces — An iOS app and a Slack surface, so a Member is reachable wherever its human or agent already lives. _Builds on Web dashboard._
- **Work items, board & insight layer** · Work items & insight — A kanban-style board and team analytics — derived as views over the message log, never stored beside it. Time-to-unblock, cycle time, load distribution, bottlenecks — plus a declared backlog noun for planned work. The natural home is the web dashboard. _Builds on The resolve act, Web dashboard._ ([human-agent-dynamics.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/human-agent-dynamics.md))
- **Coordination-density insight** · Work items & insight — An insight that flags when a team’s traffic is all broadcast-journal and no directed or threaded exchange — coordination that only looks collaborative. A dogfood finding: status_updates posted into a channel where no one shares the work degrade into a journal. A signal only musterd’s act-typed log can compute — a candidate metric for the standalone coordination-observability product. _Builds on Work items, board & insight layer._ ([human-agent-dynamics.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/human-agent-dynamics.md))
- **Eval & experiment engine (batond)** · Telemetry & observability — The batond half of the flywheel: team-outcome evals and side-by-side experiments over model × prompt × harness × team topology — built on a bought, Langfuse-shaped backend, never a from-scratch store. Emit in musterd, engine in batond (ADR 051). OTel wire + Langfuse semantics for scores/datasets/experiments, plus the coordination-native additions no single-agent vendor can do: evals scored against a Goal’s definition-of-done (ADR 048/050), experiments that vary the team itself, judge calibration as meta-evals, and the harness-decay measurement that says when to delete complexity models have absorbed. _Builds on Telemetry — Layer 2 + SDK, Work items, board & insight layer._ ([ADR 051](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions), [observability.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/observability.md))
- **Step-level streaming transport** · Transport & topology — v0.1 sends whole Envelopes. A v2 transport adds step-level streaming, which beats wait-for-complete for collaborating agents. The broadcast recipient kind is already distinct on the wire to anticipate richer delivery semantics.
- **Team-to-team federation** · Transport & topology — A Member belongs to one Team today. Teams that address one another, and identities recognized across Teams, come later. _Builds on Cross-network teams._
- **Role templates & mixed-harness teams** · Harness environment — A Role becomes a harness-agnostic provisioning template, rendered per-harness — then musterd’s own harness, then mixed-harness teams. Provisioning is a starting point, not a security boundary. It stays additive, reversible, and non-obligating. _Builds on Harness adapters._ ([ADRs 026–030](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions))
- **Sandboxed runtime** · Platform — musterd connects agents; it does not run them. A later, optional sandbox could host members with nowhere else to live.
- **Python client SDK** · Platform — A fast follow after launch. The protocol is language-neutral; the TypeScript client is the reference, not the only one.

## Out of scope (by principle, not timing)

_Excluded by principle, not by timing._

- **A planner / orchestrator role** · Platform — One member does the work; the team does the coordination. musterd never forces decomposition. A team of one agent, plus optionally a human, is a first-class — even default — configuration.
- **Running your agent** · Platform — Protocol over framework. We connect agents; we don’t own their execution loop.

## Build sequence

_Priority order across all unshipped work — the coarse status grouping above, re-cut by what we build next._

**Gate — ship v0.2.** Ship v0.2 — publish to npm + the launch post — before new dev, so adoption feedback informs the rest.

### Wave 1 — Harden the coordination loop — small, additive, evidence-backed.

- **Ambient agent presence** · Human ↔ agent loop
- **Inbox reaches a blocked agent** · Human ↔ agent loop
- **Wake on message** · Human ↔ agent loop
- **CLI ergonomics** · Platform
- **Frictionless seat binding** · Harness environment
- **Traces & evals first-class gate** · Telemetry & observability

### Wave 2 — The v0.3 governance rock, then the full governed tiers it unlocks.

- **v0.3 governance — seats, grants, capabilities** · Platform
- **Notification tiers** · Human ↔ agent loop
- **Schedule & lifecycle enforcement** · Platform

### Wave 3 — Reach + the second-product seed.

- **Telemetry — Layer 2 + SDK** · Telemetry & observability
- **Web dashboard** · Surfaces
- **iOS & Slack surfaces** · Surfaces
- **Work items, board & insight layer** · Work items & insight
- **Coordination-density insight** · Work items & insight

### Later — No near-term pull; opportunistic.

- **Eval & experiment engine (batond)** · Telemetry & observability
- **Step-level streaming transport** · Transport & topology
- **Team-to-team federation** · Transport & topology
- **Role templates & mixed-harness teams** · Harness environment
- **Sandboxed runtime** · Platform
- **Python client SDK** · Platform

## How priorities are decided

The wedge is persistent teams with identity, presence, and humans as peers — the coordination layer where about 79% of multi-agent failures actually happen. Work is weighed by whether it strengthens that layer, not by adding more agents or more orchestration. Human partnership ranks first, on evidence: collaborative agents beat fully autonomous ones on real-user preference, and removing the notification protocol more than halves the win rate.

See: [ROADMAP.md](https://github.com/SandRiseStudio/musterd/blob/main/ROADMAP.md), [research-foundation.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/research-foundation.md), [landscape.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/design/landscape.md).

<!-- END GENERATED ROADMAP -->

Separate tracks (not the product line): the tiny-model dogfood fixture, and the parked planning-and-insights brainstorm (feeds Wave 3).

Changes to `SPEC.md` are versioned and gated by an ADR (`docs/decisions/`). New collaboration **acts** or envelope-required fields are a spec-version bump.
