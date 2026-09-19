# Aperture-first governed-model generator — Increment 2 design

**Date:** 2026-09-14  
**Status:** approved; implemented as Increment 2a under [ADR 400](../../decisions/400-aperture-policy-generator.md)
**Scope:** shipped design boundary; the generator and doctor comparison remain manual, deterministic, secret-free, and enforcement-off

## 1. Outcome

Increment 2 gives a Team a deterministic, reviewable way to derive the musterd-owned portion of an
Aperture policy from its committed roster and a secret-free governed-model policy. It completes a
manual control loop:

1. generate and review the managed Aperture fragment;
2. commit the generated evidence;
3. merge the fragment into Aperture by hand; and
4. use the existing integration doctor to compare the observed managed policy with the committed
   Team policy.

The increment does not launch a harness through Aperture, activate governed-model enforcement, write
to Aperture, manage provider credentials, or claim that another governance provider is interchangeable.
A successful doctor result continues to mean configuration `ready`; enforcement remains `off`.

## 2. Terminology and command placement

This design reuses musterd's existing terms and command ownership:

- A **Team** owns the governed-model ceiling.
- A **Role** may narrow that ceiling.
- An active agent **Member** receives one resolved workload policy.
- **Presence** remains transient attachment and is never an identity or generator input.
- **Surface**, **Harness**, **Driver**, **Permissions**, **Capability**, and **Act** keep their existing
  meanings; this increment adds no competing meanings for them.

The command belongs under the existing integration family:

```text
musterd integration generate aperture [--write | --check]
```

`generate` means deriving tracked files. It does not mutate an external system. `configure` remains
owned by `harness configure`; `apply` is reserved for a later increment that actually changes an
external system; `integration doctor` remains the single runtime verification command.

## 3. Source-of-truth boundary

Generation is offline and deterministic. Its complete input set is:

```text
.musterd/team.toml
.musterd/seats/*.toml
.musterd/roles/*.toml
.musterd/governed-models.json
```

It never reads daemon state, Presence, environment-specific identity, an Aperture endpoint, or a
provider credential. Live observation belongs to `integration doctor`.

`.musterd/governed-models.json` is strict, versioned JSON parsed through a new
`@musterd/protocol` Zod schema. It defines:

- the Team's exact fully qualified `provider/model` ceiling;
- a shared Team quota;
- an ordered ladder of per-Member quota tiers;
- optional Role narrowing for models and quota tier; and
- one explicit, stable, opaque `workload_id` for every active agent Member.

The manifest is provider-neutral policy intent. It contains no Aperture field names, Tailscale tag
syntax, provider base URLs, credentials, hooks, connectors, exporters, or live observations.

### 3.1 Stable Member workload identity

The committed roster has durable Member names but no immutable identifier available to an offline
generator. The manifest therefore pins each active agent Member to an explicit `workload_id` rather
than deriving identity from its display name. Renaming a Member requires a deliberate mapping edit and
cannot silently transfer or replace the old workload identity.

Every active agent Member has exactly one mapping. Duplicate, missing, or stale mappings fail
generation. A human Member cannot carry a workload mapping. The generator never invents an identifier
during preview, `--write`, or `--check`.

## 4. Policy composition

### 4.1 Models

The Team ceiling contains exact fully qualified model identifiers such as
`anthropic/claude-sonnet-4-6`. Globs, aliases, bare model names, and floating names such as `latest`
are invalid. This prevents an upstream catalog change from silently widening access.

A Role may only narrow the Team ceiling. For a Member holding multiple Roles, the effective model set
is the intersection of the Team ceiling and every held Role ceiling. An attempted widening or an empty
effective intersection fails generation.

### 4.2 Quotas

Every governed request consumes both:

- one shared Team quota; and
- one independent per-Member quota.

Quotas are dollar-denominated token buckets with a capacity, refill rate, and mandatory pre-spend
rejection. Token-count quotas, request-count quotas, overdraft chains, and emergency exceptions are
outside this increment.

Per-Member quota tiers form an explicit strictness ladder. A Role may select only a stricter tier. For
a Member holding multiple Roles, the strictest selected tier wins. Unknown, unordered, crossing, or
otherwise incomparable tiers fail generation. Holding another Role can never widen either model access
or spend authority.

### 4.3 No Member exceptions

There are no Member-specific model or quota exceptions. A Member inherits the resolved intersection of
Team and Role policy. The Member mapping supplies identity, not a private policy escape hatch.

## 5. Managed output

`--write` atomically replaces exactly two tracked files:

```text
.musterd/generated/aperture/
├── policy.hujson
└── members.json
```

Both files are stable under lexical ordering and contain no timestamps, machine paths, environment
values, Presence, or secrets.

### 5.1 `policy.hujson`

The managed fragment contains only:

- one exact grant per active agent Member;
- the shared Team quota and concrete per-Member quota buckets; and
- the required zero-retention posture.

Each grant has one source: `tag:musterd-member-<workload_id>`. It receives Aperture role `user`, one
capability per exact effective model, and references to both applicable quota buckets. Bucket names are
derived from stable identifiers rather than Member display names.

Zero retention requires duration `0`, purge of captures and tools, and `require_export: false`.

