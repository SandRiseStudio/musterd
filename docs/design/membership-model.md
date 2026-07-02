# Membership, Identity, Seats & Presence — design proposal (v0.3 target)

> **Status: SHIPPED (v0.3 P0–P3, ADRs 069–077).** This is the full **shared-teams governance** model (seats, agent key + grants, capabilities, request/approval lane, audit) — and it landed on `main`: seats/roles/capabilities (P0/P1), in-band enforcement + audit (P2, ADR 071), and the breaking agent-key + grant + credential cutover with the `claim` handshake and the request/approval lane (P3, ADR 077, 2026-06-30). Only P4 (credentialed remote join over the secured off-loopback bind) remains of the epic. The body below is the design as built; the historical v0.2 minimal down-payment (per-member tokens, explicit activation, single-active + grace) is in `docs/archive/membership-impl-plan.md` + ADR 007. Companion: `spec-v0.3-draft.md`, `security.md`, SPEC Appendix A.

> **Living document.** Found an error or better approach? Record it in `docs/decisions/NNN-<slug>.md`, make the smallest correct change, update this doc in the same commit.

Companion docs: `spec-v0.3-draft.md` (protocol), `docs/archive/membership-impl-plan.md` (the **v0.2** build), `security.md` (threat model). Glossary lives in `brand.md` §5; this proposal **adds** the terms **Role**, **Seat**, **Grant**.

## Why

The v0.1 adapter auto-joins every harness session as a fixed member. Opening 3 Claude Code sessions in one folder produces **3 presences of one identity**, and a team message **fans out to all 3, each able to reply as that member** — three minds wearing one name, editing the same files. That is a coordination-failure generator (the exact thing Principle 5 / MAST warns against) created by accident, and it makes "an agent is an identity, not a session" (Principle 2) incoherent under concurrency. We also decided **security is a first-class principle** (Principle 7), which reshapes how identities are claimed.

## Core decisions

1. **Identity = a Seat in a Role.** A **Role** (backend, frontend, reviewer…) groups **Seats**. A **Seat** is the durable identity — what v0.1 called a Member — now with a Role, an optional friendly name (`Ada`) or generated handle (`backend-1`), an account status, and a **kind-scoped occupancy**: an **agent** seat has at most one live occupant (single-active + grace), while a **human** seat may have multiple concurrent occupant Presences (ADR 042). History accrues to the seat.
2. **Seats are explicit and persistent. No auto-spawned session-seats.** Real parallelism = more seats (admins provision them), never anonymous clones of one identity.
3. **Activation is explicit.** Configuring a harness makes the musterd tools _available_; it does not occupy a seat. A session occupies a seat by **claiming** it.
4. **Claiming requires two things (security-paramount): an agent key + an admin-issued grant.** The agent key authenticates the _harness_; the **Grant** authorizes occupying a _specific seat or role_. **Default: live admin approval per claim.** A team MAY be configured by an admin to allow **pre-issued grants** (opt-in convenience).
5. **No grant → a governance request.** The session asks an admin (local fast-path if an admin human is co-present; otherwise signal an available admin) who **grants an existing seat or creates a new seat + grants it**, or denies.
6. **Collision → refuse.** Claiming an occupied seat is refused (`claim_conflict`) with the free seats + a hint.
7. **Observer = humans only**, role-gated. Read-only, in a roster `watching` list, never addressable, cannot act. Not a seat; no promotion to a seat.
8. **Governance is its own lane.** Member/seat lifecycle, grants, and requests are governance — distinct from collaboration Acts, distinct surfaces, fully audited. Governance ≠ work approval (Principle 1).

## Terminology (additions)

- **Role** — a named function on a team, defined by admins; groups seats; its capacity = how many seats it has.
- **Seat** — the unit of identity and the thing you claim; belongs to one Role; single live occupant. _Seat_ and _Member_ are the same record from two angles: **Seat** when talking about claiming/capacity, **Member** when talking about participation.
- **Grant** — an admin-issued, **seat/role-scoped, expiring, revocable, audited** authorization to occupy a seat.

Humans are seats too (a named seat in a role like `lead`), but a human claims _their own_ named seat with a human credential; they are not interchangeable within a role the way agent seats are.

## Credentials (the auth model)

- **Agent join key** — team-scoped secret; authenticates a _harness/session_ ("an authorized harness on this team"), **not** an identity. Hashed server-side, rotatable, in the harness config.
- **Grant** — see above. The second factor for occupying a seat. Without a valid grant, a claim becomes a request (decision 5).
- **Human credential** — a human seat's secret; acts as that human, and — if the seat's role permits — observes.
- **Admin** — a capability on a human seat (creator by default): governs roles/seats, issues/revokes grants, configures the team (incl. enabling pre-issued grants), approves requests.

