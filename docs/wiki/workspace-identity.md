# Workspace identity

The workspace *label* on the roster and the workspace *identity* displacement compares are two different things, and a seat evicts itself for two months whenever they are the same field.

## The label is branch-qualified, so it changes under the session holding it (2026-09-02, lane 01M1JQYYAC; falsify: `resolveWorkspace` in `packages/mcp/src/workspace.ts` — check whether its qualifier can change without the process restarting)

`resolveWorkspace` (adapter) and `resolveClaimWorkspace` (CLI) build the same ladder: declared `MUSTERD_WORKSPACE`, else the cwd folder qualified with the git branch **when the branch is informative**, else the cwd subpath, else the bare folder. A detached HEAD is explicitly "not informative", so the qualifier disappears:

- on a named branch → `agents-dolly@main`
- after `git switch --detach origin/main` (reviewing a merge SHA, bisecting, rebasing) → `agents-dolly`

That is one session, one folder, two labels — and nothing about the session changed.

## Comparing that label with `===` made a seat's own re-attach look foreign (2026-09-02; falsify: the audit query below across a HEAD detach)

`ws.ts` scoped ADR 068/092 displacement on `old.workspace === frame.workspace`. Unequal meant "another machine or branch", which takes the cross-workspace branch: evict, and do **not** set `same_workspace`, so the displaced adapter stays dormant instead of exiting. The seat lost its live session and left the orphan ADR 092 exists to reap.

Measured on this machine, seat `dolly`: `presence.attached` 21:11:31 `workspace=agents-dolly@main`; attaches at 21:14:45 / 21:14:51 / 21:15:05 `workspace=agents-dolly`, each paired in the same second with `claim.superseded {same_workspace: 0, via: ws}`.

```sh
sqlite3 -readonly ~/.musterd/musterd.db "select datetime(ts/1000,'unixepoch','localtime'), action,
  json_extract(detail,'\$.surface'), json_extract(detail,'\$.workspace'),
  json_extract(detail,'\$.same_workspace') from audit where target='<seat>'
  and action in ('presence.attached','claim.superseded') order by ts desc limit 20"
```

Fixed by [ADR 368](../decisions/368-a-workspace-is-identified-by-its-work-tree-not-its-label.md): the claim frame carries `workspace_key` (the git work tree root, `resolveWorkspaceKey` in `@musterd/protocol/project`) and displacement compares that; the label keeps its ADR 014 job. Both sides missing a key fall back to label equality, so an un-rebuilt dist behaves exactly as before — the mixed-version window is a rebuild, not a release.

## Two wrong diagnoses this defect supported for a while, both from reading one column (2026-09-02)

- **"The CLI qualifies the label, the MCP session does not."** Both surfaces run the same ladder. The CLI emitted `agents-dolly@main` at 17:42:42 and the adapter emitted the bare label at 21:15:05. The split is named-branch vs detached HEAD, not CLI vs MCP. Falsify: group the audit rows by `surface` and check whether either surface only ever emits one shape — neither does.
- **"A hook process evicts the live adapter."** The hook is usually whatever attaches next, so it is present in every eviction pair; a hook attaching from the same worktree on the same branch evicted nothing. Falsify: find an eviction pair whose two labels are equal — there is none.

The shared shape: the evicting attach and the label change arrive in the same second, so whichever attribute you happen to be looking at is perfectly correlated with the eviction. Both stories fit every row. What separated them was asking which attribute could change *without the session changing* — only the branch could.

## The two git invariants point opposite ways, on purpose (2026-09-03; falsify: read `repoProject` and `resolveWorkspaceKey` in `packages/protocol/src/project.ts` — one resolves `--git-common-dir`, the other `--show-toplevel`)

- **Project** identity (ADR 177, `repoProject`) uses `--git-common-dir` so N seats' worktrees on one repo resolve to **one** project — otherwise surface-overlap detection switches itself off for the whole team.
- **Workspace** identity uses `--show-toplevel` so two seats on one repo are **two** workspaces — otherwise one seat's claim would read as same-workspace with another's.

Same repo, opposite invariants. Reaching for the familiar one is how a fix in either place silently collapses something that has to stay separate.

## Related

The general trap: a value documented as "approximately right by design" acquired a second job — an equality key — that its own docstring says it cannot do. Nothing failed loudly at the moment the second reader was added; the cost showed up as evictions months later, attributed to hooks, to branch switches, to daemon bounces. When a field's docstring disclaims precision, grep for `===` on it. See also [seat liveness](seat-liveness.md) and [wake leases](wake-leases.md).
