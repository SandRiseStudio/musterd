# 298 — `role create` authors the durable role library

- Status: accepted
- Date: 2026-08-21
- Deciders: nick (deliberate call, in-session), stanley (carried)
- Relates to: ADR 227 (the durable role layer this authors into), ADR 272 §5 (the registry
  deferral this stays adjacent to, not inside), ADR 058 (the file is the single writer), ADR 296
  (owns the profile→toolkit rename this ADR deliberately does not touch), lane 01M017ADRK (the
  abandoned registry lane whose narrowest content this reopens)

## Context

ADR 227 shipped team roles as durable files (`roles/<name>.toml`), and ADR 272 hardened the
boundary: roles are the roster's, profiles are workspace provisioning, and §5 deferred the
four-level registry, git reconciliation of live role state, role-addressed sends, and the routing
resolver behind two measured triggers. The lane that carried the original registry scope
(01M017ADRK) was closed as premature.

What that close-out left behind is an authoring gap, visible the day the roster reconnected
(2026-08-21, Sloane increment 0): `role list`, `show`, and `assign` are roster-first, but `role
create` — the verb whose name promises a role — writes a workspace **profile** JSON, even when run
in a roster home. Creating the `product-communications` role for the sloane seat meant hand-writing
TOML against the zod schema. The library every other subcommand reads and validates against had no
writer but a text editor.

## Decision

**In a roster home, `musterd role create <name>` authors `.musterd/roles/<name>.toml`** —
canonical from birth via `serializeRole`, skeleton by default, or instantiated from a small set of
**built-in role templates** (`--from <template>`: admin, platform, designer, steward, observer,
product-communications). Templates carry capabilities only where they are structural to the role
(admin's `is_admin`, observer's muted acts); charters are generic seeds a team edits. The file is
the single writer (ADR 058): the command points at `role assign` and the commit, and the daemon
projects on merge exactly as with a hand-written file.

Outside a roster home nothing changes, and `--profile` keeps the legacy profile scaffold reachable
inside one. The profile path's rename to `toolkit` is ADR 296's enforcement build, not this
change's — this ADR leaves that seam exactly where it found it.

### What this is not, said plainly

This reopens the **narrowest content** of lane 01M017ADRK — built-in seeds plus team custom roles
as an authoring affordance — on **nick's deliberate call**, not because an ADR 272 §5 trigger
fired. Neither trigger has fired; the §5 deferral is untouched and this ADR does not weaken it:

- No role-addressed sends, no routing resolver, no holder-pick policy.
- No four-level promotion (personal/project levels do not exist; a template instantiates into a
  team role and the built-ins are code, not a registry).
- No new reconciliation — the daemon's ADR 058 reconcile of role files is unchanged.

Recording the provenance honestly is the point: a §5-adjacent affordance landed by fiat is fine
when the record says so; the failure mode would be this ADR citing a trigger that never fired.

## Consequences

- Creating a team role is one command instead of schema archaeology; typo-guarded `assign` and the
  reconcile warning for unknown role names now have a matching writer.
- `role create` means two different writes depending on where it runs. That asymmetry is
  deliberate and temporary: the ADR 296 build renames the profile half to `toolkit create`, at
  which point `role create` has one meaning — this ADR's.
- The built-in template set is code (`packages/cli/src/roster-roles/templates.ts`); growing it is
  a PR, not a registry operation.

## Observability & Evaluation

**Traces.** Nothing new — role creation is a local file write; the daemon's existing reconcile
logging is the projection signal, unchanged.

**Eval.** Dataset: the `role create in a roster home` block in
`packages/cli/src/commands/role.test.ts` (7 cases, written red-first). Baseline: pre-change,
`role create` in a roster home writes a profile JSON and no `roles/*.toml` (pinned by the
`--profile` escape-hatch case). Success: every written file round-trips through `parseRoleFile`
and reconcile accepts it unmodified. The falsifier for the scope claim is any diff in this change
touching send routing, holder resolution, or the reconcile path — there is none.

**Experiment.** n/a — an authoring affordance with no behavioral hypothesis to test in production;
the §5 reopening decision stays with ADR 272's measured triggers, which this ADR does not read or
alter.
