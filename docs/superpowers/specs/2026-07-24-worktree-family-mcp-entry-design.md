# Worktree-family MCP entry — per-seat identity in a per-repo-root config slot

Design for lane `01KYAWFCGG7YZ80H1RWEF4CXQ1`. Follow-up to ADR 143 and ADR 158; ships as ADR 165 —
next free number as of `origin/main` at `c4be772`, to be re-checked before the PR that lands the ADR
(parallel branches have collided on this ADR's number three times — 159 → 164 → 165;
`pnpm adr-numbers:check` gates it).

## Problem

Claude Code keys its local-scope MCP config by **repo root**. Every `agents-*` seat worktree is a git
worktree of the same repo, so all thirteen share **one** `musterd` entry.

`musterd init` and `musterd wire` bake per-seat state into that entry via `buildMcpEnv`
(`packages/cli/src/onboard/mcpEntry.ts:46`) — `MUSTERD_SERVER`, `MUSTERD_TEAM`, `MUSTERD_AGENT_KEY`,
`MUSTERD_GRANT`. `musterd agent` does not: since ADR 143 it writes a deliberately seat-agnostic entry
(`packages/cli/src/commands/agent.ts:145-179`), whose comment states the principle outright — _"Omitting
it makes the shared entry identical for every seat, and therefore harmless."_

Two writers, opposite policies, one slot. Whichever ran last wins.

The baked secrets are load-bearing, not decorative. `packages/mcp/src/config.ts:122-123` reads
`env['MUSTERD_AGENT_KEY'] ?? binding?.agent_key` and `env['MUSTERD_GRANT'] ?? binding?.grant` — **env
outranks binding.json** — and both ride the claim frame (`packages/mcp/src/claim.ts:107`). So a seat can
present a sibling's credential at claim time and have its claim denied or routed to approval.

Observed live 2026-07-24 in `agents-ryder`; three seats (izzo, miley, ryder) wrote the same slot within
one hour on 2026-07-24.

This is the same shape as ADR 158 on a different axis: 158 fixed a **precedence** inversion, this is a
**cardinality** mismatch.

### Why the current remedy makes it worse

The doctor's grant check (`packages/cli/src/onboard/doctor.ts:214-224`) prescribes _"Re-run `musterd init`
here."_ Because the slot is shared and zero-sum, that repairs the running seat by taking the slot from
whoever holds it, who then hits the `expired_grant` trap on wake. `--fix` escalates this: it calls full
interactive `runInit()` (`packages/cli/src/commands/init.ts:22`), which mints a member and trips the
already-bound guard at `packages/cli/src/onboard/guard.ts:41`.

## Invariant

> A config slot shared by N seats may contain only what is identical across all N. Per-seat state lives
> in the per-seat file (`.musterd/binding.json`), which the adapter finds by walking up from cwd.

ADR 143 established this and applied it to `MUSTERD_BINDING`. ADR 158 applied it to `MUSTERD_MODEL`.
`mcpEntry.ts:26-45` already argues the case at length for `MUSTERD_CLAIM` and `MUSTERD_MODEL` — _"a stale
copy that outranks binding.json and can never be updated."_ `MUSTERD_GRANT` and `MUSTERD_AGENT_KEY` have
that identical property **and** are per-seat secrets. Strictly worse than the two already removed, and
still present.

### The shape generalizes beyond this slot

One shared slot, many legitimate claimants, and the obvious repair — make the slot mine — steals it
from whoever holds it. Recorded here because it is not specific to the MCP entry:

- **This lane** (`01KYAWFCGG`): the Claude Code MCP entry, keyed by repo root, shared by every seat
  worktree. Claimants are seats; the theft is presenting a sibling's credential at claim time.
