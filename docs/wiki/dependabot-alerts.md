# Dependabot alerts can name packages the repo does not depend on

GitHub raises alerts from its own cached dependency graph, not from the lockfile in front of you, and that graph can lag by weeks — so triage starts by asking whether the package is even in `pnpm-lock.yaml` before anyone reads the advisory.

## The trap (2026-08-14; falsify: `grep -c "^  <pkg>@" pnpm-lock.yaml` on the default branch)

On 2026-08-14 the repo showed **17 open alerts (5 high, 10 moderate, 2 low)** — the count the push warning prints on every `git push`, which is how it gets read as a standing 17-problem backlog. Only **2** were real.

The other 15 named `hono` (7), `ip-address` (3), `fast-uri` (3), `body-parser` and `@hono/node-server`, all against root `pnpm-lock.yaml`. None of those packages were in the lockfile at all — `grep` returned 0 and `pnpm why` found nothing. The last commit whose lockfile contained them is `5079914a` (2026-07-29, #493).

The tell is in the dates: alerts for them were **created on 08-04, 08-05, 08-09 and 08-12 — after the packages had already left the tree**. GitHub was matching newly published advisories against a dependency graph snapshot that still listed them. An alert's existence is evidence about the graph, not about the lockfile.

## Triage order

1. **Is it in the lockfile?** `grep -cE "^  <pkg>@" pnpm-lock.yaml`. Zero means stop — nothing to fix in code.
2. **If yes, is the resolved version actually in range?** The advisory range is on the alert; the resolved version is in the lockfile. (Here `postcss@8.5.15` sat inside both a high `<= 8.5.17` and a medium `<= 8.5.22`, so both were real and a bump to 8.5.26 cleared them — landed in #825.)
3. **Runtime or dev?** `pnpm why <pkg> -r` names the parents. `postcss` is dev-only and transitive via vite, so its exposure is build-time over CSS we author — worth fixing because a lockfile bump is free, not because it was reachable.

## Clearing the stale ones

A lockfile change _should_ trigger the rescan that closes them, but the rescan is asynchronous and does not always arrive promptly: after #825 merged (postcss → 8.5.26 on main), the alert set was unchanged minutes later and the newest `updated_at` across all alerts was still two days old.

The manual repair is a dismissal with reason **`not_used`**, which is the accurate reason when the package is absent from the tree:

```bash
gh api -X PATCH repos/<owner>/<repo>/dependabot/alerts/<n> \
  -f state=dismissed -f dismissed_reason=not_used -f dismissed_comment="<evidence>"
```

Put the evidence in the comment — absent from the lockfile, the commit where it left, the dates showing alerts postdate its removal — so the record explains itself later. The 15 were dismissed this way on 2026-08-14, taking the repo to 2 open. Dismissal is not a blind spot: if a dependency ever reintroduces the package, Dependabot raises **fresh** alerts rather than staying silent.

## What could not be verified

`GET /repos/{owner}/{repo}/dependency-graph/sbom` **404s** for this repo (2026-08-14; falsify: re-run it), so the stale-graph explanation is an inference from the lockfile history and the alert dates, not something read back from GitHub's own graph. If that endpoint ever answers, it is the direct check.

Related: [running the gates](running-the-gates.md) — the sibling habit of confirming what a signal is actually measuring before acting on it.