The fragment never contains provider definitions or credentials, admin grants, broad sources, hooks,
connectors, exporters, or unrelated Aperture settings. Operators review and merge the fragment into
their complete configuration. A later write increment must use Aperture's configuration hash to
read/merge/write while preserving unmanaged sections.

### 5.2 `members.json`

The mapping file covers every committed Member so its name does not imply incomplete roster coverage.
Each entry records Member name, kind, lifecycle-derived governed-model scope, and the reason for being
in or out of scope.

An active agent Member is `in_scope` and records its `workload_id`, exact rendered principal, held
Roles, effective models, and quota bucket names. Human Members are `out_of_scope` with reason
`human_member` and have no principal or grant. Inactive agent Members are `out_of_scope` with their
lifecycle reason and likewise generate no grant.

## 6. Renderer boundary

The generator first resolves roster plus manifest into one internal effective-policy model. A pure,
built-in Aperture renderer turns that model into the two files above. Tailscale tag syntax and Aperture
configuration syntax exist only in this renderer.

Increment 2 does not introduce a renderer registry, dynamically loaded provider integration, plugin
contract, or public interchangeability promise. The effective-policy boundary keeps provider-specific
syntax out of Team intent. A second governance provider must supply evidence of its real differences
before musterd extracts a formal multi-renderer interface.

## 7. Command behavior and validation

The three modes share the same parse, validation, resolution, rendering, and secret-safety path:

- Default mode generates in memory and displays a deterministic diff.
- `--write` atomically replaces both generated files.
- `--check` writes nothing and succeeds only when both committed files are byte-current.
- `--write` and `--check` are mutually exclusive.

Identical output reports `Aperture policy is current`. Missing output appears as a complete addition in
preview mode.

Generation fails before output when:

- a Team, seat, Role, or manifest input is invalid;
- Member mappings are missing, duplicate, stale, or attached to a human Member;
- a referenced Role or quota tier is unknown;
- a Role attempts to widen the Team ceiling;
- multi-Role composition yields no model;
- a model identifier is not exact and fully qualified;
- quota tiers are unordered or not monotonically stricter;
- source or generated data resembles a credential; or
- rendered policy would contain a wildcard or broad source, admin access, non-rejecting quota, or
  content retention.

All collections use stable lexical ordering. Object-key order, roster traversal order, and manifest
authoring order cannot affect generated bytes.

## 8. Doctor comparison

`integration doctor --aperture <https-url>` remains read-only.

When no governed-model manifest exists, it retains Increment 1's generic readiness checks. When the
manifest exists, the doctor first verifies that generated output is current, then compares the
musterd-managed portion of observed Aperture configuration against it.

The comparison requires:

- one exact `user` grant per in-scope Member;
- the exact effective model set and both applicable quota buckets;
- matching managed quota definitions and zero-retention posture; and
- every permitted exact model to exist in the operator-owned provider catalog.

It rejects missing, duplicate, widened, wildcard, shared-tag, multi-source, or admin grants affecting
governed Members. It permits unrelated exact human grants and operator-owned providers, and ignores
unrelated hooks, connectors, exporters, and credential fields. It never prints complete configuration
or credential-bearing values.

Failure remains actionable and bounded:

- stale local generation points to `integration generate aperture --write`;
- invalid local policy blocks external readiness comparison;
- observed drift names the affected Member or managed section; and
- an exact match reports configuration `ready`, never enforcement `required`.

## 9. Prerequisite correction and ADR order

Design work uncovered a correctness error in Increment 1's accepted reference shape. Aperture grant
sources are additive identities, not an AND-set of tags. A grant containing both the shared
`tag:musterd-agent` and an exact Member tag can therefore admit every workload carrying the shared tag.
Current fixtures also use Aperture role `agent`, while current Aperture configuration accepts `user` or
`admin`.

Implementation proceeded in two ordered lanes:

1. **Increment 1 correction.** Write an ADR, require the exact Member tag as the sole source, require
   Aperture role `user`, and make the doctor reject a shared tag or any second/broad source. Land this
   correction before generator work.
2. **Increment 2 generator.** Write a separate ADR for the versioned protocol schema, generator,
   managed-fragment boundary, and exact doctor comparison. Then write the implementation plan.

The correction is not folded invisibly into generator work, and the new protocol schema is not added
without its own ADR decision.

## 10. Acceptance

The implementation must provide:

- strict protocol-schema tests for every manifest boundary;
- golden tests for both generated files;
- determinism tests across reordered files, Roles, models, and JSON keys;
- restrictive multi-Role model and quota composition tests;
- missing, duplicate, stale, human, and inactive Member mapping tests;
- exact-model and monotonic-quota validation tests;
- secret-like input and output rejection tests;
- atomic-write failure tests;
- preview, `--write`, `--check`, and mutual-exclusion CLI tests;
- doctor tests for exact match, stale generation, missing or widened grants, quota drift, provider
  mismatch, and preservation of unrelated configuration; and
- terminal snapshots plus an approved Figma terminal frame for the new CLI output.

Affected architecture, security, CLI, and paved-road documentation changes land with behavior changes.
The implementation adds no runtime dependency. Completion requires the repository's normal fast local
gates and authoritative CI workflow.

Acceptance means the tracked output is deterministic, contains no secrets, has no broad identity path,
and can be compared exactly with observed Aperture policy without changing Aperture or claiming active
enforcement.