> Migration from v0.1: per-member tokens (`mskd_…`) are replaced by team-level **agent key** + per-claim **grants** + per-human **credentials**. `team add` provisions a seat; it does **not** print a per-member token.

## Claim flow (the heart)

```
session --agent key--> connect (authenticated harness, no identity yet)
        --claim {seat:"Ada" | role:"backend"}-->
            has valid grant?  ── yes ──> seat free? ── yes ──> OCCUPY (account→active)
                                                   └─ no  ──> REFUSE claim_conflict {claimable, hint}
                              ── no  ──> REQUEST → admins
                                         admin co-present & is admin? → approve locally → grant → OCCUPY
                                         else → signal available admin → (grant existing | create+grant | deny)
```

- **Default** is the no-grant path → live admin approval. Secure by default; nothing occupies a seat without an admin authorizing it (once).
- **Pre-issued grants** (team opt-in): an admin bakes a seat-scoped grant into a harness config at `init`; that harness occupies its seat without live approval. The tradeoff is explicit and admin-chosen, per team.
- Grants are **seat/role-scoped, expiring, revocable**, and every issue/use/revoke is **audited** (`security.md`).

## Single-active & grace

- A seat has **at most one** live occupant. A second claim is **refused** — never a silent second presence.
- On disconnect/`leave`, the seat is **held for a grace window = the presence timeout (45s)**. A re-claim of the same seat within the window keeps it (harness restart / dropped socket is invisible). After grace, the seat returns to `claimable` and a team offline event fires.

## Refusal & the request lane

- **Occupied seat** → `claim_conflict` with the list of free seats + `musterd team add` hint.
- **No grant** → a **claim/teammate request** on the governance lane:
  - If an **admin human is co-present** in this session (the operator is admin) → approve locally, instantly.
  - Else → **signal an available admin** (governance notification + `musterd requests` surface). The admin **grants an existing seat**, **creates a new seat and grants it**, or **denies**. The session waits with a clear status.
- Agents never fall back to observing; observation is human-only.

### Approval is explicit, but the admin picks the grant's lifetime

Every non-pre-issued claim is **explicitly approved** (no silent auto-approve) — but at approval the admin chooses how long the issued grant lasts, so a busy operator isn't re-prompted on every reconnect:

- **Just this once** — single-use; expires on release. Maximum security.
- **For the next N hours** — a TTL grant; reconnects/restarts within the window re-occupy without re-prompting ("approve Ada for today").
- **Until I revoke** — a standing grant for a trusted long-running harness.

This is **not** a pre-issued grant (those are baked into a config _before_ any claim, opt-in per team). It is approve-on-first-claim with a chosen window. The 45s grace handles blips; the TTL handles "closed the laptop for lunch." The **solo-operator "never interrupt me" path** remains the sanctioned opt-in: enable pre-issued grants for your own team.

**Graceful interruption** — the approval surfaces as a one-keystroke **approval card** in `inbox --watch` _plus_ a loud notification, showing **surface** (`claude-code`), **seat/role** requested, a harness **fingerprint** (so you recognize "that's my Cursor"), and **batching** ("3 claims from this harness — approve all?").

## Observer mode (humans only)

A human with an observer-permitting role/credential attaches read-only: receives the live stream, shows under the roster **`watching`** list with a handle, is **not addressable**, **cannot send acts**, and is **never** promoted to a seat. `musterd inbox --watch` for a human who hasn't claimed a seat _is_ observer mode.

## The three-axis state model

The states from design ("created but not used", "working on x", "off until 9am", "banned", "archived"…) are three orthogonal axes; the displayed badge is a precedence resolution.

**Axis 1 — Account status** (durable, admin-controlled): `provisioned` (seat created, never occupied) → `active` → (`disabled` ⇄ `active`) → `banned` ; any → `archived`. Disabled/banned/archived seats are not claimable; banned also rejects the human credential.

**Axis 2 — Availability** (schedule-driven; the reserved `availability` field, enforced later): `available` · `away until <ts>` · `off-hours`. v0.2 stores it and reflects a manually-set `away_until`; full schedule **enforcement** stays roadmap.

**Axis 3 — Activity** (live, only while a seat is occupied): `offline` (unoccupied) · `online` (occupied, idle) · `working` · `talking`.

- **`working` is self-reported only** (agent sets `status_update.meta.state`); the server never infers it.
- **`working` persists while the seat is occupied and the session is alive** — it does **not** time-revert to idle (a long "think" is alive via the adapter's heartbeat, independent of the agent's reasoning loop). After **5 minutes** without a fresh `status_update` it is shown **stale**: `working: refactoring auth · 18m` (dim + elapsed), never `online`. It clears on **claim-release / presence-timeout**.
- **`talking`** MAY be derived from an active thread (display sugar; optional).
- Two clocks: **heartbeat = alive**, **last `status_update` = fresh**. (Optional roadmap nicety: a very-stale soft-downgrade after ~30m; skipped in v1.)

