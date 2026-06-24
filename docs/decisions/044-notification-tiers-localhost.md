# 044 — Notification tiers: the localhost down-payment

- Status: accepted
- Date: 2026-06-24

## Context

ADR 024 wired the **recipient-side** half of the Co-Gym notification finding (`research-foundation.md`;
arXiv:2412.15701 — a notification protocol more than doubles the collaborative win rate, **30% → 70%**)
and ADR 035 closed the **(B′) away-with-nothing-open** hole with `musterd notify`, a client-side OS
notifier. Both were deliberately **flat**: one rule — _a directed act to a human who isn't watching
fires a notification_ — with no availability axis and no salience tiers. ADR 035 named the seam: "the
v0.3 tier names (`away`/`urgent`) are the obvious extension."

This ADR takes the next bounded step toward the governed model in `SPEC.md` A.6 (Axis 2) + A.6a
(Notifications & urgency): it makes availability **explicit and self-set**, and makes `notify` **tier**
deliveries by it. It is the localhost down-payment on A.6a, exactly as ADR 035 was the down-payment on
the Loud tier — it ships the *mechanism* without the *governance*.

## Problem

Let a human say "I'm away / do-not-disturb" and have an agent's ping respect it — while still letting a
genuine emergency break through — **without** (a) a schema migration, (b) a protocol-version bump, (c) a
new runtime dependency, or (d) building the v0.3 capability/audit governance the full model demands.

Three sub-decisions, each load-bearing:

1. **Where availability lives** — a new column/table, or reuse?
2. **Who sets it, and how** — inferred, or explicit; which surface.
3. **Where tiering runs** — server-side policy, or client-side in the notifier.

## Decision

### 1. Availability reuses `members.availability` — no migration

The `members.availability` TEXT column has existed since schema v1 (it was reserved, never written).
We store a JSON `{ status: 'available' | 'away' | 'dnd', until?: <ms epoch> }` there. `away_until(ts)`
(SPEC A.6) is encoded as `away` + `until`; `until` is meaningful only with `away` and the server drops
a stray `until` from `available`/`dnd` so the stored shape can't claim "back at 5pm" while available.
A new typed `AvailabilitySchema` in `@musterd/protocol` replaces the field's old loose
`z.record(z.unknown())`, and `rows.ts` `toMember` parses defensively — a malformed/legacy blob degrades
to `null` (implicit-available) rather than failing the roster projection.

- **No migration** (the column is already there); **no new table**. `off_hours` and full schedule
  enforcement (the roadmap "Schedule & lifecycle enforcement" item) stay out — only the three states
  the notify loop actually consumes are modeled.

### 2. Self-set, never inferred — `POST /teams/:slug/availability` + `musterd availability`

Availability is set **only** by the member's own authed call (`POST /teams/:slug/availability`, gated by
`authMember`), surfaced as `musterd availability <available|away|dnd> [--until <iso>]`. This is the SPEC
A.6 invariant — for humans, `away`/`dnd`/`away_until` are **explicitly set, never inferred** — in
contrast to presence/activity, which the server *derives*. The roster already carries `availability`
via `toMember`, so it surfaces with no extra plumbing; the CLI renders `away` as `off until <ts>` (A.6
display resolution puts away above the unoccupied/occupied states), `dnd` as `dnd`, and treats
`available` as the implicit default that never overrides the live activity column.

- **Self-only, ungoverned on localhost.** Any member may set *their own* availability; no one sets it
  for another. The `can_*` capabilities that would gate this in v0.3 are the named seam, not built.

### 3. Tiering runs client-side in `notify`; the server only stores + exposes

The server is a clean coordination core (the ADR 035 principle): it **stores** availability and
**exposes** it on the roster, and does nothing else with it. The Loud/Quiet/Held classification and the
away/dnd **breakthrough** run **client-side** in `musterd notify`, which already reads the roster (for
reachability). It now also reads the recipient's own availability and gates the candidate set:

- `available` — pass the **Loud** set (directed acts: `request_help`/`handoff`/`accept`/`decline`/@me),
  as ADR 035 did.
- `dnd` — hold quiet, pass directed pings **+ `urgent`**. (Quiet was never a `notify` candidate, so in
  practice dnd ≈ available + the explicit urgent guarantee.)
- `away` — hold **everything except** an `urgent` breakthrough.
- `urgent` pierces **every** tier.

Keeping tiering client-side means **no wire change and no SPEC/protocol-version bump** — the same
posture ADR 035 took. The server storing availability is the only new state, and it rides the existing
roster read.

### 4. `urgent` is `meta.urgent` + required `meta.urgent_reason`, **ungated**

`urgent` is an envelope `meta.urgent: true` carrying a **required** non-empty `meta.urgent_reason`,
enforced in `actMetaRules` (`@musterd/protocol`) alongside the existing accept/decline/resolve rules.
Because it is an **additive optional meta pair** — absent on every existing message — it needs **no
protocol-version bump** (the same reasoning that lets `meta.state`, `meta.otel`, etc. ride v0.2). The
CLI exposes it as `send --urgent --urgent-reason <why>`.

- **Ungated on localhost** (the explicit OUT, like ADR 035's omissions): the `can_flag_urgent`
  capability that scopes *who* may flag, the `urgent` audit trail, and the recipient `wasnt_urgent`
  feedback (SPEC A.6a) are all the v0.3 governed superset, **not** built here. The required reason keeps
  the cost legible even while ungated.

## Consequences

- **No SPEC / protocol-version bump, no migration, no new dependency.** Availability reuses an existing
  column; tiering is client-side; `urgent` is additive optional meta. A.6a remains the **governed
  superset** — this is its localhost down-payment, and `can_flag_urgent` / audit / `wasnt_urgent` /
  `off_hours` are the named seams.
- **Explicit, honest availability.** Self-set only; the server never invents it. The roster tells the
  truth (`off until <ts>`), and the notifier respects it.
- **Emergencies still get through.** `urgent` breaks an away/dnd hold; the required reason keeps the
  flag from becoming ambient noise even before v0.3 gates who may use it.
- **Backward compatible.** A member who never sets availability behaves exactly as under ADR 035
  (implicit-available); a sender who never flags `urgent` is unaffected.
