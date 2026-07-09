# 115 — Anchor the MCP adapter's binding writes (no ambient-cwd clobber; re-read on re-seat)

- Status: accepted — 2026-07-08
- Date: 2026-07-08

## Context

Two live identity bugs surfaced while provisioning a second agent (`ryder`) with `musterd agent`, both
in the MCP adapter's binding handling (reported from the dogfood team, related to the issue-#118
reload-orphan class):

1. **Ambient-cwd binding clobber (data loss).** After occupying a seat, the adapter persisted the
   resolved binding with `saveBinding(process.cwd(), …)` ([`mcp/src/claim.ts`](../../packages/mcp/src/claim.ts)).
   `process.cwd()` is where the *adapter process* happens to be, which is **not** guaranteed to be the
   worktree the session's identity was resolved from. When an adapter's cwd was a **sibling worktree**,
   the claim wrote its own seat's `binding.json` into that sibling — observed concretely: after
   `musterd agent ryder`, `agents-ryder/.musterd/binding.json` and `agents-stanley-izzo/.musterd/binding.json`
   became byte-identical (both `seat=ryder`), overwriting izzo's identity. The next autojoin from the
   izzo worktree then came online as `ryder`.

2. **Boot-grant pinning (in-session repair invisible).** `loadMcpConfig` reads the binding **once** at
   launch; the resolved grant/key live in the in-memory `config` for the process's life. So after (1)
   was repaired on disk (`musterd agent izzo --path <worktree>` re-provisioned a correct binding with a
   distinct grant), a running session's `team_join {as:izzo}` still presented the **stale boot grant**
   — rejoining as the wrong seat, or getting refused (`grant is for seat "ryder"`). Only a full MCP
   reconnect picked up the corrected `binding.json`. An in-session identity repair was invisible.

Both trace to the adapter treating **ambient process state** (cwd, boot-time in-memory config) as the
identity source, rather than the workspace's `binding.json` — which ADR 018 designates the single
source of truth.

## Decision

Anchor the adapter's identity to the **resolved workspace directory**, not ambient process state.

1. **`config.bindingDir` — the identity anchor.** `loadMcpConfig` records the directory the `.musterd/`
   that seeded this config was found in, via a new `resolveBindingDir()` that mirrors `findBinding`'s
   precedence: an explicit `MUSTERD_BINDING` path (→ its workspace root), else the nearest ancestor
   holding `.musterd/binding.json`, else the nearest holding `.musterd/workspace.json`, else the start
   dir. `persistBinding` writes to `config.bindingDir` — **never `process.cwd()`**. A claim can no
   longer escape the workspace it was resolved from, so a wandering cwd cannot clobber a sibling.

2. **Re-read `binding.json` before an explicit named claim.** `claimAndJoin`, when the target is a
   named seat, re-reads the freshest on-disk binding from `config.bindingDir`; if it now targets **that
   same seat**, it adopts that binding's grant/key/surface before joining. An in-session binding repair
   (a re-provisioned grant) therefore takes effect on the next `team_join {as:X}` without a process
   restart. A binding for a *different* seat is left untouched — the adapter never silently borrows
   another seat's grant (a mismatch stays a loud server refusal, which is correct).

Scope: the ambient `saveBinding(process.cwd(), …)` calls in the **CLI** (`join`/`claim`/`wire`/`team`/
`init`) are unchanged — those run in the folder the human explicitly `cd`'d into, where cwd *is* the
intended target. The bug was specific to the long-lived adapter, whose cwd is set by the harness, not
the user.

## Consequences

- **A second agent can be provisioned without corrupting a sibling's identity.** The `musterd agent`
  one-command flow (ADR 065) is safe to run repeatedly across worktrees.
- **In-session identity repair works.** Fixing a clobbered/rotated binding on disk no longer requires a
  full MCP reconnect; the next explicit re-seat picks it up.
- **`binding.json` is honoured as the source of truth** at claim time, not just at boot — closing the
  drift ADR 018 always intended to prevent.
- The `musterd agent --harness` work (a follow-up) reinforces this: pointing `MUSTERD_BINDING` at each
  worktree's absolute binding path makes `bindingDir` exact, independent of cwd.
- Residual: a session with **no** binding/spec file on its walk-up path still falls back to the start
  dir — unchanged behaviour, and no worse than before, but such a session shouldn't be persisting a
  seat anyway.

## Observability & Evaluation

**Traces** — the clobber leaves an on-disk signature (two byte-identical `binding.json` files under
sibling worktrees) and an audit trail: the wrong-seat autojoin shows as a `claim.occupied` for the
clobbering seat sourced from the victim's workspace. `n/a` for `@musterd/telemetry` OTel spans — this
is client-side adapter state, not a server code path that emits spans.

**Eval** — the metric is **cross-worktree binding clobbers** (sibling `binding.json` files that become
identical after provisioning a different seat) and **reconnect-to-repair events** (a full MCP restart
required to pick up a corrected binding). *Dataset:* the dogfood worktrees' `binding.json` files + the
`claim.occupied` audit rows joined to their source workspace. *Baseline:* this session — one live
clobber (ryder over izzo) and one forced reconnect. *Target:* zero clobbers and zero
reconnect-to-repair events after this change.

**Experiment** — before/after is the same repro: run `musterd agent <seat>` across two worktrees and
diff their `binding.json` files. *Before:* identical (clobbered). *After:* distinct — verified by a
unit test (`claim.test.ts` persists to `bindingDir`, not cwd) and an end-to-end reproduction (a claim
whose adapter cwd is a sibling worktree writes only its own anchor). If a clobber recurs, the anchor
resolution (`resolveBindingDir`) is the single place to inspect.
