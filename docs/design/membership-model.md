# Membership, Identity & Presence — design proposal

> **Status: DRAFT PROPOSAL — not yet implemented.** This describes a target model agreed during design, not current behavior. Current behavior is: one member token baked into the harness config, unconditional auto-join, N sessions = N presences of one member. When this is accepted it becomes SPEC v0.2 + ADRs and the code follows. Until then, do not implement against it.

> **Living document.** If you find an error, contradiction, or better approach: record it in `docs/decisions/NNN-<slug>.md`, make the smallest correct change, and update this doc in the same commit.

## Why

The v0.1 adapter auto-joins every harness session as a fixed member. Opening 3 Claude Code sessions in one folder produces **3 presences of one identity**, and a team message **fans out to all 3, each able to reply as that member** — three minds wearing one name, editing the same files. That is a coordination-failure generator (the exact thing Principle 5 / MAST warns against) created by accident, and it makes "an agent is an identity, not a session" (Principle 2) incoherent under concurrency.

## Core decisions

1. **Members are explicit, named, persistent, single-active.** A member is embodied by **at most one live session at a time**. There are **no auto-spawned session-members**.
2. **Activation is explicit.** Configuring a harness makes the musterd tools *available*; it does not make a session join. A session joins by **claiming** an identity.
3. **Identity = team-access credential + claim-at-join.** The harness config carries a **team join key**, not a member token. On join, the session **claims** a specific named member (or, for humans, **observes**).
4. **Collision → refuse.** Claiming an already-claimed member is refused, with a helpful message: claim a different available member, or **ask an admin to create a new teammate**.
5. **Observer = humans only**, role-gated. Read-only, appears in a "watching" list, never addressable, cannot act. No promotion from observer to member.
6. **Admins govern the roster** (create/disable/ban/archive members). Governance ≠ work-approval (see Principle 1 note).

## Identities & credentials (the auth change)

- **Team join key** — a team-scoped secret. Baked into a harness config. Grants the ability to *connect and claim an agent identity* on that team. It is **not** an identity by itself.
- **Member** — a named roster identity with an account status (below). A member is **claimable** (active + nobody holding it) or **claimed** (a live session holds it).
- **Human credential** — a human's own identity secret (from creating/joining the team). Lets them act as their member, and — if their role permits — **observe**.
- **Admin** — a human member with the governance capability. The team creator is admin by default.

> Migration from v0.1: per-member tokens (`members.token_hash`, the `mskd_…` strings) are replaced by (a) a team join key for agent claims and (b) human credentials. `team add` prints the team join key + the member name to claim, not a per-member token.

### Claim-at-join handshake (replaces today's hello→token)

```
session → join { team, key, claim: { kind: "member", name: "Ada" } | { kind: "observe" }, surface }
server  → granted { member | observer_handle, presence_id }     # success
        | refused { reason, claimable: ["…"], hint }            # member taken / not allowed
```

- `claim.member` requires the team key (agents) and the member be `active` + unclaimed.
- `claim.observe` requires a **human credential with an observer-permitting role**.
- Releasing the claim (disconnect / explicit leave) returns the member to `claimable`.

v1 can bake a **default claim** into the config (e.g. `MUSTERD_CLAIM=Ada`) so the magical "it joined!" still works; reclaiming as someone else is just a different claim. Picking interactively from `claimable` is a roadmap nicety.

## Single-active & refusal UX

- A member is held by one live session. A second claim is **refused** — never a silent second presence.
- Refusal message (agent): `"Ada" is active in another session. No other members are free — ask an admin to add a teammate: musterd team add <name> --kind agent`.
- This is why **no session-members** is coherent: real parallelism = *more named members* (admin creates them), not anonymous clones of one.

## Observer mode (humans only)

- A human with an observer-permitting role/credential attaches read-only: receives the live stream, shows up under a roster **"watching"** section with a generated handle, is **not addressable**, and **cannot send acts**.
- `musterd inbox --watch` for a human who has not claimed a member *is* observer mode.
- Agents are never observers. A refused agent session gets the refusal message above; it does not fall back to observing.

