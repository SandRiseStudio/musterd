# 143 — A seat's identity is anchored to the workspace it runs in

- Status: accepted — 2026-07-13
- Date: 2026-07-13

## Context

On 2026-07-13, **every live agent session on the machine silently became the same seat.**

`musterd agent dolly`, run from the shared repo root, registered the MCP server for the new worktree and set

```
MUSTERD_BINDING=/Users/nick/agents-dolly/.musterd/binding.json
```

in Claude Code's **local**-scope MCP config. `agent.ts` believed that `chdir`-ing into the worktree first
scoped the registration to it — the code says so, in a comment:

> _"We chdir into `ws.dir` first because the harness `configure` writes relative to cwd (`claude mcp add -s
local` keys off it…)"_

**That assumption is false.** Claude Code keys its local scope by **repo root**, not by cwd. Every seat
worktree (`agents-miley`, `agents-izzo`, `agents-dolly`, …) is a `git worktree` of the _same_ repo, so they
**all share one MCP entry** — and `MUSTERD_BINDING` was therefore a single global slot that each
`musterd agent` overwrote.

The result: provisioning _one_ seat re-pointed _every live session on the machine_ at that seat. Every
adapter booted as `dolly`. Because a seat is single-active, the daemon then superseded those sessions
against each other — `superseded: your session as "dolly" was taken over by a newer one` — and two agents
lost their identity **mid-task**, in the middle of unrelated work. Neither noticed for some time, because
nothing failed loudly: the seat resolved, the tools worked, they were just _someone else_.

Two things made it worse than a bad env var:

- **It is silent.** An identity swap has no natural failure mode. Work proceeds; it is simply attributed to,
  and authorised as, the wrong seat.
- **It escalates.** `resolveBindingDir` decides where a claimed seat is **written back to disk**. An adapter
  that adopted a sibling's binding would, on its next claim, overwrite _that sibling's_ `binding.json` with
  its own seat — turning a transient env leak into the persistent [ADR 065] provisioning clobber.

The env var was not even load-bearing here. The adapter already anchors on the `.musterd/binding.json` it
finds by **walking up from its own cwd**, and the harness sets that cwd to the session's workspace — a
signal that is genuinely per-worktree, unlike the shared config.

## Decision

**A seat's identity is anchored to the workspace it is running in.** Stated as the invariant the code now
enforces:

> **If the workspace you are running in has its own seat, that seat is who you are.**

Two layers, because either alone is insufficient.

### 1. Stop creating the leak (`cli/commands/agent.ts`)

`musterd agent` **no longer writes `MUSTERD_BINDING`** into the harness MCP entry. The adapter anchors by
cwd. Omitting the var makes the shared (repo-root-keyed) entry **identical for every seat**, and therefore
harmless — the entry no longer carries identity at all.

### 2. Make it impossible to re-create (`mcp/binding.ts`)

Fixing only the writer would leave the hole open to any other writer — a stale config, a hand-edit, a future
harness, a `.bak` restored by mistake. So the **adapter refuses a cross-workspace identity outright**:

- If `MUSTERD_BINDING` points at a workspace **other than the one the adapter is running in**, _and_ the
  adapter's own cwd walk-up finds a `binding.json`, the env is a **leak by definition** — refuse it, log
  loudly to **stderr** (never stdout: that is the MCP stdio transport), and use the workspace's own binding.
- The guard applies to `resolveBindingDir` too, so a leak can never be _persisted_ into a sibling worktree.

**Genuine host injection is untouched.** A workspace with _no_ seat of its own still honours
`MUSTERD_BINDING` — which is the only case the variable ever existed for (ADR 018/115: a host injecting an
identity into a bare workspace). The ADR 018 env-over-binding ladder is preserved exactly where it makes
sense, and refused exactly where it cannot possibly be legitimate.

## Consequences

- **Provisioning a seat can no longer change any other seat's identity.** The blast radius of
  `musterd agent` is now the worktree it names.
- **A stale or malicious `MUSTERD_BINDING` cannot steal an occupied workspace's seat**, regardless of who
  wrote it or how it got there. This is the property that makes the fix permanent rather than a cleanup.
- **The failure is now loud.** The refusal prints the env path, the workspace it belongs to, and the
  workspace that refused it. The original incident's defining feature was its silence.
- **Existing leaked configs self-heal.** An adapter carrying the stale var now ignores it and anchors
  correctly; no manual `~/.claude.json` surgery is required (the incident was first stopped by exactly that
  surgery, which would have been undone by the next `musterd agent`).
- **A live session still needs an adapter restart to recover.** The adapter reads its env once, at boot, so
  a session already running under a leaked binding must reload MCP (`/mcp`) to pick up its own seat. That is
  a property of harness process lifecycle, not of this fix.
- Related: [ADR 018] (identity anchoring), [ADR 065] (agent workspace / the sibling-clobber precedent),
  [ADR 115] (adapter identity anchoring), [ADR 131] (the host actuator, whose `dolly` wake rehearsals
  surfaced this).

## Observability & Evaluation

- **Traces:** the refusal is emitted on **stderr** from the adapter, carrying the rejected path, the
  workspace it belongs to, and the workspace refusing it — which is the signal that was missing entirely
  during the incident (an identity swap otherwise has no failure mode). It is not a protocol act: the
  adapter refuses _before_ it has an authenticated identity to send one with, so there is nothing to
  attribute an act to. The consequences of a leak that does occur remain visible in the existing audit
  trail — `claim.occupied` rows and the supersession that ADR 068/108 already record.
- **Eval:** n/a — no agent-facing model decision and no dataset to score. This is a correctness invariant,
  and it is asserted mechanically instead: `mcp/src/seat-identity-guard.test.ts` reproduces the **actual
  incident** (two sibling seat worktrees of one repo; one adapter handed the other's binding) and pins both
  halves — the leak is refused for reads _and_ for write-back — plus the four cases the guard must **not**
  break (bare-workspace host injection, a self-naming env, no env at all, resolution from a subdirectory).
  `cli/commands/agent.test.ts` asserts the provisioner no longer emits the variable; that assertion is the
  literal inverse of the one it replaced, which is what let the bug ship.
- **Experiment:** n/a — no behavioural variant and no flag. A correctness fix, verified end-to-end against
  the real leaked value on the real worktrees: with
  `MUSTERD_BINDING=<...>/agents-dolly/.musterd/binding.json` and cwd `<...>/agents-miley`, the adapter now
  resolves `miley` and writes back to `miley`.
