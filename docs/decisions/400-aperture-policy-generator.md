# 400 — Aperture policy generator

- Status: proposed — 2026-09-15
- Date: 2026-09-15
- Builds on: [ADR 385](385-optional-tailscale-aperture-doctor.md) and [ADR 394](394-aperture-grants-use-one-exact-member-principal.md)
- Design: [Aperture-first governed-model generator](../superpowers/specs/2026-09-14-aperture-governed-model-generator-design.md)
- Lane: `01M2KN20VE4M8VFSMPKDA3CWGM`

## Context

The read-only Aperture doctor can prove a generic safe configuration, but it cannot derive
the Member grants, exact models, or spend buckets from a committed Team roster. Operators
therefore have no deterministic, reviewable managed fragment to merge manually or compare
against a live configuration.

## Problem

Add the second paved-road increment without giving musterd ownership of Aperture's external
configuration, provider credentials, transport provisioning, or model request routing.

## Decision

`musterd integration generate aperture [--write | --check]` reads only the committed roster and
a strict, versioned `.musterd/governed-models.json`. The manifest expresses provider-neutral
Team ceilings, Role narrowing, quota tiers, and an explicit opaque workload ID for each active
agent Member.

The CLI resolves those inputs into a deterministic effective-policy model. The built-in
Aperture renderer is the only component that knows Aperture grant, tag, quota, and HuJSON
syntax; no renderer registry or provider-interchangeability promise is introduced.

`--write` atomically replaces exactly `.musterd/generated/aperture/policy.hujson` and
`members.json`. Default mode shows the deterministic result without writing, and `--check`
requires both tracked files to be byte-current. Invalid mappings, policy widening, unordered
tiers, broad identifiers, and Musterd-credential-prefixed source or rendered output fail before a
write (the shared guard semantics are recorded in [ADR 405](405-governed-transport-credential-guard-is-prefix-specific.md)).

When the manifest exists, `integration doctor --aperture` requires current generated output and
compares only musterd-managed grants, models, buckets, and zero-retention posture. Unmanaged
providers and configuration remain operator-owned. A match reports configuration `ready`, never
active enforcement.

## Consequences

- Generation is offline, secret-free, reproducible, and safe to review in source control.
- A Role can only narrow models and select a stricter quota tier; a Member receives no private
  exception.
- Aperture remains a manual-merge, read-only inspected integration in this increment.
- Tailscale provisioning, runtime routing/enforcement, and external configuration application
  require later decisions.

## Observability & Evaluation

**Traces.** The generator emits no credentials, source configuration, timestamps, or machine paths.
The doctor exposes only the affected Member or managed section and its manual repair.

**Eval.** Dataset: hermetic roster/manifest fixtures and observed Aperture configurations. Baseline:
the generic doctor cannot prove a Team's reviewed ceiling matches live grants. After: schema,
restrictive composition, deterministic bytes, preview/write/check, and managed drift tests assert
the committed fragment is the sole musterd-owned comparison target.

**Experiment.** None. A passing doctor proves only configuration readiness; it neither attests a
launched Surface nor enforces a request.
