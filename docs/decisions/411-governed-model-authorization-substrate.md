# 411 — governed model authorization substrate

- Status: proposed — 2026-09-16
- Date: 2026-09-16
- Builds on: [ADR 385](385-optional-tailscale-aperture-doctor.md), [ADR 394](394-aperture-grants-use-one-exact-member-principal.md), and [ADR 402](402-tailscale-transport-generator.md)
- Design: [Tailscale + Aperture paved road](../superpowers/specs/2026-09-02-tailscale-aperture-paved-road-design.md)
- Lane: `01M2P8WRVZXWQYA80RMKBCXWBJ`

## Context

Increment 2 produces reviewable Aperture policy and Tailscale transport artifacts, but it does not
prove that a live workload is the Member and machine node named by those artifacts. A governed model
request therefore still has no musterd-owned authorization boundary for launch provenance, work
context, or policy composition.

The paved-road design defines four independent checks: identity, launch, work context, and policy. It
also requires that a Member-to-node binding be durable, that launch authorization be distinct from a
client session id, and that a governed request fail closed without retaining prompt or response bodies.
The first implementation slice is the protocol/server substrate. Claude Code and Codex process
launchers, Aperture deployment, and activation of required enforcement are later slices.

## Problem

Introduce the authorization contract without silently activating enforcement, trusting caller-supplied
Member identity, reusing ordinary seat-claim grants for model access, or making the daemon read a
caller workspace to decide a request.

## Decision

Increment 3 adds a strict, versioned governed authorization protocol and server implementation. The
Team policy is server-owned and secret-free; a later sync command imports the committed
`.musterd/governed-models.json` policy. Runtime authorization never reads a caller's filesystem.

The policy includes an explicit `enforcement` mode, `off` by default. `off` means unmanaged Presence
remains valid and no Team-wide claim is made. The authorization route is nevertheless available for an
explicit governed launch, so the substrate can be exercised before a Team opts into required
enforcement. A policy may record `required` for forward configuration, but no route in this increment
activates required enforcement.

Durable Member-to-machine-node residence reuses `seat_nodes`. The existing seat-claim `grants` table
is not overloaded. A separate launch-authorization record is persisted with a hash of its opaque
credential, exact Team/Member/node binding, one work-context binding, launch correlation, issue and
expiry times, and consumed/revoked state. The plaintext credential is returned once, never logged, and
never stored. It is a one-shot handoff consumed by the matching governed Presence; a client session id
alone is not proof.

Only an authenticated human Member or admin may issue a governed launch authorization for an active
agent Member whose node binding is already present. Agents cannot issue or widen an authorization. The
issuer is recorded as audit metadata, while the authorization itself is evaluated against the target
Member's identity and policy.

The server exposes parsed routes for policy synchronization, human-started launch issuance, one-shot
consumption, revocation, and Aperture authorization. The Aperture-facing decision requires both the
enrolled `msnode_` credential and the previously consumed launch authorization. The server resolves the
Member and node from stored bindings, cross-checks any caller assertions, and refuses mismatches.

The decision engine evaluates all four checks independently. In this increment, the orientation
context shape is retained for forward compatibility, but its allowance authority is not implemented;
the server refuses that context rather than treating an unverified identifier as proof:

1. enrolled, active node identity and exact Member-to-node binding;
2. live, unexpired, unrevoked launch authorization with matching Presence correlation;
3. an active owned Lane or an unresolved directed Act bounded by its resolution/expiry; orientation
   contexts receive `denied_context_orientation` until a later ADR adds a server-owned allowance; and
4. the server-owned Team model ceiling plus narrower Role/Member policy, with no caller-side widening.

Decisions return stable allow/refusal results and append metadata-only audit rows. Refusal details name
the failed category and safe remediation, never credentials, prompts, responses, or provider payloads.

## Consequences

- The later Claude Code and Codex launchers have one server-owned contract for minting and redeeming a
  governed launch.
- Replay, expiry, revocation, cross-node use, and Member confusion are rejected by durable state and
  guarded writes rather than adapter convention.
- The server can make a policy decision without trusting a workspace file or an unverified caller
  identity.
- Existing unmanaged teams and Presence behavior remain unchanged while the mode is `off`.
- A schema version, migration, policy-sync surface, launcher adapters, and future `required` cutover
  must be kept compatible with existing daemons and clients.
- Live Tailscale/Aperture testing and applying external configuration require a separate authorized
  high-stakes Lane.

## Observability & Evaluation

**Traces.** Audit records include decision category, target Member, node id, launch id, correlation,
requested provider/model, policy version, and refusal code. They exclude all secret-like values and
request/response bodies. Launch credentials and node credentials are hash-only at rest.

**Eval.** Protocol tests cover strict parsing, round trips, version pinning, refusal vocabulary, and
secret-like input/output rejection. Server tests cover migration idempotence, guarded one-shot
consumption, expiry/revocation, Member/node mismatch, each work-context branch, restrictive policy
composition, audit metadata, and HTTP boundary parsing. The substrate is accepted only when the
protocol and server package gates pass; a live governed launcher remains a later acceptance.

**Experiment.** None in this increment. A passing server decision proves authorization semantics, not
that a live Aperture deployment or harness process has been configured.
