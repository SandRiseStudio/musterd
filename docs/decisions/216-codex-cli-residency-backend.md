# 216 — Codex CLI residency backend and desktop evidence boundary

- Status: accepted
- Date: 2026-08-03
- Builds on: [ADR 031](031-codex-adapter-scope.md) (Codex provisioning),
  [ADR 131](131-harness-residency-wake-ledger-host.md) (residency host),
  [ADR 166](166-session-liveness-by-enumeration.md) (local liveness),
  [ADR 179](179-board-triggered-work-order-wakes.md) (the actuator contract), and
  [ADR 199](199-dispatch-loop-wake.md) (dispatch work-orders).

## Context

musterd already provisions a project-local Codex MCP entry and gives every MCP Surface the same
primer and neutral skill. The residency host has only one production backend: Claude Code. Codex is
therefore coordinate-capable while a person is driving it, but it is not yet a host-wakeable Surface.

Codex CLI documents a headless `exec` form, JSON output, and an exact-session `exec resume` form.
The desktop app exposes MCP configuration and reload, but no versioned, supported API has been
established for targeting an existing desktop task, observing its lifecycle, and waking or resuming
it safely.

## Problem

Treating Codex as Claude Code by analogy risks the coordination properties residency is meant to
protect: resuming the wrong task, starting beside an already-live task, mistaking prose for identity,
or claiming a wake succeeded without a fresh musterd Presence. Conversely, withholding all Codex
support leaves a user-visible gap despite MCP coordination already working.

Desktop and CLI are separate products. Calling desktop manually wakeable because its MCP server can
reconnect would be a false promise; installing a CLI backend without proving its identity and
liveness seams would be the symmetrical mistake.

## Decision

### 1. Codex CLI is a second native `ActuatorBackend`

The shared host continues to own leases, work-order derivation, local-session deferral,
Presence-based verification, policy bounds, reporting, and the watchdog contract. The Codex backend
owns only binary capability, argument construction, local identity/capture/liveness, child-process
lifecycle, and the resume/fresh decision.

It is enabled only after a capability probe establishes all of these for the installed Codex CLI:

1. noninteractive headless execution;
2. an exact thread identity from machine-readable output;
3. exact-session resume;
4. workspace-local capture/liveness evidence;
5. model evidence compatible with musterd's existing attestation path; and
6. project-local MCP configuration usable from the enrolled workspace.

Missing or ambiguous capability makes the Surface supported but non-wakeable, with an actionable
reason. It never guesses from prose output or a global same-named configuration row.

### 2. Wake proof is resume, identity, and fresh Presence

The backend first resumes a valid locally captured Codex thread. The emitted identity must equal the
captured identity, and the host must observe newly touched wake-provenance Presence for that Member.
An ordinary resume miss may take one bounded fresh-session fallback within the existing lease; it
uses the same Presence proof. A clean exact resume that lacks causally correlated fresh Presence
fails: it is not credited, deferred, or followed by an untracked second launch.

The child starts only in the enrolled workspace. Fresh execution may use Codex's documented
workspace flag; exact resume relies on the child process working directory when that subcommand does
not accept the flag. The child environment is allow-listed and sanitized. Credentials, grants,
binding contents, generated configuration, session ids, and transcript paths never appear in argv,
daemon payloads, or failure diagnostics. Production argv never carry a hook-trust, sandbox, or
approval bypass.

### 3. Desktop is verified separately and remains manual-resume

Desktop acceptance records project MCP load/reload, join and claim approval, duplicate-seat
protection, directed inbox delivery/drain, reconnect, workspace isolation, and model/build
attestation. An offline desktop Member receives durable delivery and a manual-resume instruction.

Desktop is not registered as daemon-wakeable unless a versioned capability probe proves a stable,
supported API for exact task targeting, lifecycle observation, and safe wake/resume. A CLI backend
does not imply that capability for the desktop app.

### 4. Evidence is layered and paid execution is owner-gated

Hermetic tests cover capabilities, argv/trust policy, capture, liveness, lifecycle races,
resume/fresh proof, work-order bounds, workspace isolation, and redaction. A separate real Codex CLI
acceptance command requires two explicit owner-provided environment gates and an isolated Git
workspace and Team. It is never default CI. A versioned desktop runbook records the desktop result
and the capability outcome.

## Consequences

- Codex CLI has the same user-visible residency and work-order outcomes as Claude Code once its
  installed capability probe passes, without changing the protocol or creating a Codex daemon.
- Codex desktop coordination is honestly supported, while desktop daemon wake is explicitly held at
  manual resume rather than implied by CLI support.
- A second backend proves ADR 179's actuator seam is harness-shaped rather than Claude-shaped.
- Existing Claude Code behavior and host ownership boundaries stay unchanged.
- The roadmap tracks this as an active multi-increment Goal until backend, acceptance, and desktop
  evidence all land.

## Observability & Evaluation

- **Traces.** Existing `residency.wake_leased`, `residency.woke`, and `residency.wake_failed` rows
  retain their schema and carry the harness through the existing wake detail. Local-only diagnostics
  identify the failed capability or proof edge without retaining secrets or session material.
- **Eval.** Baseline: Codex has project MCP coordination but no host backend or desktop wake claim.
  Success: owner-gated CLI acceptance proves real MCP join, directed delivery/drain, exact reconnect,
  and a host resume/fresh wake that reaches fresh Presence; the desktop matrix records each supported
  outcome and explicitly records wake as unsupported unless its stable-API probe passes.
- **Experiment.** Run the gated CLI acceptance against one isolated Team after each compatible Codex
  release, and repeat the desktop matrix on a deliberate desktop upgrade. A regression that removes
  identity, resume, or liveness evidence demotes the affected Surface to non-wakeable rather than
  preserving a stale claim.