## The three-axis state model

The states from design ("created but not used", "offline", "working on x", "offline until 9am", "banned", "archived"…) are three orthogonal axes. The displayed badge is a **precedence resolution** over them.

**Axis 1 — Account status** (durable, admin-controlled):
`provisioned` (created, never claimed) → `active` → (`disabled` ⇄ active) → `banned` → `archived`.
A `disabled`/`banned`/`archived` member cannot be claimed; `banned` also rejects its credential.

**Axis 2 — Availability** (schedule-driven; the `availability` field, enforced):
`available` · `away until <ts>` · `off-hours`. (Enforcement is roadmap; the field is reserved today.)

**Axis 3 — Activity** (live, only while claimed):
`offline` (unclaimed — nobody embodies it) · `online` (claimed, idle) · `working: <task>` · `talking: <member>`. Observers carry `observing` on a separate watcher record.

**Display resolution (first match wins):**

| If account is… | …show |
|---|---|
| `archived` / `banned` / `disabled` | that word (terminal/admin state) |
| `provisioned` (never claimed) | `created · waiting to join` |
| else, if availability says away | `off until <ts>` |
| else, if unclaimed | `offline` |
| else (claimed) | `working: x` / `talking: y` / `online` |

Schema impact: split today's flat `presence.status` + `members.left_at` into these axes — e.g. `members.account_status`, the existing `availability`, and a claim/activity record on the live attachment.

## Onboarding (`musterd init`) impact

- Add an **optional** step: **"Create teammates"** — you may create **zero, one, or many** agent members during init (loop: "Add a teammate? name + role → add another? "). Skipping is fine; the team + your human membership are enough to start, and teammates can be created any time later with `team add`.
- Configure the harness with the **team join key** (+ optional default claim of one of the members you just created).
- Optional, opt-in, default **No**: *"Auto-claim <name> whenever a session starts here?"* — keeps the one-keystroke magic for those who want it; explicit otherwise.
- The "waiting to join" spinner (only shown if you configured a harness + a default claim) waits for a **claim**, not a bare presence.

## Governance & Principle 1

Admins create/disable/ban/archive members and define who may observe. **This is roster governance, not work approval.** Principle 1 ("humans are members, not approvers") is about the *collaboration loop* — humans don't gate every agent action. Admin actions never sit in the path of an agent doing its work; they manage who is on the team. Keep that line bright: no admin step should ever become a per-action approval.

## v1 vs roadmap

**In this revision (v1 of the new model):**
- Team join key + claim-at-join; single-active; refuse-on-collision.
- Account status `provisioned/active/disabled/banned/archived` + admin commands.
- Human observer mode (read-only).
- Explicit activation, with opt-in auto-claim.
- Three-axis state with display resolution; `working/talking` activity reported by the agent via existing `status_update`.

**Roadmap (reserved, not built):**
- Availability **enforcement** (off-hours/away windows actually gating).
- Interactive "claim from available members" picker.
- Scoped/rotating credentials, per-member keys, multi-admin policies.
- An in-protocol "request a teammate" act from a refused agent to admins (today it's an out-of-band `team add`).

## Resolved (design review)

1. **Agent claims target a named member.** A session claims a specific member via `MUSTERD_CLAIM`; there is no "claim any free agent" in this revision (reserved for roadmap).
2. **Two credential kinds from day one:** an **agent join key** (claims agent members) and a **human credential** (acts as a human member and/or observes, role-gated). Observer gating already needs the human side, so the split exists from the start.
3. **`working: x` is self-reported only** — the agent sets it via `status_update.meta.state`. No server-side inference from activity.
4. **On disconnect, a claimed member stays held for a short grace window = the presence timeout** (45s). A reconnect within the window keeps the seat; after it, the member returns to `claimable`. This makes a dropped socket / harness restart non-disruptive.

## Still open (later)

- An in-protocol "request a teammate" act from a refused agent to admins (today: out-of-band `team add`).
- Interactive "claim from available members" picker and any-free claims.
- Scoped/rotating credentials, per-member keys, multi-admin policy.
