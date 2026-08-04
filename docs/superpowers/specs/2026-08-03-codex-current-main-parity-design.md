# Codex current-main parity design

- Status: proposed
- Date: 2026-08-03
- Builds on: ADR 031 (Codex provisioning), ADR 131 (harness residency), ADR 166 (session liveness), ADR 179 (work-order wakes), ADR 191 (review-loop wake), ADR 199 (dispatch-loop wake).

## Goal

Make Codex a first-class musterd harness on the current mainline: Codex CLI reaches the same observable coordination outcomes as Claude Code, while Codex desktop is separately verified and honestly reports manual resume until a stable supported app wake API is proven.

## Context

Current mainline already wires musterd into a project-local `.codex/config.toml`, exposes the neutral guidance skill, and represents `codex` as a valid harness class. It has one production residency backend: `claude-code`. The host loop, work-order derivation, wake-pool selection, model-attestation path, and session-liveness contract are current production machinery. An earlier Codex parity branch was based on an older architecture and is not a safe implementation base: its real-harness fixture and Codex backend are absent from current mainline, while the surrounding wake and MCP behavior have changed materially.

Parity means equal user-visible coordination outcomes, not identical harness internals. A Codex-specific fallback is acceptable only when the harness does not provide a stable capability.

## Scope

### Codex CLI

Codex CLI becomes a second `ActuatorBackend` implementation. The shared host loop continues to own wake leases, work-order derivation, local-session deferral, Presence-based verification, reporting, and policy bounds. The backend owns only Codex binary discovery, argument construction, local session capture/liveness, process lifecycle, and the resume/fresh decision.

A Codex CLI capability probe establishes that the locally installed version supports the exact properties required for safe automation:

- a noninteractive headless execution form;
- exact session/thread identity emitted in machine-readable output;
- an exact-session resume form;
- a workspace-local capture/liveness source;
- model evidence compatible with existing musterd attestation; and
- project-local MCP configuration usable from the generated workspace.

Failure to establish any required property is a supported non-wakeable state. Enrollment and host output must say why rather than attempting an unsafe or ambiguous launch.

The CLI wake ladder is:

1. Use a valid, locally captured Codex session when available.
2. Resume it and require its emitted thread identity to equal the captured identity.
3. Require newly touched, wake-provenance roster Presence before treating the resume as occupied.
4. On an ordinary resume miss, run a fresh Codex session within the same lease and apply the same roster verification.
5. A clean exact resume with no causally correlated fresh Presence is failed, not credited or deferred, and does not spend a second untracked fallback.

The backend uses the existing process-group watchdog contract. It starts only inside the enrolled workspace, uses a sanitized child environment, and never puts agent keys, grants, binding contents, or generated configuration in command arguments or failure diagnostics. Production wake argv never use a hook-trust bypass.

### Codex desktop

Codex desktop remains a separately verified harness surface. Its acceptance matrix covers project MCP load, reload/reconnect, explicit join and claim approval, duplicate-seat protection, directed inbox delivery and drain, workspace isolation, and model/build attestation.

Desktop daemon wake is explicitly unsupported unless a versioned capability probe demonstrates a stable, supported app API for session targeting, lifecycle observation, and safe wake/resume. Until then an offline desktop seat has durable inbox delivery plus a visible manual-resume instruction. It is not put into the host registry as a wakeable Codex CLI seat.

## Outcome contract

| Outcome | Codex CLI | Codex desktop |
| --- | --- | --- |
| Workspace wiring | Project-local musterd MCP server | Same |
| Guidance | Primer plus neutral `.musterd/skill/SKILL.md` | Same |
| Join and claim | Real MCP join, approval, duplicate-seat protection | Verified in the app |
| Directed coordination | Inbox delivery, check, and drain | Same, with visible manual-resume instruction when offline |
| Reconnect | Exact thread identity plus model/build attestation | MCP reload/reconnect plus attestation |
| Residency | Resume then fresh fallback under the host loop | Unsupported unless the stable-API probe passes |
| Work-order wake | Native host backend, including dispatch/review loop policy | Held/manual-resume when unreachable |
| Safety | Isolated workspace, sanitized environment, bounded child lifecycle, redacted diagnostics | Same configuration and diagnostic constraints |

## Verification model

Three layers establish evidence without making paid harness execution part of the normal suite:

1. **Hermetic checks.** Unit and integration tests use injected children and temporary workspaces to verify capability parsing, configuration isolation, argument/trust policy, session capture, lifecycle races, wake verification, resume/fresh behavior, work-order bounds, cleanup, and secret-safe diagnostics.
2. **Explicit real Codex CLI acceptance.** A separately invoked command, gated by two explicit owner-provided environment variables, uses an isolated Git workspace and Team. It drives actual Codex MCP join, directed inbox handling, reconnect, duplicate-seat behavior, and hosted resume/fresh behavior. It is not default CI and never runs without those gates.
3. **Desktop evidence matrix.** A versioned manual runbook gives pass/fail steps and records the tested Codex desktop version and capability result. It never claims daemon wake without a stable supported API.

Direct real-acceptance automation may use a documented, exact-fixture hook-trust exception only after verifying the generated hook files. This is an acceptance seam, not a persisted trust decision and not production wake evidence. Hosted wake remains trust-bypass-free.

## Non-goals

- A new daemon runtime, orchestrator, or Codex-specific gateway.
- A protocol schema change merely to name Codex: residency harness identifiers are already open strings.
- Desktop daemon wake without a demonstrated stable app API.
- Running paid Codex or Claude sessions from the default test suite or CI.
- Replaying the older parity branch onto current mainline wholesale.

## Constraints

- Preserve the user-visible parity definition above, with Codex-specific fallbacks only for absent stable capabilities.
- Keep Codex CLI and desktop verification distinct.
- Preserve existing work-order, wake-pool, local-session, and model-attestation semantics.
- Parse external CLI output and configuration at boundaries; never infer identity from prose output.
- Keep session identifiers and transcript paths local; never transmit them to the daemon.
- Never log or expose credentials, grants, agent keys, raw binding files, or raw generated configuration.
- Add no runtime dependency without a new ADR.
- Do not amend accepted ADRs; write a new ADR only if this design requires a decision that conflicts with one.

## Delivery order

1. Establish and test the Codex CLI capability/capture seam.
2. Add the production backend and register it with the host.
3. Add hermetic lifecycle, work-order, isolation, and secret-redaction coverage.
4. Add the explicit owner-gated real CLI acceptance command and its non-paid boundary tests.
5. Publish the desktop matrix and current capability result.

Each increment must be independently reviewable and must leave current Claude Code behavior unchanged.
