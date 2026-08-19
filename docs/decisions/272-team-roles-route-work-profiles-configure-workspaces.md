# 272 — Team roles route work; profiles configure workspaces

- **Status:** proposed — **revised 2026-08-19**, narrowed before acceptance (see the revision
  record at the end of Context). The original 2026-08-14 scope is in git history at PR #851.
- **Date:** 2026-08-14; revised 2026-08-19
- **Owner:** gptbot (decision session with nick); revision: stanley (challenge answered by the
  owner, endorsed by nick in session)
- **Supersedes / relates to:** ADR 026–030 (the existing provisioning-template
  seam), ADR 101 (model observation), ADR 131 (residency), ADR 145 (human-only
  admin), ADR 227 (roles as aptitude — whose measured reopening gate this revision restores),
  ADR 254 (eligible sets — the rail role sends ride if they ever proceed), ADR 261 (role
  permission profiles — the naming collision reconciled in §3), ADR 093 (seat memory — why the
  seat, not the role, carries continuity)

## Context

musterd currently has two things called a role. The durable team library,
`roles/<name>.toml`, supplies charter and narrow-only capability defaults; ADR
227 made those roles multi-holder, discoverable, and warn-only infra ownership.
Separately, the CLI's JSON *role templates* provision harness-local MCP entries,
permissions, and guidance. The latter still records that it needs a
model-aware re-freeze against ADR 101.

That ambiguity is real and worth fixing: a team duty was tangled up with one
machine's local setup. A checkout-local provisioning file must never be the
authority that decides who is responsible for an incoming act, and a team's
responsibility must not become an attribute of a particular harness or model.