**Display resolution (first match wins):** archived/banned/disabled → provisioned (`created · waiting to join`) → away (`off until <ts>`) → unoccupied (`offline`) → occupied (`working: x · Nm` / `talking: y` / `online`).

## The human's day — presence, focus & notifications

Humans are seats, so they share the three axes — but _how_ each is set differs, and humans get a notification model agents don't need.

- **Presence is implicit.** A connected human surface (CLI/app) = `online`; idle drifts to `away`. You don't announce being online.
- **Focus/away/working is explicit, never inferred.** You _set_ `away` (hold my inbox), `dnd`/`focus`, or `off until 9am`. musterd does **not** guess a human's `working: x` from activity (too creepy/inaccurate) — you set it if you want it shown. (Contrast: agents self-report `working` via tool calls.)
- **Notification tiers:**
  - **Loud (notify/page):** anything _directed at you_ — `request_help`/`handoff` to you, `accept`/`decline` of _your_ request, an @mention, and **governance approval requests**.
  - **Quiet (stream only):** ambient `status_update`, broadcasts, others' threads.
  - **Held:** when set away/dnd, messages queue → digest on return.
- **Breakthrough rules:**
  - `away` holds everything **except `urgent`-flagged** pings.
  - `dnd`/`focus` holds quiet; lets directed pings (and `urgent`) through.

> **Localhost down-payment (shipped).** This tiered model is the v0.3 governed target (gated on the
> daemon leaving localhost, ADR 007). The pre-1.0 slice is already built: ADR 024 wired the
> recipient-side **Loud** salience for a _watching_ human (banner + terminal bell) and the comeback
> summary; ADR 035 adds **`musterd notify`**, an opt-in client-side notifier that fires an OS
> notification when a directed (Loud) act lands while the human **isn't** watching. It is one flat
> rule — no `away`/`dnd`/`held` tiers, no `urgent` capability, no per-recipient policy — those tier
> names are the extension seam this superset fills in.

### `urgent` is scarce by design

`urgent` is the only thing that pierces `away`, so it must stay rare. Guardrails (not honor-system):

- **`can_flag_urgent` is a capability** (below) — not everyone holds it; admins grant it.
- An `urgent` ping **must carry a short reason** and is **audited / visible to admins**.
- The recipient can mark an `urgent` as **"wasn't urgent"**, which is recorded against the sender and can cost them the capability.
- (Roadmap) per-sender rate-limit on `urgent`.

## Roles: capabilities & visibility

A Role is more than a label: it carries **capabilities** (what a seat may do) at two tiers — **team/role defaults** and **per-seat overrides that may only narrow** within the role. This is Principle 7 extended from _credentials_ to _capabilities_.

**v0.2 capability set (minimal, fixed — no custom RBAC engine yet):**

- `can_message` — whom this seat may message/notify (e.g. team, specific roles, none).
- `visibility_level` — what team state it can see (drives the need-to-know projection below).
- `tool_allowlist` — which tools/capabilities it may use.
- `declared_resource_scopes` — repos/dirs it's allowed to touch (see enforce-vs-declare).
- `can_flag_urgent`, `can_observe`, `is_admin` — discrete capability flags.

**Need-to-know visibility (projection by viewer):**

- **Admins see everything** about the team — roles, seats, grants, audit, policy, charters.
- **Non-admin seats/agents see a projection** — their teammates' handles + presence + the acts addressed to them; **not** credentials, grants, audit, team policy, or other roles' charters.
- The roster/info endpoints return a _viewer-scoped_ view; the server enforces it.

