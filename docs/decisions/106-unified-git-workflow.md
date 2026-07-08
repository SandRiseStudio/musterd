# 106 — One git workflow for every musterd agent (enforced, not conventional)

- Status: accepted — settings applied 2026-07-07; CI + protection land with this ADR
- Date: 2026-07-07

## Context

musterd is built by a standing team of agents (AI and human) working in parallel, each in its own git
worktree on its own branch (ADR 065 workspaces, the lanes model ADR 083/084). That part works. What
did **not** work was everything downstream of "I have a branch":

- **Divergent sync approaches.** Agents variously rebased, merged `main` in, stashed, or force-pushed to
  catch a branch up — no single rule, so conflict resolution and history style drifted per agent.
- **Mixed merge methods.** All three GitHub merge methods were enabled; recent PRs squashed but older
  history is full of `Merge pull request …` commits — the practice converged informally but nothing held
  it.
- **Gates ran only locally.** `pnpm typecheck / test / format:check` were a **local convention**. There
  was **no CI** (`.github/` did not exist), so nothing verified them on a PR. Red and *flaky* code
  reached `main` — this very ADR's session opened by finding `main` intermittently red from a
  fixed-index test assertion that had merged unnoticed (fixed in #148).
- **Review was advisory, not required.** Cursor Bugbot reviews every PR, but `main` had **no branch
  protection**, so "wait for Bugbot" was a memory-trap agents sometimes skipped — a green Bugbot could
  not actually gate a merge.

The through-line: nothing was **enforced**, so each agent improvised, and the improvisations conflicted.

## Decision

One workflow, made the path of least resistance by GitHub settings so an agent cannot easily do it
another way. Two halves: what GitHub **enforces**, and the **playbook** agents follow.

### 1. The canonical loop

1. **One branch per lane, in a worktree.** `feat/<slug>` / `fix/<slug>` / `docs/<slug>`, branched from
   **current `origin/main`** (`git fetch` first). Worktree isolation is already the norm (ADR 065).
2. **Work, committing normally.** Intermediate commit hygiene does not matter — they are squashed away.
3. **Run the fast local gates before pushing** — `pnpm typecheck && pnpm format:check` (seconds). This
   is an **optional speed optimization**, not a required duplicate of CI (see §3): it catches the cheap
   failures before a push→CI round-trip. Agents do **not** reproduce the full CI locally.
4. **Open a PR and let it land itself.** `gh pr create …` then
   `gh pr merge <n> --squash --auto --delete-branch` — auto-merge waits for the required checks (§2) and
   squash-merges when they pass. The agent does not babysit or poll.
5. **Sync a stale branch by rebase, never merge.** If `main` moved and you need its changes (or GitHub
   flags a conflict): `git fetch origin main && git rebase origin/main`, resolve once, re-run the fast
   local gates, `git push --force-with-lease`. Rebase (not `merge main`) keeps the branch linear;
   `--force-with-lease` refuses to clobber a teammate's push. This is safe because a lane's branch lives
   in one agent's worktree and is squashed at merge — its history is throwaway.

### 2. What GitHub enforces (so the loop is the only easy path)

**Repository settings** (applied 2026-07-07):

- **Squash-only** — merge-commit and rebase-merge **disabled**; squash is the only button. Commit title
  = PR title, body = PR body (one clean `Title (#N)` commit per PR).
- **Auto-delete head branches on merge** — no more lingering/again-and-again-deleted branches.
- **Allow auto-merge** and **"update branch"** — so step 4 works hands-free.

**Branch protection on `main`:**

- **PR required** (no direct pushes), **linear history required** (matches squash-only), **no
  force-push, no deletion**.
- **Required status checks:** the CI job **`gates`** (§3) and **`Cursor Bugbot`**. A merge — including an
  auto-merge — cannot complete until both are green. This is what turns "wait for Bugbot" from
  convention into a rule.
- **Not required: "branch up to date before merge."** With many parallel agents that would be a rebase
  treadmill (every merge invalidates every other open PR). We accept that a PR can merge slightly behind
  `main` as long as its checks pass and it has no textual conflict. Semantic collisions that slip through
  (e.g. two PRs picking the same ADR number, as happened with 102→103 in #143) are caught by the lanes
  model (declared surfaces/dependencies, ADR 083) and by review — not by a merge-queue, which is a later
  option if this proves insufficient.

### 3. CI is the authority; local is a smoke test

`.github/workflows/ci.yml` runs on every PR and on `main`: `pnpm install --frozen-lockfile` →
`pnpm build` (workspace packages resolve to `dist/`, which is gitignored, so build precedes the rest) →
`pnpm typecheck` → `pnpm test` → `pnpm format:check`. The job is named **`gates`** — the stable string
branch protection requires.

The division of labor answers "won't agents waste time running gates both places?": **no, because local
≠ CI.** CI is the *only* thing that must pass — correctness never depends on an agent running anything
locally. The local run is a deliberately *smaller* fast subset (`typecheck` + `format:check`, no clean
install, no full cross-package test matrix) whose only job is to shorten the feedback loop. And with
auto-merge, the agent delegates the authoritative run entirely and walks away. So the local step is a
5-second smoke test, not a second full gate.

Note `pnpm test` (root `vitest run`) is the reliable invocation; `pnpm -r test` trips a cwd/include quirk
in `@musterd/telemetry` and must not be used in CI.

### 4. Where Bugbot actually lives

Cursor Bugbot is **not** configured in this repo — it is the **Cursor GitHub App**, installed on the
`SandRiseStudio` org and configured at **cursor.com/dashboard/bugbot**. It posts a `Cursor Bugbot`
commit status per PR. Recorded here because it was previously unfindable ("where is that configured?").
It occasionally reports **`skipping`** on binary-only diffs; protection treats a skip as non-blocking so
a docs/asset PR is never wedged.

## Consequences

- **One way to do it.** An agent branches, works, runs two fast local commands, opens a PR, sets
  auto-merge, and moves on. Rebase-to-sync is the single documented catch-up move. Nobody chooses a merge
  method or a sync strategy anymore — the repo chose.
- **`main` stays green and linear.** A red/flaky test or an unresolved Bugbot finding **cannot** merge.
  The class of failure that opened this session (a flaky test on `main`) is structurally prevented going
  forward.
- **Cost:** ~1–3 min of CI per PR, and the small chance a behind-but-conflict-free PR merges on a
  slightly stale base (accepted, per §2). If semantic-collision rate rises, a GitHub **merge queue** is
  the pre-agreed next step.
- **Admin bypass remains** for the human owner (break-glass); agents have no bypass.
- The playbook is mirrored into `AGENTS.md` (the primer every agent reads) so it is guidance, not just an
  ADR.

## Observability & Evaluation

**Traces** — every merge now leaves a first-party audit trail: the `gates` CI run and the `Cursor Bugbot`
status are recorded per commit/PR by GitHub Checks, and branch-protection decisions are in the repo audit
log. `n/a` for musterd's own OTel spans — this ADR governs the *development* pipeline, not a runtime code
path, so there is nothing in `@musterd/telemetry` to emit.

**Eval** — the metric this ADR moves is **red-`main` incidents** (a push to `main` whose `gates` run
fails) and **merge-to-`main` friction** (manual rebase/stash/conflict rounds per landed PR). *Dataset:*
GitHub's own check-run history on `main` + PR timelines. *Baseline:* this session — `main` intermittently
red from #142's un-reconciled test, plus the repeated manual branch cleanups and the 102→103 ADR-number
collision, all in a single day of unenforced flow. *Target:* zero red-`main` check runs after protection
lands; catch-up handled by the single documented `rebase --force-with-lease` step.

**Experiment** — the before/after is built in and already half-run: *before* = today's unenforced day
(one red `main`, one number collision, several manual cleanups); *after* = the same team on the enforced
loop. If red-`main` recurs or the stale-base merge bites, the escalation is a merge queue (§2) — itself a
one-setting experiment we can A/B.
