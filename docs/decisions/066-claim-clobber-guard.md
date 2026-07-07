# 066 — A clobber guard on `claim`/`init` for live-bound folders

- Status: accepted — amended by [ADR 105](105-clobber-guard-honors-reclaim-grace.md) (the guard also honors the ADR 010 reclaim-grace window)
- Date: 2026-06-29

## Context

ADR 065 removed the _need_ to clobber a seat by giving each agent its own worktree (`musterd agent
<name>`), and explicitly left one follow-up open (065 Consequences): a **guard** on the plain
`claim`/`init` paths that still silently repoint a folder's binding.

The hole: `musterd claim <name>` writes `.musterd/binding.json` for the folder unconditionally
(`claim.ts` → `saveBinding`). When the folder is already bound to a _different_ member who is **live
right now**, the claim evicts them with no warning — both sessions then resolve to one working tree,
which is exactly the identity-thrash collision ADR 065's worktrees exist to prevent. The 2026-06-29
dogfood hit this directly: a human (Nick) and an agent (June) sharing `/Users/nick/agents`. `init`
already _warns_ before repointing a bound folder (ADR 020 `inspectInitTarget`), but `claim` — the
command a second actor actually reaches for — was silent.

Reclaiming a **stale** seat (the bound member is offline) is legitimate and common, so the guard must
fire on _liveness_, not on the mere presence of a prior binding.

## Decision

- **`liveBindingClobber(binding, members, target)`** (`onboard/guard.ts`) — a pure, roster-driven
  predicate: returns the bound member to warn about (with its live workspace, when known) when the
  folder's current binding points at a **different** member whose roster `presence`/`activity` is not
  `offline`; returns `null` otherwise. Re-occupying the folder's _own_ seat (`target === bound`) is
  never a clobber. Pure + injected roster ⇒ unit-testable without a daemon.
- **`musterd claim` refuses a live clobber** (`claim.ts`), checked **before any mint** so a refused
  claim leaves no orphan seat. The error names the runnable next step (ADR 055 no-dead-end):
  _give the new agent its own workspace with `musterd agent <name>`, or claim from a separate
  worktree_. **`--force` repoints anyway** for the deliberate case.
- **`init` carries the same guidance**: its existing bound-folder warning now points at
  `musterd agent <name>` / a separate worktree as the isolation-preserving alternative.

## Consequences

- A second actor can no longer silently steal a live teammate's folder binding; the failure mode that
  needed ADR 065 is now also caught on the low-level path, not just designed around.
- Reclaiming a genuinely-offline seat is unaffected (the common, safe case stays frictionless), and
  `--force` keeps the escape hatch for an intentional repoint.
- The guard runs pre-mint, so a refused `claim <name>` does not leave a half-created member behind.
- Composes with ADR 018/020 (per-folder binding + folder-suitability guard), ADR 055 (no-dead-end
  conflicts), and ADR 065 (one-command isolated workspaces — the recommended fix the guard points to).

## Observability & Evaluation

**Traces** — `claim`/`init` are local provisioning commands and emit no coordination acts. The
attributable event is the **guard outcome**: a span field `clobber_guard ∈ {clear, refused, forced}`
on a claim, plus the bound member it would have evicted and whether that member was live. The
downstream team-timeline signal is the _absence_ of a displaced presence: a clean second-actor onboard
emits its own `join` (ADR 051) without flipping another member offline mid-session.

**Eval** — success metric: of claim attempts into a folder already bound to a **live** different
member, the fraction that are stopped (or consciously `--force`d) rather than silently clobbering —
target 100% stopped-or-forced, 0 silent evictions. **Dataset**: two-actor onboarding runs on a dev
machine (the same dogfood corpus behind ADR 065), partitioned by bound-member liveness so the
offline-reclaim case is verified _not_ to regress. **Baseline**: pre-066 `claim`, where every such
claim repoints silently (the 2026-06-29 shared-folder collision). Unit coverage in
`claim.test.ts`: refuse-on-live-clobber (no seat minted, binding intact), `--force` repoints,
offline-bound is allowed, and own-seat re-occupy is never guarded.

**Experiment** — named, not yet built: once batond lands, A/B the guard (on vs `--force`-always) across
seeded two-actor onboarding runs and measure clobber-incident rate and time-to-first-clean-`join` — does
refusing-by-default cut "actors fight over one binding" (a MAST coordination failure mode) without
slowing legitimate stale-seat reclaim?
