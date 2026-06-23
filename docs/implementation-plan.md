# musterd — status & history

> **Where we are now**, kept short and mostly derived. The decision record is `docs/decisions/` (the ADRs — the *why* and the per-change detail); what's next is `ROADMAP.md`; the protocol contract is `SPEC.md`. See AGENTS.md → “Where each doc lives” for how the docs fit together. Update this file only when the **milestone state** changes — not per PR (git + the ADRs are the per-change record).

## Status — 2026-06-23

- **Product:** v0.2 scope **complete** — the minimal trust model (explicit activation; single-active *newest-wins* + 45s reclaim grace; self-reported `working` status), plus observability **Layer 1** and a long dogfood-driven onboarding/diagnostics hardening pass.
- **Protocol:** `SPEC.md` is **`musterd/0.3`** — the terminal **`resolve` act** (thread-close → the open-vs-done axis) shipped over v0.2 (ADR 025). The full **shared-teams governance** set (seats/roles, agent key + grants, approval lane, capabilities, audit, notification tiers, observers) is **designed but not specified** (`SPEC.md` Appendix A; rationale in `docs/design/membership-model.md`) and **not built** — trigger: the daemon stops being localhost-only.
- **Published:** `@musterd/*@0.2.0` on npm (git tag `v0.2.0`).
- **Quality:** `pnpm -r build && pnpm test` green; coverage gates wired (ADR 013), all packages at their documented targets — cli/mcp reached the **75%** line target (onboarding-wizard + MCP tool-handler tests) and the floors were ratcheted up to match.
- **Open:** post the launch (a human action); the optional **real 3-pane demo** recording (unblocked — ADRs 012 + 021).

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

For per-ADR detail — context, options, consequences, the dogfood findings each one closed — read the ADRs. They are the record; this file is only the map of where we are.
