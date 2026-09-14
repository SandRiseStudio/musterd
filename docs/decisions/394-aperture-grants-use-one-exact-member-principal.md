# 394 — Aperture grants use one exact Member principal

- Status: proposed — 2026-09-14
- Date: 2026-09-14
- Corrects: [ADR 385](385-optional-tailscale-aperture-doctor.md)
- Design: [Aperture-first governed-model generator](../superpowers/specs/2026-09-14-aperture-governed-model-generator-design.md)
- Lane: `01M2GMVH5212TQ0W5M5PNPN1Z2`

## Context

ADR 385 made the optional Aperture doctor accept a grant source containing a shared
`tag:musterd-agent` and one exact `tag:musterd-member-<id>`. Its reference fixture treats the two
entries as a compound identity. The implementation consequently reports that shape ready.

Aperture documents grants as additive and allow-only. A grant's `src` lists the identities to which
the capability applies; matching grants combine. The shared tag is therefore an independent match,
not an additional condition on the exact Member tag. Any workload carrying `tag:musterd-agent` can
match a grant that includes that source.

Current Aperture documentation also defines the capability role as exactly `user` or `admin`. ADR
385's fixture uses `agent`, and the doctor rejects only `admin`, so an absent or unknown role can pass
its identity check.

## Problem

The doctor can report configuration `ready` for a grant that is broader than one Member and for a
role Aperture does not define. Increment 2 would reproduce that unsafe reference shape if the
Increment 1 acceptance rule were left intact.

Correct the readiness claim without narrowing the permissive vendor-input parser, changing the stable
report schema, contacting another endpoint, or implying that Aperture enforcement is active.

## Decision

### 1. A governed workload grant has one source

An Aperture grant qualifies as an exact Member workload grant only when `src` contains exactly one
entry matching lowercase `tag:musterd-member-<id>`. A wildcard, group, human identity, shared tag,
second exact Member tag, or any other second source fails `aperture-identities`.

`tag:musterd-agent` remains a useful network-classification tag outside the managed Aperture grant,
but it is never an Aperture authorization source for a Member policy.

### 2. Ready requires the standard Aperture role

Every qualifying Member grant must contain a capability whose role is exactly `user`. Any role value
other than `user`, including `admin` and the old fixture's `agent`, fails
`aperture-identities`. Capabilities without a role remain legal only when the same grant contains the
required `user` role capability.

The success evidence becomes `one exact Member tag; standard user role`. The repair names the same
two requirements. Check keys, ordering, report version, posture, exit codes, and the statement that
enforcement remains `off` do not change.

### 3. Vendor parsing stays forward-compatible

`ApertureConfigSchema` continues to parse the vendor-owned `role` field as a string and vendor-owned
objects remain passthrough. The doctor, not the external-input parser, decides whether an observed
configuration satisfies musterd's narrow ready posture. This correction therefore changes no protocol
schema.

## Alternatives considered

- **Treat the two sources as an AND-set.** Rejected: that is not Aperture's documented additive grant
  model.
- **Keep the shared tag and add a hook that checks the Member.** Rejected: readiness would depend on
  an unimplemented authorization service, while the grant itself would remain broad.
- **Accept every non-admin role.** Rejected: absence and unknown strings are not evidence of the
  documented standard-user posture.
- **Tighten the vendor Zod schema to `user | admin`.** Rejected: parsing an observed future vendor
  value and judging it not ready is safer than making the whole configuration unreadable. It would
  also create an unnecessary protocol-schema change.

## Consequences

- A configuration using ADR 385's old two-source fixture changes from `ready` to `blocked` until the
  shared source is removed and the role is `user`.
- Increment 2 can render one exact grant per Member without inheriting a broad authorization path.
- The human report and Figma terminal frame change in one line; the version-1 JSON report shape is
  unchanged.
- The doctor remains evidence-only and read-only. It still does not prove launched-Harness coverage or
  active Aperture enforcement.

## Observability & Evaluation

- **Traces.** Existing stable check `aperture-identities` records only a pass/fail detail and repair.
  No tag value, configuration body, credential, or new telemetry field is emitted.
- **Eval.** Hermetic fixtures cover one exact Member source plus role `user` as the positive case;
  shared-plus-exact, shared-only, wildcard, multiple exact sources, missing role, `agent`, and `admin`
  as negative cases. A mutation restoring `src.length === 2` or accepting any non-admin role must make
  at least one focused test fail.
- **Experiment.** None. This is a fail-closed correction to a readiness claim, not a rollout. Before
  Increment 2 activation work, an authorized disposable Aperture instance may confirm that an exact
  Member source passes and a shared source reaches more than one tagged workload; no production or
  shared instance is required for this correction.