> **Known gap (2026-07-02):** the **roster/capabilities** projection above is enforced; **message content is not yet scoped.** `GET /teams/:slug/messages` and the `team-all` firehose return every envelope on the team (incl. others' DMs), gated only on `can_observe` (default `true`) — not on recipient. So "the acts addressed to them" is aspirational for message content today. Recipient-scoped reads belong with the v0.3 Shared/remote-team hardening work and gate the derived insight layer (ADRs 048/050/084). See `security.md` § Capabilities & visibility for the full note.

**Enforce vs declare (keeps Principle 4 intact):**

- musterd **enforces everything that flows through it** — messaging, notification, visibility, governance, claims.
- musterd **declares** external scopes (repo/dir/tool access) as the source of truth and advertises them, but **filesystem/tool enforcement is delegated** to the harness today (a sandbox on the roadmap). musterd is the _authority on what a seat may do_; it does not sit between the agent and your disk.

> **ADR 026** names this split the **two universes** (musterd-enforced acts vs the harness's tools) and extends the "declare" half with a third move — **provision**: a Role becomes a harness-agnostic provisioning template (charter + capability defaults + MCP/tool recipe), rendered per-harness by the adapter, phased toward mixed-harness teams. Provisioning is a _starting point, not a security boundary_. **ADR 027** is the guardrail: anything musterd writes into a harness stays additive/reversible/non-obligating.

## Scope boundaries: charter, memory, behavior

- **Charter / instructions — in scope, as data.** A role/seat may carry a **charter** (what this seat is _for_) + instructions. musterd **stores and serves** them — a claiming agent receives its role's charter at claim time — but never _enforces behavior_. Identity metadata, not an execution model.
- **Memory — reserved seam, not built.** A persistent identity wants persistent memory, but musterd is a coordination layer, not a memory store. We **reserve the seam** (the claim response can later carry a memory/context blob alongside the charter) and integrate/build memory **later**. Parked for a dedicated future brainstorm.
- **Behavior enforcement — out.** Principle 4: we connect agents, we don't run them.

## Onboarding (`musterd init`) impact

- **Optional** step **"Create teammates"** — provision **zero, one, or many** agent **seats** (loop: role + optional name → add another?). Skippable; the team + your human seat are enough to start, and seats can be provisioned later with `team add`.
- Configure the harness with the **agent key** (+ optional default `claim`).
- The team is **live-approval by default**; `init` offers the admin an explicit opt-in: _"Allow pre-issued grants for this team?"_ (default No) and, if yes, _"Pre-grant <seat> to this harness so it joins automatically?"_.
- The "waiting to join" spinner (shown only if a harness + default claim were set) waits for an **occupy** (account → `active`), which under the default flow happens after the admin approves.

### Local onboarding & provisioning → `provisioning-recipe.md`

The _local_ (pre-governance) rendering of this seat/claim model — how `init`, claim-on-first-use, the `team_join` tool surface, role templates, and per-harness provisioning actually work — lives in **`provisioning-recipe.md`** (the design under ADR 026/027/028). In brief: `init` is **once per folder** and writes a **claim policy**, not a fixed identity; agents arrive by **claim-on-first-use** (a session connects unclaimed and a human assigns it — explicitly, via a picker / `musterd claim` / a pre-set binding); locally, claiming **auto-mints** the seat, with the grant/approval governance below layering on only when the team leaves localhost. This un-stubs `init`'s parked "activate an existing member" branch; the wire-level handshake is `SPEC.md` Appendix A.3.

## Governance & Principle 1

Admins provision roles/seats, issue/revoke grants, set account status, approve requests, and configure the team. **This is roster governance, not work approval.** Principle 1 ("humans are members, not approvers") is about the _collaboration loop_ — humans don't gate every agent action. Admin actions govern _who is on the team and can occupy a seat_; they never sit in the path of an agent doing its work. Keep that line bright: a grant approval is a join-time, occasional, governance act — not a per-action checkpoint.

## v1 (of this model) vs roadmap

**In v0.2:** seats/roles; agent key + grants (issue/expire/revoke/audit); live-approval default + team opt-in pre-issued grants; the request/approval governance lane (incl. local-admin fast path); single-active + grace; account status + admin commands; human observers; explicit activation; three-axis state with the staleness model; audit log.

**Roadmap:** availability **enforcement**; "claim any open seat in a role" _picker_ UX niceties; very-stale activity soft-downgrade; scoped/rotating per-seat credentials; multi-admin policy & delegation; cross-team federation of seats.

## Resolved (design review)

- **A — member = named seat; claim by name or by role** (role-scoped is admin-defined, not a global free-for-all). ✅
- **B — live admin approval by default; team-level admin opt-in to allow pre-issued grants.** ✅
- **C — requests/approvals are their own governance lane**, separate from collaboration Acts. ✅
- **D — `working` persists while alive + freshness timestamp; clears on release; no time-reversion to idle**; 5-minute freshness threshold; very-stale downgrade skipped in v1. ✅
- **E — approval is always explicit, but the admin picks the grant lifetime** (once / N hours / until-revoke); not a pre-issued grant; graceful one-keystroke approval card + fingerprint + batching. ✅
- **F — human presence implicit, focus/away explicit (never inferred); notification tiers loud/quiet/held; `urgent` is the only thing that pierces `away`, and it's a scarce capability** (reason-required, audited, downgradeable). ✅
- **G — Roles carry capabilities (team default + per-seat narrowing): minimal fixed set, no custom RBAC yet; need-to-know visibility projection (admins all, others scoped); musterd enforces in-band, declares external scopes. Charter = data; memory = reserved seam; behavior = out.** ✅