- **`binding.session`** (stanley, lane `01KYJF8QAF`; recorded as ADR 164's explicit non-fix in #398):
  a single last-write-wins slot, so a stale capture defeats the wake guard's
  never-spawn-beside-a-live-session rule. Claimants are sessions of one seat.

**The resolution that works here is not "partition the slot" but "empty it."** Making the slot
per-claimant requires a key the writer does not have at write time — `musterd agent` cannot know which
worktree will claim, and the wake guard cannot know which session will outlive it. Making it carry only
what is identical across all claimants needs no such key, and the per-claimant file (`binding.json`, walked
up from cwd) already exists and is already authoritative. A slot that holds nothing contested cannot be
stolen, and cannot go stale.

Whether `binding.session` has an equivalent "already authoritative per-claimant file" to fall back on is
the open question on stanley's side; if it does not, the analogy stops at the diagnosis and the remedy
does not transfer.

## Decision

Finish the move. Make the shared entry seat-agnostic; do not try to make the slot per-worktree.

Rejected alternatives:

- **Worktree-aware provisioning** (mirror `workspace.ts:49-59`, which solves this exact shape for git
  identity via `extensions.worktreeConfig`). Claude Code owns the repo-root keying and we don't; this
  means abandoning `claude mcp add -s local` for direct config writes. Manages the conflict instead of
  deleting it.
- **Doctor-only fix.** Stops the harmful remedy but leaves the zero-sum credential in place.

### Increment 1 (this spec): secrets and identity

`buildMcpEnv` returns `{}`. Dropped: `MUSTERD_SERVER`, `MUSTERD_TEAM`, `MUSTERD_AGENT_KEY`,
`MUSTERD_GRANT`, `MUSTERD_SURFACE`. `MUSTERD_SURFACE` also drops from `agent.ts:175`.

**Keep the function, do not inline `{}` at the call sites.** An always-empty helper looks like dead
weight, but it is the one place the _reason_ the entry is empty is written down, and it is where the
regression test binds. Its doc-comment absorbs the invariant below. Deleting it would leave three call
sites with a bare `{}` and no record of why — which is how `MUSTERD_GRANT` outlived `MUSTERD_CLAIM` in
the first place.

All five survive as **manual** overrides — the status `MUSTERD_CLAIM` and `MUSTERD_MODEL` already hold.
We stop materializing them; we do not stop honouring them.

**Safety.** Every dropped var has a fallback in `config.ts:116-124`, verified against `main` at `fdb617e`:

| var                 | fallback after the strip                                              |
| ------------------- | --------------------------------------------------------------------- |
| `MUSTERD_SERVER`    | `binding.server` → `spec.server` → `http://localhost:4849`            |
| `MUSTERD_TEAM`      | `binding.team` → `spec.team`                                          |
| `MUSTERD_SURFACE`   | `binding.surface` → `spec.surface` → `'other'`                        |
| `MUSTERD_AGENT_KEY` | `binding.agent_key` (secret — never in the committed spec, by design) |
| `MUSTERD_GRANT`     | `binding.grant` (same)                                                |

`init` and `wire` both write `binding.json` before returning (`wire.ts:87`), so the file is always
present. **No adapter change is required.**

### Increment 2 (deferred, separate lane): the knobs

`MUSTERD_AUTOJOIN` and `MUSTERD_DRIVER` are read only from `process.env`
(`packages/mcp/src/index.ts:195`, `packages/mcp/src/workspace.ts:44`) — no binding fallback exists.
`agent.ts:176-177` bakes both into the shared slot, so:

- `musterd agent X --driver nick` marks **every** worktree in the family as driven by nick, corrupting
  ADR 155 driver co-presence.
- Autojoin is forced on family-wide, defeating the default `wire.ts:17` documents.

Fixing these needs new `Binding` fields plus adapter fallback — a protocol change, hence its own lane.

## Scope boundary, stated honestly

After increment 1 the three writers are **not** byte-identical:

- `init` / `wire` → `{}` or `{MUSTERD_AUTOJOIN}`
- `agent` → `{MUSTERD_AUTOJOIN, MUSTERD_DRIVER}`

What increment 1 guarantees is narrower: **no field remaining in the shared entry can deny a claim or
misattribute a seat.** The knobs leak convenience; they no longer leak identity.

## Doctor

1. **The grant check inverts.** Today it fires only on `registeredGrant !== binding.grant`, so a
   _matching_ baked grant passes and an `agent`-written entry carrying no grant is silent even though it
   just clobbered a full one. After the strip, presence is the defect: any `MUSTERD_GRANT` or
   `MUSTERD_AGENT_KEY` in the entry is drift, match or not. This also closes the gap the mismatch-only
   form left.
2. **Remedies name `musterd wire`, not `musterd init`.** Checks 1-3 (baked claim / model / secret) all
   mean "the entry disagrees with binding.json" — exactly what `wire` fixes headlessly, with no member
   minting and no guard trip. `--fix` routes entry-only drift to `wire` instead of `runInit()`.
3. **`assertEntryIdentity` is deleted** (`packages/cli/src/onboard/entryGuard.ts:62`). It compares entry
   secrets against binding secrets; once the entry holds no secrets there is nothing to compare. It is
   already dead in production despite ADR 158 §6 claiming the doctor calls it, so deleting it also
   removes a false claim from the record. `foreignAdapterNote` in the same file stays — it is live at
   `doctor.ts:227`.

## Repair path

Because the slot is shared, **one `musterd wire` repairs the whole family.** The first seat to run it
rewrites the single entry seat-agnostically; every sibling inherits the fix. No per-worktree visit.

## Testing

- `buildMcpEnv` emits no secrets and no server/team/surface — extends the ADR 158 regression at
  `packages/cli/src/onboard/onboard.test.ts:33`.
- Doctor flags a baked grant **when it matches** binding.json. The existing assertion at
  `doctor.test.ts:216` asserts this case is quiet; that assertion inverts.
- Doctor remedy text names `wire`; `--fix` on entry-only drift does not call `runInit`.
- **The untested surface:** two sibling worktrees, `init` in each, assert the resulting entries are
  byte-identical. This is the regression that would have caught the class. No current test covers two
  worktrees sharing one entry.
- Adapter: a folder with `binding.json` and empty env resolves server, team, agent_key and grant —
  pins the safety table above.

## Observability & Evaluation

- **Signal that it worked:** zero `expired_grant` / grant-mismatch drift reports across the `agents-*`
  family after one `wire`. Today every seat but the slot-holder reports drift by construction.
- **Regression tripwire:** the byte-identical-entries test fails the moment any writer re-introduces
  per-seat env.
- **Audit:** claim denials attributable to a mismatched grant should go to zero; `claim.reseated` and
  approval-lane volume for family seats is the proxy to watch.
- **Known blind spot:** `MUSTERD_AUTOJOIN` / `MUSTERD_DRIVER` leakage stays unmeasured until increment 2.
  Driver co-presence for family seats should be treated as unreliable until then.

## Impact worth recording in the ADR

The `agent_key` half means a seat may currently be booting with a **sibling's team agent key**, not only
a sibling's grant. Same fix; broader observed blast radius than the lane's original framing.
