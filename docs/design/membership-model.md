# Membership, Identity, Seats & Presence — design proposal

> **Status: DRAFT PROPOSAL — not yet implemented.** This describes a target model agreed during design, not current behavior. Current (v0.1) behavior is: one per-member token baked into the harness config, unconditional auto-join, N sessions = N presences of one member. When accepted this becomes SPEC v0.2 + ADRs and the code follows. Until then, do not implement against it.

> **Living document.** Found an error or better approach? Record it in `docs/decisions/NNN-<slug>.md`, make the smallest correct change, update this doc in the same commit.

Companion docs: `spec-v0.2-draft.md` (protocol), `membership-impl-plan.md` (build), `security.md` (threat model). Glossary lives in `brand.md` §5; this proposal **adds** the terms **Role**, **Seat**, **Grant**.

## Why

The v0.1 adapter auto-joins every harness session as a fixed member. Opening 3 Claude Code sessions in one folder produces **3 presences of one identity**, and a team message **fans out to all 3, each able to reply as that member** — three minds wearing one name, editing the same files. That is a coordination-failure generator (the exact thing Principle 5 / MAST warns against) created by accident, and it makes "an agent is an identity, not a session" (Principle 2) incoherent under concurrency. We also decided **security is a first-class principle** (Principle 7), which reshapes how identities are claimed.

## Core decisions

1. **Identity = a Seat in a Role.** A **Role** (backend, frontend, reviewer…) groups **Seats**. A **Seat** is the durable identity — what v0.1 called a Member — now with a Role, an optional friendly name (`Ada`) or generated handle (`backend-1`), an account status, and **at most one live occupant** (single-active + grace). History accrues to the seat.
2. **Seats are explicit and persistent. No auto-spawned session-seats.** Real parallelism = more seats (admins provision them), never anonymous clones of one identity.
3. **Activation is explicit.** Configuring a harness makes the musterd tools *available*; it does not occupy a seat. A session occupies a seat by **claiming** it.
4. **Claiming requires two things (security-paramount): an agent key + an admin-issued grant.** The agent key authenticates the *harness*; the **Grant** authorizes occupying a *specific seat or role*. **Default: live admin approval per claim.** A team MAY be configured by an admin to allow **pre-issued grants** (opt-in convenience).
5. **No grant → a governance request.** The session asks an admin (local fast-path if an admin human is co-present; otherwise signal an available admin) who **grants an existing seat or creates a new seat + grants it**, or denies.
6. **Collision → refuse.** Claiming an occupied seat is refused (`claim_conflict`) with the free seats + a hint.
7. **Observer = humans only**, role-gated. Read-only, in a roster `watching` list, never addressable, cannot act. Not a seat; no promotion to a seat.
8. **Governance is its own lane.** Member/seat lifecycle, grants, and requests are governance — distinct from collaboration Acts, distinct surfaces, fully audited. Governance ≠ work approval (Principle 1).

## Terminology (additions)

- **Role** — a named function on a team, defined by admins; groups seats; its capacity = how many seats it has.
- **Seat** — the unit of identity and the thing you claim; belongs to one Role; single live occupant. *Seat* and *Member* are the same record from two angles: **Seat** when talking about claiming/capacity, **Member** when talking about participation.
- **Grant** — an admin-issued, **seat/role-scoped, expiring, revocable, audited** authorization to occupy a seat.

Humans are seats too (a named seat in a role like `lead`), but a human claims *their own* named seat with a human credential; they are not interchangeable within a role the way agent seats are.

## Credentials (the auth model)

- **Agent join key** — team-scoped secret; authenticates a *harness/session* ("an authorized harness on this team"), **not** an identity. Hashed server-side, rotatable, in the harness config.
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

## Observer mode (humans only)

A human with an observer-permitting role/credential attaches read-only: receives the live stream, shows under the roster **`watching`** list with a handle, is **not addressable**, **cannot send acts**, and is **never** promoted to a seat. `musterd inbox --watch` for a human who hasn't claimed a seat *is* observer mode.

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

## Onboarding (`musterd init`) impact

- **Optional** step **"Create teammates"** — provision **zero, one, or many** agent **seats** (loop: role + optional name → add another?). Skippable; the team + your human seat are enough to start, and seats can be provisioned later with `team add`.
- Configure the harness with the **agent key** (+ optional default `claim`).
- The team is **live-approval by default**; `init` offers the admin an explicit opt-in: *"Allow pre-issued grants for this team?"* (default No) and, if yes, *"Pre-grant <seat> to this harness so it joins automatically?"*.
- The "waiting to join" spinner (shown only if a harness + default claim were set) waits for an **occupy** (account → `active`), which under the default flow happens after the admin approves.

## Governance & Principle 1

Admins provision roles/seats, issue/revoke grants, set account status, approve requests, and configure the team. **This is roster governance, not work approval.** Principle 1 ("humans are members, not approvers") is about the *collaboration loop* — humans don't gate every agent action. Admin actions govern *who is on the team and can occupy a seat*; they never sit in the path of an agent doing its work. Keep that line bright: a grant approval is a join-time, occasional, governance act — not a per-action checkpoint.

## v1 (of this model) vs roadmap

**In v0.2:** seats/roles; agent key + grants (issue/expire/revoke/audit); live-approval default + team opt-in pre-issued grants; the request/approval governance lane (incl. local-admin fast path); single-active + grace; account status + admin commands; human observers; explicit activation; three-axis state with the staleness model; audit log.

**Roadmap:** availability **enforcement**; "claim any open seat in a role" *picker* UX niceties; very-stale activity soft-downgrade; scoped/rotating per-seat credentials; multi-admin policy & delegation; cross-team federation of seats.

## Resolved (design review)

- **A — member = named seat; claim by name or by role** (role-scoped is admin-defined, not a global free-for-all). ✅
- **B — live admin approval by default; team-level admin opt-in to allow pre-issued grants.** ✅
- **C — requests/approvals are their own governance lane**, separate from collaboration Acts. ✅
- **D — `working` persists while alive + freshness timestamp; clears on release; no time-reversion to idle**; 5-minute freshness threshold; very-stale downgrade skipped in v1. ✅
