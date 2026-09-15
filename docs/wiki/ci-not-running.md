# When CI never starts

A PR stuck at `BLOCKED` with **no checks reported at all** is usually a GitHub Actions outage, not something wrong with your branch — and the retries that instinct suggests make it worse.

## Tell it apart in ten seconds (2026-08-26; falsify: during a stall, read the repo-wide run list — teammates' runs still landing while only yours stop would mean the fault IS branch-level and this page is pointing the wrong way)

Two commands separate "my branch is misconfigured" from "the provider is down":

    curl -s https://www.githubstatus.com/api/v2/summary.json \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status']['description']);[print('-',c['name'],c['status']) for c in d['components'] if c['status']!='operational']"

    gh api "repos/SandRiseStudio/musterd/actions/runs?per_page=5" \
      --jq '.workflow_runs[]|"\(.created_at) \(.name) \(.head_branch) \(.conclusion)"'

**The second is the real discriminator, and it works even if the status page is lying or lagging.** If the newest run *repo-wide* — any workflow, any branch, anyone's push — is hours old, the problem is not your branch. A branch-level fault cannot stop teammates' runs.

Worked example, 2026-08-26: `#1077` and `#1076` both sat `BLOCKED` with `gh pr checks` reporting "no checks reported". Repo-wide, the newest run of any workflow was `05:10:30Z` against a clock of `16:11Z` — eleven hours. The status API confirmed it: **Actions major_outage, incident opened 15:11:58Z, "throttled inbound traffic … upstream Vitess issues"**. Both pushes that produced no run (`16:00:18Z`, `16:05:38Z`) were inside that window.

## Do not retry into an outage (2026-08-26; falsify: check the incident text for a throttling mitigation before retrying)

The instinct is to force a re-trigger — push an empty commit, or close and reopen the PR to fire a fresh `pull_request` event. During this incident **neither produced a run**, and GitHub's own mitigation was *throttling inbound traffic*, so each attempt spent repo API budget pushing against the thing that was already saturated. Check the incident body before retrying: when the mitigation is throttling or rate-limiting, retrying is not neutral.

Roughly twenty minutes went into close/reopen cycles before anyone ran the status check. The ordering above is the whole lesson: **diagnose the provider before you touch the branch.**

## A green check earned before the outage still merges — so do not push (2026-08-26; falsify: push any commit to a PR showing CLEAN during an outage and watch `mergeStateStatus` fall to UNKNOWN)

The gate is satisfied by a check **on the head SHA**, not by Actions being up. A PR whose run landed before the incident stays mergeable straight through it: `#1080` merged at `16:17:10Z`, an hour into a critical outage, on a check from `04:43Z`.

The corollary is the one that costs you: **any push to such a PR moves the head and throws that check away**, and no new one can be issued until Actions returns. `#1076` went from mergeable to stranded exactly this way when its head moved to `111ce178`. During an outage, a rebase "to be tidy" is not free — it converts a landable PR into a blocked one.

If you must push (a genuine conflict, as `#1081` hit when `#1080` landed under it), do it knowing the cost and land it after recovery. If you do not have to push, do not.

## What is NOT worth ruling out first

These all look plausible and were all wrong on 2026-08-26. Checking them cost time; the repo-wide run list would have answered in one call.

- **A `paths:` filter skipping a docs-only diff.** `.github/workflows/ci.yml` is `on: pull_request` with no path filter (2026-08-26; falsify: read the `on:` block). A docs-only PR had already run successfully on the same branch that morning.
- **Actions disabled, or the workflow deactivated.** `gh api repos/:owner/:repo/actions/permissions` returned `{"enabled":true,"allowed_actions":"all"}` and the CI workflow's `state` was `active`.
- **Something specific to your branch's events.** Other branches had each taken multiple runs that morning, so `synchronize` events were being handled normally right up to the outage.

## A self-hosted runner would not have helped (2026-08-26; falsify: name the component the incident reports down)

The reflexive contingency — "put a runner on a machine we control" — does not survive this failure mode. Self-hosted runners poll GitHub's Actions **control plane** for job dispatch; when the control plane is what is down, no job is ever offered to the runner. The incident named Actions itself, not the hosted runner pool. A runner is a fix for capacity and cost, not for availability of the service that schedules it.

## What to do instead

**Wait.** `main` keeps its gate, blocked PRs stay blocked, and the first push after recovery picks them up normally. Nothing needs re-authoring: on 2026-08-26 the affected branches were each one push from green.

If the wait becomes untenable, note that `main`'s protection carries `enforce_admins: false` (2026-08-26; falsify: `gh api repos/:owner/:repo/branches/main/protection --jq .enforce_admins`), so a repo admin *can* merge a `BLOCKED` PR. That is a human's decision and it leaves no automatic record — the merge gate exists because gates-ran-only-locally is exactly how red code reached `main` before [ADR 106](../decisions/106-unified-git-workflow.md). A seat should not reach for it; a human may. This page deliberately stops at naming the capability rather than prescribing a procedure — the team considered writing a break-glass ADR on 2026-08-26 and chose not to, on the grounds that an outage rare enough to have blocked work once does not yet justify a policy.

## Related

- [Running the gates locally](running-the-gates.md) — what the `gates` job actually runs, and why a local green is not the same claim as a CI green.
- [Shipping a PR](shipping-a-pr.md) — the normal loop this page is the exception to.
