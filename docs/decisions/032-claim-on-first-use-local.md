# 032 — claim-on-first-use (local): rides existing primitives, no wire change

- Status: accepted
- Date: 2026-06-23

## Context

Provisioning Phase 1 is merged (b50401f): roles provision tools, `musterd role`, `musterd uninstall`.
The next chapter of the same design (`provisioning-recipe.md` §5–§6) is **claim-on-first-use**: `init`
is once-per-folder and writes a *claim policy*, not a fixed identity; a session arrives **unclaimed**
and is given an identity when it's first used. Today, by contrast, an agent is minted at `init` and
bound 1:1 in `.musterd/binding.json` (ADR 018) — there is no seat-claim at all.

The full governed seat/grant model — agent key + admin-issued grants, the approval lane, the A.3
`claim` handshake — is **v0.3**, activating only when the daemon leaves localhost
(`membership-model.md`, `SPEC.md` Appendix A). This ADR builds the **local, frictionless half** now
and defers the governance.

The load-bearing fork (flagged in the handoff): **does the local claim need a wire change** — promote
A.3's `claim` frame from Unreleased to released (a MINOR) — or can it ride today's `hello`/members
primitives, the way ADR 024 avoided a bump?

## Problem

"Claiming a seat" wants to: (1) get an identity for an unclaimed session, (2) auto-mint a named or
pool seat locally, (3) refuse to take a seat another live session legitimately holds (`claim_conflict`)
while letting a session re-occupy its **own** reloaded seat (newest-wins, ADR 017). The A.3 design
expresses all of this as a new authenticated `claim` handshake on the wire. But A.3 is inseparable
from the governance it carries (agent key + grant, the `pending`/request lane) — promoting just its
frame would either drag the governance in early or ship a half-specified frame.

## Decision

**No wire change. No SPEC version bump. The local claim mechanics ride the existing primitives.**

The mapping that makes this work — locally, **identity is a member + its per-member token** (ADR 018),
and the daemon is single-operator/localhost (ADR 007), so:

- **Auto-mint = the existing, unauthenticated `POST /teams/:slug/members`.** "Locally, claiming
  auto-mints the seat" (recipe §5) is literally minting a member and storing its token in the
  workspace binding. No new endpoint.
- **Occupy = the existing `hello`** (newest-wins + 45s grace, already built — ADR 017, SPEC §74).
- **`claim_conflict` = the existing unique-name `conflict` on mint.** A named seat held by *another*
  session is, locally, a name already on the roster that **this folder doesn't hold the token for** —
  so the mint is refused (names are unique per team) and we surface it as a conflict with the roster +
  a "pick another name / claim a `--role` pool seat" hint, rather than impersonating. A session
  re-occupying its **own** seat holds the token (in its binding), so it never mints — it just
  `hello`s and newest-wins reclaims. Free / in-grace → re-occupy. This reproduces the recipe's
  three-way conflict semantics **with zero server changes**: the server only ever `hello`s a seat
  whose token the claimant already holds.

Because of this, **the server is untouched** by this slice; the change is entirely in the CLI and the
MCP adapter, plus the local binding schema. `SPEC.md` Appendix A.3 stays **Unreleased** — the wire
`claim`/grant handshake remains the v0.3 (off-localhost) path; a short pointer is added there noting
the *local* experience is delivered without it.

### What this slice ships

- **Binding carries an optional identity + a claim policy** (`@musterd/protocol`, ADR 033): `member`
  and `token` become optional; a folder may be bound to a policy with no fixed identity.
- **`team_join` is overloaded** (one tool, not a new one): `{as:"Ada"}` claims a named seat (minted if
  absent), `{role:"backend"}` claims the next open `<role>-<n>` pool seat (returns the handle), `{}`
  uses the folder policy. The result returns the **assigned identity** so a fresh session learns who
  it is (its charter is in `AGENTS.md`, written by `init` — ADR 012).
- **`musterd claim <name>` / `--role <x>`** — the L2 universal floor (needs only the daemon, works in
  any harness): mint-or-reuse, then write the seat into `.musterd/binding.json` so the CLI **and** a
  (re)launched adapter resolve to it.
- **`init` stamps the folder claim policy** alongside the minted identity (`seat:<name>`). Deliberately
  *alongside*, not *instead of*: `init` keeps minting the primary seat (back-compat, unchanged UX),
  and the claim-on-first-use path is now available without re-init. (The handoff explicitly permits
  "instead of **or alongside**"; alongside is the smaller, lower-risk correct change.)
- **`MUSTERD_CLAIM` grammar + the ADR 018 ladder** resolve the policy: `MUSTERD_CLAIM` env →
  `binding.claim` → default `chat`. Autojoin fires ⇔ a non-`chat` default exists.

## Consequences

- The single biggest local UX gap closes: a harness launched without a pre-minted identity is no
  longer dead — it's a pending presence that names itself (`team_join {as}`) or is named by a human
  (`musterd claim`). Worktree-per-agent and role pools work without re-running `init`.
- **Zero protocol/server risk.** Every existing wire test, every existing daemon, keeps working
  untouched; there is no version negotiation to get wrong. When the daemon leaves localhost, the v0.3
  governed claim (A.3) layers on top — this slice is the frictionless-local floor it secures, not a
  competing path. The unauthenticated mint that makes this frictionless **is** the localhost trust
  assumption (ADR 007); off-localhost, the agent-key + grant gate replaces it.
- The honest local limit: a named seat whose token this folder has lost can't be re-occupied locally
  (mint refuses the duplicate). That's correct — token reissue is the v0.3 grant model, not a local
  capability. The conflict message says so.
- This is also the slice that **unblocks** the parked free-text-role-vs-template unification
  (`provisioning-recipe.md` "open"): claim now assigns the role, so a template pick can drive the
  seat's role here later. Left as a clear hook, not built.
- Supersedes nothing; extends ADR 017 (own-reload reclaim) and ADR 018 (the binding is still the one
  source of identity, now also of policy). Companion: ADR 033 (pending presence). Updates:
  `provisioning-recipe.md` §5–§6 (settled → built), `SPEC.md` A.3 (pointer), `05-mcp.md`/`04-cli.md`.
