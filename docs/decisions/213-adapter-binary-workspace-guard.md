# 213 — Warn when the adapter binary belongs to a different seat workspace than its identity

- Status: accepted
- Date: 2026-08-03
- Builds on: [ADR 143](143-seat-identity-anchored-to-workspace.md) (env→identity cross-worktree
  seat leak), [ADR 115](115-adapter-identity-anchoring.md) (binding writes anchored to the
  resolved workspace), [ADR 018](018-workspace-binding.md) (cwd walk-up identity)
- Prompted by: lane `01KZ4PK0051CYGBNBVRYZK6ZF5` — measured 2026-08-03 while diagnosing the
  attestation gap (PR #605)

## Context

ADR 143 closed the leak where `MUSTERD_BINDING` pointed at **another** seat's workspace while the
adapter's cwd belonged to this one. The inverse shape was still open.

Measured 2026-08-03 13:37: pid 12712 was running

`/Users/nick/agents-miley/packages/mcp/dist/index.js`

with `cwd = /Users/nick/agents-izzo` and **no** `MUSTERD_*` env. Identity walks up from cwd, so the
process occupied **izzo** while executing **miley's** checkout — a working seat whose binary and
identity disagree about who it is.

ADR 143's guard fires only when the env names a foreign binding. It has nothing to say when the
_binary_ is the foreign one. That is one step from the same silent mis-attribution: the tools work;
the wrong code (stale build, half-merged branch, sibling experiments) acts as the local seat.

Genuine cases that must stay quiet:

- a **global / Homebrew / npm** `@musterd/mcp` install (module path has no seat `binding.json` on
  walk-up)
- the adapter module living **inside the same** seat workspace it resolves (including
  `node_modules/@musterd/mcp` under that workspace)

## Problem

There was no check that the seat workspace owning the running module matched the seat workspace
owning the resolved identity. Cross-worktree launches of a sibling's `packages/mcp/dist` therefore
booted cleanly.

## Decision

**Warn loudly when both sides are seat workspaces and they disagree; never refuse to boot.**

1. Walk up from the adapter module path (`import.meta.url`) for a `.musterd/binding.json`. That
   walk's workspace root is the **binary workspace**.
2. Compare it to `resolveBindingDir` (the **identity workspace**, already ADR 143–guarded).
3. If both exist and the roots differ → one stderr warning (never stdout — MCP stdio), naming both
   roots and pointing at ADR 213. Warn-once per process for the pair.
4. If the module path has no seat binding on walk-up → silence (packaged installs).
5. Do **not** exit, block `team_join`, or rewrite identity. Hard refusal would turn a diagnosable
   smell into a dead seat for every intentional shared-checkout launch; the same posture as the
   unattested-seat / contested-surface warnings (say it, keep working). A later increment can
   promote to refuse once provisioning always pins each seat to its own (or a packaged) binary.

## Consequences

- The measured miley-binary / izzo-cwd shape becomes visible on every boot.
- A seat MCP entry that points at another worktree's `dist/index.js` while binding locally (the
  reverse of ADR 143's env leak) surfaces the same way.
- Packaged installs and same-workspace `node_modules` paths stay quiet.
- Docs (`05-mcp.md`) record the check next to the ADR 143 guard so the two halves of the
  cross-worktree story live together.

## Observability & Evaluation

- **Traces:** stderr diagnostic only at adapter config load (not an act; not OTel). No new
  coordination act — identity resolution is local.
- **Eval:** regression tests in `packages/mcp/src/seat-identity-guard.test.ts` reproduce the
  measured shape (foreign module workspace + local identity → one stderr warn; packaged /
  same-workspace → silence). Baseline: the 2026-08-03 pid 12712 incident (silent boot).
- **Experiment:** n/a — unit regression against the measured shape is sufficient for this warn-only
  increment; a refuse promotion would need a provisioning audit first.
