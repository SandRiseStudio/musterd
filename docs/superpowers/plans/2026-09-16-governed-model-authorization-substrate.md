# Increment 3 — governed model authorization substrate

## Goal

Implement the protocol/server substrate from [ADR 411](../../decisions/411-governed-model-authorization-substrate.md).
The Team remains `off` by default. This increment does not launch Claude Code or Codex, apply
Tailscale/Aperture configuration, or activate `required` enforcement.

## Implementation sequence

1. Extend `@musterd/protocol` with a strict, versioned governed-policy and authorization contract.
   Define the `off|required` enforcement mode, one-shot launch authorization lifecycle, work-context
   union, Presence attestation, decision request/response, and stable refusal codes. Export it from the
   protocol index and pin the wire version. Reject unknown fields and credential-like values at parse
   boundaries; keep audit action strings forward-compatible.

2. Add the next forward-only server migration. Store the server-owned governed policy and launch
   authorizations separately from seat-claim grants. Store only credential hashes. Include exact Team,
   target Member, enrolled node, work context, launch correlation, issue/expiry, consumed, revoked, and
   audit metadata. Add indexes for Team, credential hash, target Member, and correlation. Preserve
   migration rewind/idempotence conventions.

3. Add a server store module with guarded operations for policy replacement, authorization issuance,
   authentication, one-shot consumption, revocation, and deterministic decision evaluation. Reuse
   `seat_nodes` for Member↔node residence; agents must have one bound node. Require the target to be an
   active agent Member and the issuer to be an authenticated human Member or admin. Never derive
   authority from caller-supplied Member names.

4. Add parsed HTTP routes for policy synchronization, human-started authorization issuance,
   authorization consumption, revocation, and the Aperture decision endpoint. Authenticate the
   Aperture route with both the enrolled node credential and launch credential. Resolve identity from
   server state, cross-check assertions, evaluate identity/launch/context/policy independently, and
   return structured refusal results without leaking which secret check was close.

5. Add protocol and server tests before each implementation slice. Cover strict schemas, policy
   narrowing, one-shot replay, expiry, revocation, wrong Member/node/correlation, Lane/Act contexts
   plus the fail-closed orientation refusal, `off` behavior, refusal determinism, secret-free audit data, HTTP body parsing, and
   transaction races. Run the protocol package gate, then the server package gate, then repository
   typecheck/format checks.

6. Update the implementation-facing architecture and security docs only for the behavior that lands,
   linking back to ADR 411. Keep the existing Increment 2 generator docs unchanged except for links
   needed to describe the new runtime-binding seam.

## Completion criteria

- `pnpm --filter @musterd/protocol test` passes with the protocol coverage target.
- `pnpm --filter @musterd/server test` passes with the server acceptance target.
- `pnpm typecheck && pnpm format:check` passes.
- No credential, prompt, response, provider payload, or machine-local secret is stored or logged.
- Existing unmanaged Team and Presence paths remain behaviorally unchanged with enforcement `off`.
