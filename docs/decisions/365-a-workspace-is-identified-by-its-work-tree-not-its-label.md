# 365 — A workspace is identified by its work tree, not by the label the roster shows

- Status: accepted
- Date: 2026-09-03
- Relates to: ADR 068 (workspace-scoped displacement), ADR 092 (a same-workspace successor ends its
  predecessor, durability-gated), ADR 017 (newest-wins), ADR 014 (the where-on-attach seed), ADR 177
  / `repoProject` (project identity is worktree-INvariant, deliberately the opposite invariant)
- Lane: `01M1JQYYACGWEDYSFHPQ3C3SEA`

## Context

ADR 068 scoped single-active displacement by "workspace" and ADR 092 gated the eviction on
durability, so that a reload successor kills its orphan while a health-check probe never flaps the
live seat. Both read one field: the `workspace` string the client sends on its claim frame.

That field was never an identity. It is the **where-on-attach seed** of ADR 014 — a
gracefully-degrading label, rendered dim on the roster, documented in `mcp/src/workspace.ts` as
"approximately right by design, not an authoritative scope". Its ladder is: a declared
`MUSTERD_WORKSPACE`, else the cwd folder name qualified with the *git branch* when the branch is
informative, else the cwd subpath, else the bare folder.

The qualifier is the problem. A branch is not a property of a session; it is a property of the
session's next `git switch`. So the label **changes under the session that holds it**:

- `agents-dolly@main` while on a named branch,
- `agents-dolly` the moment HEAD detaches — which is what reviewing a merge SHA, bisecting, or
  `git switch --detach origin/main` does, several times an evening on a seat that reviews.

`ws.ts` then compared that label with `===` and treated inequality as "a genuinely different session
on another machine or branch". A seat's own next attach therefore read as foreign, ADR 092's
same-workspace path was never taken, and the live session was evicted with
`claim.superseded {same_workspace: false, via: 'ws'}` — the cross-workspace branch, which
deliberately does **not** set `same_workspace`, so the displaced adapter stayed dormant instead of
exiting cleanly. The seat lost its session and left an orphan behind, which is precisely the failure
ADR 092 was written to end.

Measured on this machine, 2026-09-02 (`target = dolly`): `presence.attached` at 21:11:31 with
`workspace = agents-dolly@main`, then attaches at 21:14:45, 21:14:51 and 21:15:05 with
`workspace = agents-dolly`, each paired in the same second with a `claim.superseded
{same_workspace: 0, via: ws}`. Same seat, same folder, same daemon, one HEAD detach between them.

Two earlier diagnoses were wrong and are worth recording, because both are the kind of story the
audit log can support if you stop reading one column too early:

- **"The CLI qualifies the label and the MCP adapter does not"** — false. Both surfaces run the same
  ladder (`resolveClaimWorkspace` in the CLI, `resolveWorkspace` in the adapter): the CLI emitted
  `agents-dolly@main` at 17:42:42 and the adapter emitted the bare label at 21:15:05. The split is
  named-branch vs detached HEAD, on either surface.
- **"A hook process evicts the live adapter"** — the hook is usually the process that attaches next,
  so it appears in every eviction pair, but a hook attaching from the same worktree on the same
  branch never evicted anything. The hook was the messenger.

## Problem

Displacement needs to answer one question — *is this the same workspace?* — and the only field it
had was one that changes for reasons that have nothing to do with the answer.

Widening the comparison (compare only the part before `@`) was rejected: it makes two different
checkouts whose folders happen to share a basename — `~/one/repo` and `~/two/repo` — compare equal,
which silently turns a real cross-session eviction into coexistence. The label cannot be repaired
into an identity; it can only be replaced by one.

## Decision

**Displacement compares a workspace identity, not the display label. The claim frame carries both.**

1. **`resolveWorkspaceKey` (`@musterd/protocol/project`)** is the identity: a declared
   `MUSTERD_WORKSPACE` wins (an override names the workspace on both axes), else the **git work tree
   root** (`--show-toplevel`), else the cwd. It never throws and never blocks.
2. **The claim frame gains `workspace_key`** alongside `workspace`. The label keeps its ADR 014 job
   — it is what the roster renders, branch qualifier and all — and loses its second, unearned job.
3. **`ws.ts` compares `workspace_key` when both sides carry one, and falls back to exact label
   equality when either does not.** An un-rebuilt dist is therefore no worse off than before this
   ADR, and no better: the fallback is today's behaviour exactly, not a widened version of it.
4. **One resolver, two clients.** The MCP adapter and the CLI each had a private copy of the label
   ladder; the key lives in `protocol` and both import it, so the two surfaces cannot drift on the
   field that now decides evictions.

Note the deliberate asymmetry with `repoProject` (ADR 177), which resolves `--git-common-dir` so
that N seats on one repo share one project surface. Project identity must be worktree-INvariant;
workspace identity must be worktree-SPECIFIC, because two seats on one repo are two workspaces.
Same repo, opposite invariants, and picking the wrong one in either place collapses something that
must stay separate.

## Consequences

- A seat may switch branches or detach HEAD freely; its own re-attach is recognised as the same
  workspace and takes ADR 092's durability-gated path (grace, then reap the orphan with
  `same_workspace: true`, which is the signal that makes a replaced adapter exit rather than linger).
- Two checkouts of one repo are now correctly distinguished even when their folder names match — a
  collision the label could not see and would have resolved as "same workspace" under any
  normalising fix.
- **Mixed-version window, stated rather than hidden:** a session whose dist predates this change
  sends no key, so a pair where either side is old still compares labels and can still evict across
  a branch switch. The daemon and both clients ship from one repo and are rebuilt together, so the
  window is a rebuild, not a release cycle.
- The label is now used for exactly what ADR 014 designed it for. If a future reader wants to change
  how it degrades, they no longer have to reason about whether it will evict anyone.

## Observability & Evaluation

- Falsifier, server: `transport/integration.test.ts` — "a re-attach whose LABEL changed but whose
  workspace_key did not is the same workspace" (no `claim.superseded … via: ws` row is written), and
  "two different work trees whose folders share a name are still different workspaces" (the
  incumbent *is* superseded). A third case pins the old-client fallback.
- Falsifier, protocol: `project.test.ts` — the key survives a branch switch, a detached HEAD, and a
  subdirectory; differs between two work trees; honours a declared override.
- Falsifier, live: after this lands, run
  `sqlite3 -readonly ~/.musterd/musterd.db "select datetime(ts/1000,'unixepoch','localtime'), action,
  json_extract(detail,'$.workspace'), json_extract(detail,'$.same_workspace') from audit where
  target='<seat>' and action in ('presence.attached','claim.superseded') order by ts desc limit 20"`
  across a HEAD detach. A `claim.superseded {same_workspace: 0, via: ws}` paired with an attach from
  the same worktree falsifies this ADR.
