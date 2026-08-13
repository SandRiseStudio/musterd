# Shipping a PR

One enforced git loop (ADR 106): branch from fresh origin/main → PR → `gh pr merge --squash --auto --delete-branch` → sync by rebase + `--force-with-lease`, never merge — plus the two traps that stall or pollute it.

## The loop (ADR 106, enforced by branch protection since 2026-07-07)

Branch `feat/`|`fix/`|`docs/` from fresh `origin/main`; commits are throwaway (squash-merge). Fast local smoke only — CI is the authority. `gh pr create` → `gh pr merge --squash --auto --delete-branch`, walk away. Sync a stale branch by `git rebase origin/main` + `git push --force-with-lease`; never `merge main`, never bare `--force`. Required checks on main: `gates` + `Cursor Bugbot`; linear history; squash-only.

## Bugbot no-show (2026-07-08, PR #170, intermittent; falsify: check-runs list on a stalled PR)

Cursor Bugbot can silently never register its check-run (2026-07-08, PR #170; intermittent — #167 minutes earlier ran normally): `gates` green for 20+ minutes while auto-merge waits on a check that does not exist, and nothing alerts. If a PR sits OPEN with `gates` SUCCESS and no `Cursor Bugbot` entry in `gh api repos/…/commits/<sha>/check-runs`, comment `bugbot run` on the PR — it registers and completes within ~90s (neutral conclusion = clean, auto-merge fires).

## Never `pnpm format` (glob misalignment verified still present 2026-08-13; falsify: compare `format` vs `format:check` globs in package.json)

`pnpm format` writes `**/*.{ts,js,mjs,json,md}` but `format:check` only checks `packages/**/*.ts`, `tests/**/*.ts`, `*.{ts,json}` — the committed markdown/json was never prettier-conformant, so `pnpm format` reflows ~100 unrelated docs, burying the real change and breaking `roadmap:check`. Format only your own files: `pnpm exec prettier --write <files>`, then `pnpm format:check`.

## Ordering landmine

Same-millisecond `ts` collisions are real; any new ts-only ordering or dedup is nondeterministic. Always order by `(ts, id)`.
