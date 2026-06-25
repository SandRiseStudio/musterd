# 055 — Issue a seat to a teammate, and never dead-end a claim

- Status: proposed
- Date: 2026-06-25

## Context

ADRs 032–034 (claim-on-first-use) define how a *pending* session is brought online and how a folder
adopts a seat via `musterd claim --for <code>`. What they do **not** make a documented, discoverable
happy path is the inverse, everyday move: **one teammate prepares a seat and hands it to another
agent.**

The 2026-06-25 dogfood proved the gap is severe. A seat (`Olive`) was pre-created with
`musterd team add`, and a fresh agent was told only "claim the Olive seat." It never reached its task —
it burned the session fighting acquisition and ended by **hand-editing the live SQLite DB**:

- `musterd claim Olive` → ✗ "already a seat… this folder doesn't hold its token — pick another name or
  claim a pool seat with `--role`." (`team add` minted a token for `join --token`; the natural verb
  `claim <name>` refuses it.)
- `musterd join alpha --as Olive` → ✗ "cached identity is David, not Olive — pass `--token`."
- `musterd reclaim Olive` → ✗ "no active identity in this folder."
- The agent then deduced `token_hash = sha256(token)`, minted a token, `UPDATE`d `members`, and joined.

Two root failures, plus collateral:

1. **No issuance primitive.** There is no sanctioned "here is a seat, come take it" channel. `team add`
   prints a raw token once; passing it to a teammate is manual and off-protocol.
2. **The claim path is a maze with no exit.** `claim → join → reclaim → claim` — each error individually
   correct, collectively offering **no forward command**. An accurate error that doesn't say what to do
   next is, for an agent, indistinguishable from a wall — so it engineered *around* the tool.
3. **Single-identity-per-team global config.** `~/.musterd/config.json` caches **one** identity token
   per team. The new agent ran in a folder backed by that shared config (bound to `David`), so joining
   as `Olive` **clobbered David's cached token** and added a stray binding. Agents sharing a config
   trample each other's identity.

> The governing principle this ADR adds: **an onboarding flow must never bottom out in database
> editability.** When a capable agent resorts to patching the store, the flow — not the agent — failed.

## Problem

Give a teammate a one-command way to hand a ready seat to another agent; guarantee no claim/join/reclaim
error ever dead-ends; and stop shared-config identity clobber — all without a wire change beyond what
032–034 already reserve.

## Decision

### 1. Issuance: `team add` emits a claim code; `claim --for <code>` adopts it

`musterd team add <name>` (and a friendlier alias `musterd invite <name>`) prints a **one-time claim
code** alongside the seat, framed as the thing to hand over — not a raw token to copy. The receiving
agent runs `musterd claim --for <code>`, which **binds the seat to its own folder and mints its own
token** (`.musterd/binding.json`, ADR 030/036) — no token copy-paste, no shared-identity write. This is
the issuance half that 032–034's adoption half was waiting for; it becomes the documented happy path for
hand-off.

### 2. The no-dead-end rule (enforced)

Every failure branch of `claim`/`join`/`reclaim` must print **the exact next command**. Concretely:

- `claim <name>` on a held seat → "Ask whoever created this seat for a claim code, then run
  `musterd claim --for <code>`. Or claim a pool seat: `musterd claim --role <role>`." (Not a bare
  "pick another name.")
- `join --as X` with a different cached identity → "This folder is bound to <Y>. To act as X here, run
  `musterd claim --for <code>` (preferred) or `join … --token <tok>`."
- `reclaim X` with no identity → name how to get one first.

A unit-test guard (a small table of every terminal error → asserts it contains a runnable
`musterd …` next-step) keeps this from regressing — modeled on the arch-tree / obs-evals checkers
(presence-and-shape, ADR 043/052).

### 3. Identity isolation: per-folder binding is the channel

The per-folder `.musterd/binding.json` (its own token) is the source of truth for who-acts-here; the
global single-identity cache is a *fallback*, not the auth channel. A handed-off agent operates in its
**own folder** and adopts via claim code, so it never overwrites another seat's cached token. Surface a
warning when a `join --token`/claim would overwrite the cached identity a sibling folder relies on.
(Ties to ADR 036 active-identity-to-act.)

### 4. Primer covers acquisition

The `AGENTS.md` primer (ADR 012) gains a one-line "to take a seat you were handed, run
`musterd claim --for <code>`" — closing the acquisition half of the onboarding gap, which the primer
currently omits (it assumes an already-bound identity).

## Open questions

- **Code transport.** Where does the issuer surface the code — stdout only, or also a directed
  `message`/handoff to a placeholder so it rides the inbox? Leaning: print it, and let `handoff`
  optionally carry it in `meta`.
- **Pool vs named.** Should hand-off always prefer a pool seat (`claim --role`) over a named one? Named
  seats read better on the roster; pool seats are lower-ceremony. Support both; document named+code as
  the default for "I made this for you."
- **Code TTL / single-use.** Expiry and one-time semantics for the claim code (reuse the `until`
  lifecycle machinery vs a dedicated short TTL).

## Consequences

- A teammate can hand off a working seat in one command each way; the receiver never copies a raw token
  and never clobbers a shared identity.
- No claim/join/reclaim error can leave an agent without a next step — removing the pressure that drove
  the dogfood agent to DB surgery.
- Per-folder identity becomes the enforced channel; shared-config clobber is surfaced, not silent.
- Elevates and widens the Wave 1 `seat-binding-ergonomics` item from "don't re-export env" to "acquire
  and hand off a seat without leaving the tool."
- Builds on ADR 032–034 (claim adoption), ADR 030/036 (binding, active identity), ADR 012 (primer),
  ADR 043/052 (the checker pattern reused for the no-dead-end guard).
