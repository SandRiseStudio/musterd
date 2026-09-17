# 415 — governed auth fail-closed contexts and credential-prefix registry

- Status: proposed — 2026-09-17
- Date: 2026-09-17
- Builds on: [ADR 411](411-governed-model-authorization-substrate.md) and [ADR 405](405-governed-transport-credential-guard-is-prefix-specific.md)
- Lane: `01M2P8WRVZXWQYA80RMKBCXWBJ`

## Context

Outcome review of the merged Increment 3 governed authorization substrate found two fail-closed
gaps. The protocol already carries an `orientation` work-context shape for the future human-created
allowance flow, but the server has no allowance record, issuance route, or lookup. The decision engine
handled `lane` and `act`, then fell through to policy evaluation for `orientation`.

The repository also had three separate credential-prefix detectors. Each recognized only six of the
nine prefixes in the protocol's `TOKEN_PREFIXES` registry, so newly introduced machine and legacy seat
namespaces could pass secret-free manifest/policy guards.

## Problem

An invented `allowance_id` must never authorize a governed model request, and credential-like values
must be rejected consistently whenever a validator inspects a serialized policy or integration
manifest. A future orientation-allowance implementation needs its own durable issuance and lookup
decision; this repair must not invent that missing authority.

## Decision

The server explicitly refuses every `orientation` context in `authorizeGovernedRequest` with the
stable `denied_context_orientation` refusal. The protocol shape remains parseable for forward
compatibility, but Increment 3 has no valid orientation issuance path and therefore cannot authorize
one. A later ADR may add a server-owned allowance record, issuance, expiry, and lookup; until then,
only active Lane and unresolved directed Act contexts can reach an allow decision.

Credential detection is derived from `TOKEN_PREFIXES` through the shared protocol
`isMusterdCredential` helper. The governed policy schema, integration manifest schemas, and CLI
manifest checks all use that helper, preserving case-insensitive prefix matching while covering every
registered namespace, including `mskd_`, `msnode_`, and `msinv_`.

No migration, route, credential format, enforcement default, or launcher behavior changes.

## Consequences

- A persisted or manually constructed orientation launch fails closed rather than becoming an allowed
  model request.
- The current protocol remains forward-compatible without implying that an orientation allowance
  exists today.
- Adding a token kind to `TOKEN_PREFIXES` automatically extends the shared credential guard.
- Existing Lane/Act authorization, unmanaged Team behavior, and `enforcement: off` remain unchanged.
- A future orientation implementation must be separately designed and tested before this refusal is
  relaxed.

## Observability & Evaluation

**Traces.** Orientation refusals are structured decisions with `denied_context_orientation`; audit
details retain only the existing launch, Presence, node, correlation, policy, and refusal metadata. No
allowance identifier is treated as proof, and no credential, prompt, response, or provider payload is
logged.

**Eval.** Dataset: one consumed launch carrying the never-issued `orientation/allowance_id` fixture,
plus each of the nine literal values in `TOKEN_PREFIXES` across protocol and CLI guard tests. Baseline:
the orientation fixture returned `allow`, and `mskd_`, `msnode_`, and `msinv_` values passed at least
one guard. The repaired baseline is a structured orientation denial and rejection of all nine prefixes.

**Experiment.** None — this is a deterministic authorization and validation correction; no live
provider, Aperture, or launcher behavior is exercised.
