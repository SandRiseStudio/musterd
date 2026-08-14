# 272 — Team roles route work; profiles configure workspaces

- **Status:** proposed
- **Date:** 2026-08-14
- **Owner:** gptbot (decision session with nick)
- **Supersedes / relates to:** ADR 026–030 (the existing provisioning-template
  seam), ADR 101 (model observation), ADR 131 (residency), ADR 145 (human-only
  admin), ADR 227 (roles as aptitude), ADR 254 (eligible sets)

## Context

musterd currently has two things called a role. The durable team library,
`roles/<name>.toml`, supplies charter and narrow-only capability defaults; ADR
227 made those roles multi-holder, discoverable, and warn-only infra ownership.
Separately, the CLI's JSON *role templates* provision harness-local MCP entries,
permissions, and guidance. The latter still records that it needs a
model-aware re-freeze against ADR 101.

That ambiguity is tolerable in one repository on one machine, but does not
describe a team at the intended scale: one person may belong to several teams;
one team may span people and agents, projects, machines, and networks. A
checkout-local provisioning file cannot be the authority that decides who is
responsible for an incoming act. Conversely, a team's responsibility must not
become an attribute of a particular harness or model.

The role-design session for ADR 227 intentionally deferred role-addressed sends
until dogfood showed the repeated query-then-send pattern. The broader
re-evaluation now supplies that direction: route to an explicit, accountable
role policy, while preserving the concrete seat selected at every hop.

## Problem

1. What is a role's canonical, harness-independent identity and scope?
2. How do built-in, personal, team, and project roles become usable without
   silently granting team authority?
3. Where does live routing authority live when a team is distributed?
4. How does routing preserve the named-seat accountability that ADR 227
   deliberately retained?

## Decision

### 1. A role is a team responsibility; a profile is local setup

A **role** is a harness-independent responsibility: its charter,
narrow-only capability defaults, approved holders, and routing policy. A role
does not mean "the Codex role" or "the Claude role." `platform`, for example,
means the same responsibility regardless of the holder's Surface.

A **workspace provisioning profile** is separate. It renders optional,
project/workspace-local setup — harness entries, permission defaults, guidance,
and tools — for a particular Surface. A role may recommend a profile, but a
profile neither grants nor removes a role, and routing never depends on it.
The existing JSON role-template implementation migrates to this vocabulary and
boundary; ADR 026's additive, reversible, non-obligating provisioning rules
remain unchanged.

Role identity is team-scoped by default. A project role is scoped to one named
project within that team; it is routable only in that project context. Names
are therefore not global identity or authority.

### 2. The role library has four promotion levels

- **Built-in roles** ship in the musterd registry and are usable immediately,
  without an adoption ceremony. They provide supported definitions and may be
  selected for local provisioning, but do not acquire holders or a live routing
  policy merely by existing.
- **Personal roles** are private drafts. Their author may use their local
  profile, but they are not visible as team responsibility and cannot receive
  role-routed acts.
- **Team and project roles** are durable shared revisions. Publishing a
  personal draft creates a proposal containing the whole revision: charter,
  scope, capability defaults, routing policy, and any linked profiles. A human
  admin must approve that proposal before it becomes shared or routable.
- **Every durable team-role assignment and routing-policy change requires a
  human admin.** A member cannot self-assign an accountable team role.

Built-in revisions are pinned when a team uses them. A musterd upgrade may make
a newer built-in definition available, but cannot silently change a live
team's charter, policy, capabilities, or routing; a human admin explicitly
accepts the reviewed revision.

### 3. The daemon is authoritative for live team routing

The daemon owns the reconciled, current team role registry, approved
assignments, routing policies, live availability, wakeability, and the audit
trail. Git remains the portable, reviewable declaration/export, not a
checkout-local source of truth for a live distributed decision. Reconciliation
must make disagreement visible rather than silently choosing one machine's
copy.

### 4. Role routes resolve by explicit ordered policy

A routed act names a team or project role. The daemon resolves it in this
order:

1. the configured primary, when active and available;
2. ordered alternates that are active and available;
3. ordered alternates that are wakeable through a current, authenticated
   residency/actuator path;
4. a durable `no eligible holder` result.

The final act always records the selected named seat and the selection reason.
A wake is recorded as a routing action. The no-holder result names the role and
why every candidate was ineligible. A remote seat is wakeable only when that
specific seat has a current authenticated wake path; a role declaration alone
never asserts cross-network reachability.

This is role routing, not anonymous delegation. A named seat can still accept,
decline, or hand off the work.

### 5. Do not add profile-qualified routing yet

Model and harness observation remain useful roster facts, and profiles remain
health-checked local setup. They do not gate assignment or routing. Likewise,
do not add task requirements, arbitrary capability tags, or a separate
"compatible holder" resolver in this increment. The first dogfood route should
answer the ordinary question — who is responsible and reachable? — before
adding machinery for a demonstrated environment mismatch.

## Consequences

- ADR 227's role model remains the durable responsibility layer, but its
  deferred role-addressed-send trigger is now intentionally reopened by this
  ADR's explicit policy design.
- ADR 026–030's template format and manifest remain the migration substrate,
  but no longer define what a role *is*. Their runtime artifacts become
  workspace provisioning profiles.
- This requires protocol/server work for role addresses, approved role
  revisions, routing outcomes, and audit; CLI/MCP work for administration and
  ordinary use; and a migration that preserves current local templates.
- Built-in roles add no privileged musterd agents. They are definitions only;
  named holders remain ordinary team seats.
- Project scope, multi-team membership, and remote wake behavior are designed
  at the team boundary now, rather than patched around a local checkout later.

## Observability & Evaluation

**Traces.** Record each role-route attempt with the requested role, policy
revision, candidate sequence, selected seat or no-holder reason, and whether a
wake was attempted and settled. Record approval, assignment, policy, and
profile reconciliation revisions separately, so local setup never reads as a
team-authority change.

**Eval.** Dataset: the routed-act ledger, approval/audit rows, and residency
ledger for the first distributed-team dogfood window. Baseline: the present
query-then-send pattern for an equivalent responsibility. Compare direct
primary delivery, alternate delivery, wake success, no-holder rate, holder
decline/handoff, and time-to-accepted outcome. Re-evaluate profile-qualified
routing only when the data shows a repeated route to an accountable, reachable
holder that fails for a known, machine-readable workspace constraint.

**Experiment.** Run ordinary work through the role route across different
machines and harnesses. The decision holds only when every result remains
attributable to a named seat; it fails if a route hides its selected holder,
treats a stale remote declaration as wakeability, or lets a local profile
silently confer team authority.
