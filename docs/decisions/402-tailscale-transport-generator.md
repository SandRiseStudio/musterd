# 402 — Tailscale transport generator

- Status: proposed — 2026-09-15
- Date: 2026-09-15
- Builds on: [ADR 400](400-aperture-policy-generator.md)
- Design: [Tailscale transport generator](../superpowers/specs/2026-09-15-tailscale-transport-generator-design.md)
- Lane: `01M2KTFCSEQF6P5F762QKDMY46`

## Context

ADR 400 creates a deterministic Aperture policy fragment but deliberately leaves tailnet policy and
runtime node binding out of scope.

## Problem

Operators need reviewable, least-privilege Team transport policy before a later governed launcher can
bind a workload to a live machine, without making a configuration applicator or treating a mutable
daemon node identifier as portable identity.

## Decision

Increment 2b adds a strict committed transport manifest and
`musterd integration generate tailscale [--write | --check]`. It reuses ADR 400 workload IDs and
emits only stable Tailscale tag/ACL policy plus a Member-to-opaque-transport-node-key mapping.

It does not call Tailscale, apply policy, alter daemon bind/Host configuration, discover runtime
nodes, or activate enforcement. The existing Tailscale doctor remains the read-only operational
verifier. Runtime binding between a declared node key and an enrolled node is deferred to Increment 3.

## Consequences

- Increment 2 is explicitly split: 2a is Aperture policy generation; 2b is transport policy generation.
- Tailscale API credentials, device creation, and daemon exposure remain outside generated files.
- The older paved-road delivery table is corrected to reflect the split.

## Observability & Evaluation

**Traces.** Generated output and errors expose no credentials, runtime node IDs, or machine paths.

**Eval.** Dataset: hermetic roster, governed-model, and transport-manifest fixtures. Baseline: no
reviewable mapping from a workload principal to permitted transport nodes. After: strict parsing,
deterministic tags/ACLs, and no-write failure cases prove the bounded generator.

**Experiment.** None. Applying a generated policy or testing live Tailscale infrastructure requires a
separate authorized high-stakes Lane.
