# musterd — status & history

> **Where we are now**, kept short and mostly derived. The decision record is `docs/decisions/` (the ADRs — the *why* and the per-change detail); what's next is `ROADMAP.md`; the protocol contract is `SPEC.md`. See AGENTS.md → “Where each doc lives” for how the docs fit together. Update this file only when the **milestone state** changes — not per PR (git + the ADRs are the per-change record).

## Status — 2026-09-19

- **Product:** v0.2 behavior remains stable. The optional Tailscale + Aperture paved road is not a complete runtime path; its current boundary is reviewed artifacts plus an opt-in authorization substrate.
- **Paved-road Increment 1:** implemented as the read-only `musterd integration doctor` for Tailscale transport and Aperture configuration posture ([ADR 385](decisions/385-optional-tailscale-aperture-doctor.md)).
- **Paved-road Increment 2a:** implemented as deterministic, secret-free Aperture policy and Member mapping generation ([ADR 400](decisions/400-aperture-policy-generator.md)).
- **Paved-road Increment 2b:** implemented as deterministic, secret-free Tailscale transport policy and workload mapping generation ([ADR 402](decisions/402-tailscale-transport-generator.md)).
- **Paved-road Increment 3:** partially implemented as the protocol/server authorization substrate ([ADR 411](decisions/411-governed-model-authorization-substrate.md)). It covers server-owned policy, one-shot `msla_` launch handoffs, enrolled node and Presence checks, bounded Lane/Act context, structured refusal, and metadata-only audit. It does not launch Claude Code or Codex, bind a live Tailscale/Aperture runtime, route provider requests, or activate `required` enforcement.
- **Paved-road Increment 4:** not implemented. There is no API-driven Tailscale/Aperture provisioning or apply surface.
- **Protocol:** `SPEC.md` remains **`musterd/0.3`**; Appendix A.12 defines the strict governed policy, one-shot launch handoff, work contexts, and structured decisions from ADR 411.
- **Published:** `@musterd/*@0.2.0` on npm (git tag `v0.2.0`).
- **Quality:** Package-level tests cover the protocol schemas, generator/doctor behavior, and governed server routes. No automated end-to-end scenario currently proves the original full path from a supported Surface through Tailscale and Aperture to provider/cost evidence.
- **Open:** governed launcher adapters, live Tailscale/Aperture runtime binding and configuration, provider/cost correlation, a future `required` cutover, Increment 4 provisioning, and the optional **real 3-pane demo** recording remain separate work.

## The original plan (recap)

An open-source coordination layer — **named, persistent teams of agents and humans, across any harness, with a shared protocol** — as a pnpm/TypeScript monorepo (`protocol` / `server` / `cli` / `mcp`), designed in the open. Milestones **M0–M6**: planning docs → scaffold + SPEC v0.1 (+ reserve the npm name) → server core → human CLI → MCP adapter → flagship 3-pane demo → launch polish. **All M0–M6 shipped**; the one optional remainder is the live 3-pane recording (the launch ships the honest scripted walkthrough). `musterd init` (interactive onboarding) was an unplanned addition that became the quickstart (ADR 005).

## How we deviated (the ADRs are the record)

Every deviation is an ADR; `docs/decisions/` is the index and the detail. The shape of the journey:

- **ADR 007 — the scope cut (the big one).** A governance brainstorm, sparked by the auto-join *"N minds, one name"* bug, ballooned into a full shared-teams design. 007 cut v0.2 back to the minimal trust model and deferred governance to v0.3 (now `SPEC.md` Appendix A).
- **ADRs 001–004, 006, 009** — implementation simplifications + the `@musterd/cli` scope pivot (unscoped `musterd` was blocked by npm).
- **ADR 008** — the Figma briefs executed against the built reality (CLI is the source of truth).
- **ADRs 010, 014, 016–023** — the v0.2 trust model and a long *dogfood-driven* onboarding/diagnostics hardening pass: single-active newest-wins (017), one workspace binding (018), `team remove` (019), the init folder guard (020), driver co-presence (021), `reset` (022), primer honesty (023), served-db visibility (016), provenance/workspace at attach (014).
- **ADRs 011, 015** — observability Layer 1 (envelope span + metrics, off by default) and the `meta.otel` trace-context convention.
- **ADRs 024–025** — the first post-launch human↔agent-loop work: the reachability nudge (024) and the `resolve` act (025).
- **ADRs 026–028** — harness tool environment (the *two universes*; Role as a harness-agnostic provisioning template), non-invasive harness coexistence, and *compose, don't capture* (defer to proven/universal tools — MCP, git/worktrees, the harness; reinvent nothing they do well). **Direction, deferred** — see `ROADMAP.md`.
- **ADRs 029–031** — provisioning made real: the role-template format (029), the provision manifest (030), and the Codex harness adapter (031) — all three required adapters (Cursor / Claude Code / Codex) ship.
- **ADRs 032–034** — **claim-on-first-use**: a session may start *unclaimed* (bound to a folder claim policy), become a pending presence (033), and be brought online by an external `musterd claim` **without a relaunch** (034) — all riding existing primitives, no wire change.
- **ADRs 035–036** — closing the human side of the loop on localhost: **`musterd notify`** (035) buzzes a human when a directed act lands while they aren't watching (the localhost down-payment on the v0.3 notification tiers), and **active-identity-to-act** (036) makes the global config a credential store, not an act-authority — no command silently acts as a real teammate from an unrelated folder.
- **ADRs 037–042** — the public **web surface** (037: marketing + roadmap map + the winding-road visual); the **role-label↔template** unification (038); **cross-network teams** — the topology framework decided (039) and the **secured off-loopback bind** built (040: refuse a non-loopback *plaintext* bind, native TLS/`wss://` or `--insecure-trust-proxy`, Origin/Host gate on the WS upgrade, env-tunable WAN timeouts) plus the Topology B overlay operator guide; the **roadmap single-sourced** to typed data with `ROADMAP.md` generated from it (041); and **humans multi-presence** (042) — single-active becomes *kind-scoped* (agent seats displace, newest-wins; human seats fan out across surfaces), the mechanics ADR 039 §7 deferred, with no protocol-version bump. The transport that lets the daemon leave localhost now exists — the v0.3 credentialed remote join it carries is still unbuilt.

For per-ADR detail — context, options, consequences, the dogfood findings each one closed — read the ADRs. They are the record; this file is only the map of where we are.
