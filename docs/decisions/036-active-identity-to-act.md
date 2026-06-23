# 036 — an active identity is required to act (the global config is a credential store, not an act-authority)

- Status: accepted
- Date: 2026-06-23

## Context

`resolve()` ([packages/cli/src/commands/helpers.ts]) picks the active team + identity with the
ADR 018 precedence: `--flags → MUSTERD_* env → workspace .musterd/binding.json → global config`. The
last source — the global `~/.musterd/config.json` `identities` map (one slot per team) + `current` —
was treated identically to the others: a silent, machine-wide default used by *every* command,
including writes.

A 2026-06-23 dogfood exposed the hazard. Running `musterd notify` in `~/agents` — a folder unrelated
to any team, with no binding and no env identity — silently resolved to the member **David** (the
global default for the `current` team `alpha`) and acted as them. A bare `cd` into any folder makes
the CLI act *as* a real teammate. ADR 018 demoted the global slot to last-resort to stop two agents
*colliding* on it, but didn't stop it from silently *authorizing* an act. A token authenticates one
member on one team; nothing should write as that member just because of where the shell happens to be.

## Problem

Stop an ambient global-config identity from silently *acting as* a real member, **without** breaking
the single-user "create a team, then act in the same shell" flow, and without a server or wire change.

## Decision

The global config `identities` map is a **credential store + read default**, **not an
act-authority**. Identity now has two postures, split by command kind:

- **Act path — `resolve()`** (every command that writes/acts as a member: `send`, `team add`/
  `remove`, `reclaim`, `inbox`'s cursor advance, `notify`'s poll). The identity must be **explicit**:
  from `MUSTERD_*` env, a workspace binding, or a named `--as <member>`. An *ambient* match (global
  config only, no `--as`) is **refused** with guidance:
  `no active identity in this folder for team "X" — run: musterd claim <name>  (bind this folder), or pass --as <member>`.
  `resolve()` carries `identitySource` + `explicit` to make the rule legible.
- **Read path — `resolveRead()`** (operator/team reads: `status`). A team is required, an identity is
  **optional**. `status` always prints the **auth-free** roster (works from any folder, even with no
  identity) and shows its per-member "⚑ waiting for you" comeback summary (ADR 024) **only when the
  identity is explicit** — an inbox is member-specific and auth-gated, so an ambient/absent identity
  simply has none to show.

**Frictionless onboarding via auto-bind.** `team create` and `join` now **auto-bind the current
folder** (`saveBinding(cwd, …)`, the same write `claim`/`init` already do) to the new identity. The
folder you set up in is immediately *active* — you act there with no `--as` — while every other
unbound folder stays read-only. `init` is unchanged: it already binds the folder to the **provisioned
agent**, which is the folder's intended occupant (a competing human binding would clobber it).

**`--as` is the explicit-intent upgrade.** In a folder with only an ambient identity, `--as <member>`
(matched against the stored credential) makes the act explicit and is allowed — the named,
deliberate path the refusal points to.

## Consequences

- **No SPEC / protocol-version bump, no server change.** Pure CLI-side resolution. The server already
  serves `/health` and the roster unauthenticated and already requires a member token for `inbox` +
  all writes, so "free reads / refused acts" needed nothing new on the wire.
- **No more silent impersonation.** A bare `cd` into an unrelated folder can read team state but
  cannot act as a real teammate; acting is always env, binding, or a named `--as`.
- **Onboarding keeps zero friction in the creating folder** (auto-bind) and becomes explicit
  everywhere else — the behavior the user asked for ("least friction after creating a team, explicit
  from there on out").
- **Tests model reality.** The multi-persona `cli.e2e.test.ts` cases that simulated several humans by
  swapping `MUSTERD_CONFIG` in one cwd and leaning on the global fallback to act were refactored:
  each persona now acts from its own `MUSTERD_*` env (its own session), and the suite mocks
  `process.cwd()` so auto-bind writes land in a throwaway dir.
- Supersedes the relevant half of ADR 018's "global config is just the last source": it is the last
  source **for reads**, and **not a source for acts at all**.
