# 120 — Harness model attestation seam and self-ID tripwire

- Status: accepted
- Date: 2026-07-09
- Builds on: ADR 101 (model as a variable), ADR 060 (verify provisioning, do not assume), ADR 089 (MCP telemetry)

## Context

ADR 101 records the model on the live occupancy and stamps it onto each Act. The current
implementation accepts a model declaration from `MUSTERD_MODEL` (with the existing
`ANTHROPIC_MODEL` fallback) and keeps `unknown` legal. This is sufficient for a pinned
single-model seat, but it has two honesty gaps:

1. A resident MCP harness knows which host launched it through MCP `clientInfo`, but the
   adapter currently has no explicit seam for retaining that identity alongside its
   attestation.
2. Cursor and other hosts can switch models per prompt while the MCP process remains
   resident. A static environment declaration can therefore become stale without any
   visible signal.

The server cannot verify which model generated an Act. It can only preserve what the
harness declares and make stale or missing declarations visible.

## Problem

The model-diversity and frontier-cadence surfaces need to distinguish:

- a model explicitly pinned by the operator,
- a model declared by the harness at MCP initialization,
- a missing declaration, and
- a declaration that may no longer match the model serving the current turn.

Silently promoting a harness name or MCP client version to a model id would create false
experimental data. Silently accepting a stale pinned value would create the same problem
in a less visible way.

## Decision

Add a two-part seam for the next implementation increment.

### 1. Preserve MCP `clientInfo` as harness context, not model truth

At MCP initialization, capture the host-provided `clientInfo` (`name` and `version`) in
adapter-local runtime context and telemetry. Do not use either field as `model`, and do
not send it as the server-controlled `meta.model` stamp.

The attestation ladder remains:

1. explicit `MUSTERD_MODEL`,
2. the existing `ANTHROPIC_MODEL` fallback,
3. a model persisted in the local binding,
4. `unknown`.

`clientInfo` is diagnostic context that answers “which harness launched this adapter?”
It does not answer “which model generated this Act?” If the protocol later exposes
attach-time harness metadata, it must be additive and optional; this increment does not
change the Envelope or Act schemas.

### 2. Add a self-ID tripwire at the adapter boundary

When the adapter has no explicit model declaration, it remains usable and attests
`unknown`, but it records a warn-level diagnostic at initialization and exposes the
condition to the existing provisioning drift check. The diagnostic includes the
harness `clientInfo` when available, never credentials or message bodies.

When a model is explicitly pinned, the adapter treats that value as a seat-local
experiment manifest term. A future host integration may provide a per-turn model
identity through a dedicated MCP/client seam; until that seam exists, the adapter must
not infer a model from prompt content, tool arguments, client name, or client version.
An operator who changes models without changing the declaration is responsible for the
stale-attestation warning in the runbook.

The tripwire is therefore warn-never-block:

- missing model → `unknown` plus a diagnostic;
- explicit model → attest it and retain the existing claim/heartbeat behavior;
- conflicting future self-ID → warn, preserve the declared value, and emit evidence for
  investigation rather than silently replacing the experiment variable.

This keeps ADR 101's per-occupancy and server-controlled per-Act integrity intact while
giving harnesses a safe place to add stronger self-identification later.

## Consequences

- MCP telemetry can correlate an attestation with the harness that supplied it without
  confusing harness identity with model identity.
- Thin and legacy harnesses continue to work; their data is honestly marked
  unverifiable instead of being blocked or guessed.
- A resident harness that changes models mid-Presence remains a known limitation until a
  host-supported per-turn identity seam exists.
- The implementation increment is adapter-side and diagnostic; it requires no protocol
  version bump, database migration, or new runtime dependency.
- The runbook can tell operators exactly when a static `MUSTERD_MODEL` pin is safe:
  one dedicated model per seat, or an explicit future self-ID integration.

## Observability & Evaluation

**Traces** — MCP initialization records the sanitized `clientInfo.name` and
`clientInfo.version` as adapter telemetry context. A missing model emits one warn-level
diagnostic per adapter start and remains visible to `init --check`; existing
`occupancy.model_attested`, per-Act `meta.model`, and model span attributes remain the
authoritative attestation evidence.

**Eval** — metric: attestation honesty coverage, split into declared, unknown, and
diagnostic-bearing starts. Dataset: MCP initialization records plus the resulting
occupancy audit rows and per-Act stamps. Baseline: current adapters, where
`clientInfo` is not retained and missing model declarations are only discovered through
later roster/report inspection. Target: every adapter start has a classified declaration
state, and no client name/version is emitted as a model.

**Experiment** — run a resident MCP seat with (a) `MUSTERD_MODEL` set, (b) no model
declaration, and (c) a deliberately changed host model while the process remains live.
Verify that (a) retains the declared model, (b) stays usable but warns and stamps
`unknown`, and (c) does not silently rewrite the attestation from `clientInfo`.
