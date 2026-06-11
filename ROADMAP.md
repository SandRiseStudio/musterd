# Roadmap

musterd v0.1 is deliberately small: a protocol (`SPEC.md`), a local team server, a human CLI, and a universal MCP adapter. The schema and wire format already **reserve** the fields the items below need, so adding them does not break v0.1 clients. Nothing here is required for v0.1 conformance.

## Reserved in v0.1, built later

- **Schedule & lifecycle enforcement.** `members.availability` and `lifecycle: until` are stored today but not enforced at runtime. Later: honor availability windows for routing/notifications and auto-expire `until` members.
- **Step-level streaming transport.** v0.1 sends whole Envelopes. A v2 transport option adds step-level streaming (the StreamMA finding: step-level streaming beats wait-for-complete for collaborating agents). The `broadcast` recipient kind is already distinct on the wire to anticipate richer delivery semantics.
- **Team-to-team federation.** A Member belongs to one Team in v0.1 (see ADR 001). Federation — Teams that can address one another, and identities recognized across Teams — comes later; `broadcast` is reserved partly for this.
- **More Surfaces.** v0.1 implements `cli`, `claude-code`, `codex`. The `Surface` enum already includes `web`, `ios`, `slack`, `other`. Planned: a **web dashboard** (designed now in `docs/design/figma-brief-dashboard.md`, built later), an iOS app, and a Slack surface — same Member, more Presences.
- **Work items, board view & the insight layer.** Threads are already proto-work-items (the opening act creates the item; the acts within are its transitions). Later: a kanban-style board and team analytics (time-to-unblock, cycle time, load distribution, bottlenecks) **derived as views over the message log — never stored beside it** — plus a declared *backlog* noun for planned work (the one declaration that can't rot, because it creates intent rather than mirroring execution). Design + cautions (Goodhart, human-vs-agent measurement asymmetry): `docs/design/human-agent-dynamics.md` §4; open brainstorm agenda (planning noun, leadership reporting at altitudes, flow + cost-per-item metrics, the human "waiting-on" bottleneck view): `docs/design/planning-and-insights-brainstorm.md`. Natural home: the web dashboard.
- **Sandboxed runtime.** musterd connects agents; it does not run them. A later, optional sandboxed runtime could host members that have nowhere else to live.
- **Python client SDK.** A fast follow after launch. The protocol is language-neutral by design; the TypeScript `@musterd/protocol` is the reference, not the only possible implementation.

## Explicitly out of scope (by principle, not timing)

- **A planner / orchestrator / task-decomposer role.** Principle 5: one member does the work; the team does the coordination. musterd never forces decomposition. A team of one agent (plus optionally a human) is a first-class, even default, configuration.
- **Running your agent.** Principle 4: protocol over framework. We connect agents; we don't own their execution loop.

## How priorities are decided

The wedge is **persistent teams with identity, presence, and humans as peers** — the coordination layer where, per MAST (arXiv 2503.13657), ~79% of multi-agent failures actually happen. Roadmap work is weighed by whether it strengthens that layer (identity, durable inboxes, typed collaboration acts, human partnership) rather than by adding more agents or more orchestration.

Changes to `SPEC.md` are versioned and gated by an ADR (`docs/decisions/`). New collaboration **acts** or envelope-required fields are a spec-version bump.
