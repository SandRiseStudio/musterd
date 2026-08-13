# Git safety — destructive commands that look like reads

`git checkout <file>` and `git reset --hard` both silently destroy uncommitted work with no reflog entry — commit or copy aside before any operation that restores or moves HEAD.

## `git checkout <file>` is not an undo (2026-08-05; falsify: try it on a file with two edits)

It restores the file from index/HEAD, discarding _every_ uncommitted change in it — not just the last one. Hit live while mutation-testing a finished-but-unstaged fix: each checkout threw away the fix along with the mutation, across three files. Mutation testing happens at exactly the moment work is finished and unstaged — the worst time for a destructive restore. Before mutating, pick one: `git add`/commit first (then checkout reverts only the mutation), `cp f f.bak`, or a self-reversing script.

## `git reset --hard` is not how you check upstream (2026-07-28; falsify: reflog after a reset over unstaged files)

Ran `fetch && reset --hard origin/main` on a detached HEAD holding ~2 hours of tested, unstaged work, intending only to "check upstream". Six files gone, no prompt, no reflog (reflog tracks commits only), and `git status` afterward reads "clean" — identical to "nothing was lost". To read upstream: `git log --oneline HEAD..origin/main` or `git diff origin/main --stat`. Commit as soon as work compiles — a WIP commit is free and amendable; squash-merge discards it anyway (see [shipping-a-pr](shipping-a-pr.md)). After any recovery, re-run verification against the restored files rather than trusting the pre-loss run.