**Revision record, 2026-08-19.** The original ADR went further: it reopened ADR
227's deliberately deferred role-addressed sends and specified a four-level role
registry, Git reconciliation, and an ordered routing resolver. ADR 227 had
pre-registered a *measured* reopening trigger for exactly that deferral (the
role-filtered-discovery→directed-send join, "firing repeatedly"), and the
original text reopened it citing the re-evaluation session, not the
measurement. The second ADR 227 measurement (2026-08-19, PR #912) then showed
the trigger had vacuously never fired — zero `roster.role_query` rows have ever
been written — and stanley's challenge asked the owner for evidence or a
revision; the owner conceded the full scope was unevidenced and supported the
narrowed shape below, which nick endorsed in session. This revision is that
narrowed shape. The lesson stands on its own: a pre-registered gate is either
run or explicitly overridden — it is not cited as having fired when it has not.

## Problem

1. What is a role's canonical, harness-independent identity and scope?
2. Where do permissions, tool access, and placement each live, and which of the
   concepts — agent, role, profile — is required as opposed to optional?
3. Under what evidence does role routing (and the machinery it needs) get built?

## Decision

### 1. One required entity, two optional attachments — not a hierarchy

The **seat** (the agent: a durable, addressable identity per the ontology doc)
is the only required entity. Everything load-bearing already attaches to it:
attribution, model attestation, audit, memory (ADR 093 — the seat, never the
occupant, and never a role: role-shaped knowledge is the charter and the wiki,
per ADR 259), capabilities, lane ownership.

A **role** is an optional team-side attachment: a harness-independent
responsibility — charter, one-line summary, narrow-only capability defaults,
approved holders (all per ADR 227, which remains the durable role layer). A
role does not mean "the Codex role" or "the Claude role"; `platform` means the
same responsibility regardless of the holder's harness or model. Role identity
is team-scoped; a project role is scoped to one named project.

A **workspace provisioning profile** is an optional workspace-side attachment:
it renders local setup — harness entries, permission defaults, guidance, tools
— for a particular checkout and Surface. A profile is configuration, not an
identity-adjacent entity: it **neither grants nor removes a role**, carries no
team authority, and nothing routes on it. A role may recommend a profile.

Neither attachment sits "above" or "below" the other; they live in different
domains (team governance vs local workspace), and nothing local ever creates a
team fact.

### 2. The three access questions live in three places

- **What a seat MAY do** is a governance fact: seat-attached capability grants,
  enforced by the daemon, with roles supplying narrow-only defaults (ADR
  069/070/227 — all shipped; nothing new here).
- **What a session CAN do here** (installed MCP servers, available tools) is a
  workspace fact: rendered by a profile, observed as health, never authority.
- **WHERE a seat can run** is residency (ADR 131) — observed occupancy and
  authenticated wake paths. A role declaration alone never asserts
  reachability.

### 3. Vocabulary: "profile" reconciled with ADR 261

Unqualified, **profile** means the workspace provisioning profile of §1. ADR
261's *role permission profiles* are a different thing — team-side permission
bounds (floor/ceiling) that provisioning *compiles into* local enforcement.
The source of truth for those bounds is the team layer; the local rendering is
one output of a provisioning profile. Where prose must distinguish them, say
"permission bounds (ADR 261)" vs "provisioning profile."

### 4. The buildable increment: migrate templates to profiles

The existing JSON role-template implementation (ADR 026–030) migrates to the
profile vocabulary and boundary: same additive, reversible, non-obligating
provisioning rules, renamed and re-documented so no template reads as a role.
This replaces the earlier, unspecific call to make a template model-aware.
This is the only implementation this ADR authorizes now.

### 5. Deferred, behind restored gates: registry, reconciliation, routing

The four-level role registry (built-in/personal/team/project promotion), Git
reconciliation of live role state, role-addressed sends, and the ordered
routing resolver are **deferred, not decided against**. They reopen when either
named trigger fires:

- **ADR 227's measured trigger, restored as the gate:** the role-filtered
  discovery→directed-send join firing repeatedly on real seats — the pair a
  role-addressed send would collapse to one.
- **Multi-holder demand:** a role with more than one live holder where the
  holder-pick is repeatedly contested or re-derived by hand (the same
  build-on-evidence pattern, at the routing layer).

When role sends do proceed, the first increment resolves the role to its
current holders and delivers on the **ADR 254 eligible-set rail** — named
seats, any one discharges, accountability preserved — rather than building a
parallel resolver. Ordered primary/alternate policy, wake-integrated routing,
and registry machinery come only after that increment shows a demonstrated
need. Two commitments from the original text survive as constraints on any
future routing build: the final act always records the selected named seat and
reason, and durable team-role assignment and policy changes require a human
admin (ADR 145).

## Consequences

- ADR 227 remains the durable role layer, and its measured reopening trigger is
  back in force — the original ADR 272's session-fiat reopening is withdrawn.
- The profiles migration (§4) proceeds as the goal's one open implementation
  lane. The registry, routes, and route-ledger dogfood lanes opened against the
  original scope are closed as premature; their content is recoverable from
  this ADR's history if a trigger fires.
- The `role-routing-profiles` roadmap item narrows to match: profiles migration
  now, routing deferred behind the named triggers.
- ADR 261's permission bounds keep their own arc; only the word "profile" is
  disambiguated here.

## Observability & Evaluation

**Traces.** Nothing new. The signals that decide the deferral are ADR 227's:
`roster.role_query` audit rows and the discovery→send join, plus ordinary
directed-send telemetry for the multi-holder condition. Profile application
remains local provisioning health, never a team-authority event.

**Eval.** Success for §4 is a completed migration with zero behavior change:
every existing template renders identically as a profile, and no roster or
routing read depends on any profile. The reopening decision reads the ADR 227
join (falsifier: the SQL recorded in ADR 227's eval section) and the
holder-pick evidence; either firing reopens §5 with its own go/no-go.

**Experiment.** None for §4 beyond the migration's own round-trip (a template
rendered before and after must produce the same workspace). The routing
experiment from the original text — ordinary work through a role route across
machines and harnesses, every result attributable to a named seat — is
deferred with the feature it would validate.
