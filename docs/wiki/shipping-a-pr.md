# Shipping a PR

One enforced git loop (ADR 106): branch from fresh origin/main → PR → `gh pr merge --squash --auto --delete-branch` → sync by rebase + `--force-with-lease`, never merge — plus the two traps that stall or pollute it.

## The loop (ADR 106, enforced by branch protection since 2026-07-07)

Branch `feat/`|`fix/`|`docs/` from fresh `origin/main`; commits are throwaway (squash-merge). Fast local smoke only — CI is the authority. `gh pr create` → `gh pr merge --squash --auto --delete-branch`, walk away. Sync a stale branch by `git rebase origin/main` + `git push --force-with-lease`; never `merge main`, never bare `--force`. Required checks on main: `gates` + `Cursor Bugbot`; linear history; squash-only.

## Bugbot no-show (2026-07-08, PR #170, intermittent; falsify: check-runs list on a stalled PR)

Cursor Bugbot can silently never register its check-run (2026-07-08, PR #170; intermittent — #167 minutes earlier ran normally): `gates` green for 20+ minutes while auto-merge waits on a check that does not exist, and nothing alerts. If a PR sits OPEN with `gates` SUCCESS and no `Cursor Bugbot` entry in `gh api repos/…/commits/<sha>/check-runs`, comment `bugbot run` on the PR — it registers and completes within ~90s (neutral conclusion = clean, auto-merge fires).

## A conflicted PR gets ZERO check-runs (2026-08-13, PR #793; falsify: open a PR with a conflict and list its check-runs)

GitHub never creates the pull_request CI run for an unmergeable (mergeStateStatus DIRTY) PR, so auto-merge waits on nothing forever — the same stalled-OPEN symptom as the Bugbot no-show but a different cause and fix. Diagnose with `gh pr view --json mergeStateStatus`; fix by rebasing onto origin/main + `--force-with-lease`, not by `bugbot run`. Corollary: branching from a stale or sibling branch invites this — branch from `origin/main` explicitly (`git checkout -b <name> origin/main`); `git checkout main` fails silently useless in a worktree checkout where another worktree holds main.

## After the merge, the branch you are standing on lies (2026-08-13; falsify: `git status -sb` in a worktree after an auto-merge landed)

`--delete-branch` removes the remote, so the local branch is left tracking a `[gone]` upstream. `git pull` there fails outright (`no such ref was fetched`) — loud, and therefore harmless. The dangerous half is quiet: **every command that reads the working tree instead of a ref keeps answering, from a snapshot of main that stopped moving when you merged.** It bit a measurement script the same day, which counted the wiki off a post-merge worktree and reported 24 pages / 52,849 B / 8 commits against `origin/main`'s real 25 / 59,384 / 10 — understating a teammate's contribution threefold.

Anything that measures or reports on the repo should name the ref: `git fetch origin` first, then `git ls-tree origin/main <path>` and `git log origin/main`, never `ls`/`cat`/`git log` over the checked-out tree. To resume work, branch afresh (`git checkout -b <name> origin/main`) rather than pulling.

`pnpm format` writes `**/*.{ts,js,mjs,json,md}` but `format:check` only checks `packages/**/*.ts`, `tests/**/*.ts`, `*.{ts,json}` — the committed markdown/json was never prettier-conformant, so `pnpm format` reflows ~100 unrelated docs, burying the real change and breaking `roadmap:check`. Format only your own files: `pnpm exec prettier --write <files>`, then `pnpm format:check`.

## Ordering landmine

Same-millisecond `ts` collisions are real; any new ts-only ordering or dedup is nondeterministic. Always order by `(ts, id)`.
