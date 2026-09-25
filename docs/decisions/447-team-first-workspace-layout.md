# 447 — Workspace layout is team-first: `~/musterd/<team>/<repo>/<member>`

- Status: accepted — 2026-09-25, by nick in session ("lets go with your recommendation and im fine
  with being another migration - i want the best solution").
- Date: 2026-09-25
- Lane: `01M3CWP8TT6VQSZDCF17TB3PKM`
- Supersedes: the layout note of [ADR 442](442-the-wall-seats-reach-no-session-outside-the-seat-set.md)
  (reach spec §6, `~/musterd/<repo>/<member>`), and [ADR 176](176-the-team-home.md)
  §1's placement of the human's binding _at_ `~/musterd/<team>`. Neither decision is reversed in
  spirit — identity still resolves only from a binding, and the person still has a designated floor —
  but where those things sit changes, so both carry a dated note.

## Context

Reach spec lane 3 (2026-09-25, #1703) moved every member Workspace on nick's laptop onto
`~/musterd/<repo>/<member>`: `~/musterd/agents/dolly`, `~/musterd/agents/nick`, sixteen in all,
with the daemon's checkout unbound at `~/.musterd/runtime`. The same day nick asked two questions
about the shape that had just landed: does a project have to live inside `~/musterd` to use
musterd, and what happens when two teams work on one repo.

The first answer is no — identity walks up from any folder to the nearest `.musterd/binding.json`,
so `~/musterd/<repo>/<member>` is only where `musterd agent` _puts_ a seat by default. The second
answer exposed a real gap.

## Problem

A member name means one thing only on its team. `dolly` on `revive` and `dolly` on some other team
are two Members with two bindings, and the layout has to give each a folder. `~/musterd/<repo>/<member>`
has no team in it, so:

1. Two teams sharing a repo and a member name collide at `~/musterd/<repo>/<member>` — the second
   `musterd agent dolly` reuses the first team's Workspace, and its binding is silently repointed.
2. The team home `~/musterd/<team>` (ADR 176) sits at the same level as the repo groups. A team
   named after a repo — `agents` — is a folder that is both, and nothing says which.
3. A team's members are scattered across every repo group, while the team's own folder is a leaf
   beside them. One team, two roots.

Fixing this inside the existing shape (a `<team>-<member>` fallback on collision, or refusing and
asking for `--dir`) leaves two layouts on one machine, which is the thing that makes a layout rule
unenforceable.

## Decision

1. **The layout is `~/musterd/<team>/<repo>/<member>`.** Team outermost, then the repo, then the
   member — humans and agents alike, each a `git worktree` of that repo (or a plain folder when the
   member is stood up outside git with `--path` / `--home`). `~/musterd/revive/agents/dolly`.
2. **The first three levels under `~/musterd` are roofs and never hold a binding.** `~/musterd`,
   `~/musterd/<team>` (the team root) and `~/musterd/<team>/<repo>` (the repo group) are refused by
   `bindingRefusal` (`onboard/guard.ts`) by position — even while empty — in addition to the ADR 442
   rule that refuses any folder with a Workspace up to two levels beneath it. Only the fourth level,
   the member, is a Workspace.
3. **The team root is the roof over one team's trees, not the human's floor.** `~/musterd/<team>`
   keeps what ADR 176 gave it that is not identity: it is the visible place a person `cd`s into, and
   on a file-backed team it is the roster repo (`rosterHome`, ADR 058). Its binding goes. The person
   stands in a member Workspace like everyone else: `musterd human <name>` places them at
   `~/musterd/<team>/<repo>/<name>` — a `git worktree` on `human/<name>` when run inside the project's
   checkout, keeping their own git identity (ADR 109's synthetic seat identity is for agents) —
   and, outside a repo, requires `--home <dir>`. There is no default floor at the root. The recorded
   `teamHome[slug]` config key keeps its meaning — where the human stands — and now names that
   Workspace.
4. **`memberWorkspaceDir(top, name, team, home, remote)`** places a new seat under
   `~/musterd/<team>/<repo>/`, where `<repo>` is the group the invoking checkout already sits in
   _when it is a member Workspace of the same team_, else the remote's repo name, else the checkout
   basename. A checkout from another team's tree does not lend its group: `other` gets its own
   `~/musterd/other/<repo>/` of the same repository.
5. **One migration, run once, by the human, announced.** `scripts/layout/migrate.ts` (dry-run by
   default, `--apply` to execute) moves every bound member Workspace two levels beneath `~/musterd`
   to its team's tree, deletes each team root's `.musterd/binding.json` — refusing when the person
   bound there has no member Workspace of that team to stand in instead — repairs `git worktree`
   parentage from each moved Workspace's own main checkout, re-keys the bindings registry (and
   `teamHome`), the host registry, the harness ledger, `~/.claude.json` and the
   `~/.claude/projects/<slug>` transcript folders, tells a roster-repo root to ignore the trees
   beneath it, and bounces only the host and any LaunchAgent whose plist names a moving folder. The
   daemon is not bounced: its checkout does not move.

## Alternatives considered

- **`~/musterd/<repo>/<team>/<member>`.** Repo outermost. Rejected: a team then has no single root —
  its members are spread across every repo folder and its roster repo sits somewhere else — and
  `~/musterd/<repo>` becomes a mixed folder where the guard has to know whether a child is a team or
  a member. Team-first keeps one root per team and matches the `~/musterd/<team>` ADR 176 already
  chose.
- **Keep `<repo>/<member>` and fall back to `<repo>/<team>-<member>` on collision.** Nothing moves,
  but two shapes coexist, and the guard's position rule (Decision 2) cannot be stated.
- **Refuse on collision and ask for `--dir`.** Smallest change; pushes the problem onto the person
  the moment it appears, which is the moment they least want to design a layout.
- **Keep the human at the team root and exempt it from the beneath-scan.** That is exactly the
  binding-above-a-Workspace ADR 442 forbids: every unbound folder under `~/musterd/revive/` —
  a scratch clone, a half-provisioned seat — would act as nick.

## Consequences

- Paths gain a segment: `~/musterd/revive/agents/dolly`. Every open seat session on this machine
  restarts from its new folder after the move; `claude --resume` finds its transcripts because the
  project slug moved with it.
- The human's binding leaves `~/musterd/<team>`. On this machine nick already stands in a member
  Workspace (`~/musterd/agents/nick` → `~/musterd/revive/agents/nick`), so nothing is minted. A
  fresh machine's first `musterd human` must run inside a checkout (or pass `--home`).
- `install-topology.md` §4–5 and README's glossary line ("the human stands in the team home") are
  historical: the team home is the team's root; the person stands in a member Workspace beneath it.
  The design doc stays as written (it froze when ADR 176 landed); README is corrected here.
- A team root that is a git repo (the roster) gains a `.gitignore` rule for `/*/` so the member
  Workspaces beneath it never show as untracked roster changes. Git resolves each Workspace to its own
  `.git` file, so nesting is otherwise inert.
- `setSeatGitIdentity` is now opt-out (`gitIdentity: false`), and `provisionWorkspace` takes a
  `branch` — both for the human's Workspace. Agent provisioning is unchanged.
- Falsifier: `musterd whoami` from `~/musterd/revive` after the move must print "not bound"; from
  `~/musterd/revive/agents/<seat>` the seat. `musterd agent x --team other` from a `revive` Workspace
  must land at `~/musterd/other/<repo>/x`, never under `revive/`.

## Observability & Evaluation

- Traces: none new. `bindingRefusal` refusals print their reason and exit 2; the migration prints
  every path it moves and every file it rewrites, and backs each file up under
  `~/.musterd/backups/layout-<ts>/`.
- Eval: n/a — a filesystem layout, not agent-facing behaviour. The falsifiers in Consequences are
  the check.
- Experiment: none.
