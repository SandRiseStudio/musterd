# The steward seat

A standing agent teammate that **keeps the declared record honest against reality** — the design is
[ADR 112](../../docs/decisions/112-steward-seat.md). This directory is its v1 runtime.

`roadmap-truth:check` (a static check) guarantees the roadmap can't _silently_ disagree with the ADRs
and PRs it already names. The steward does the other half — **discovery**: it goes looking for drift no
static check can see, because a linter over a file is blind to what the file doesn't mention.

## What it does (v1)

A weekly [GitHub Action](../../.github/workflows/steward.yml) runs the **scan** and, if it finds drift,
opens/updates **one self-updating tracking issue** assigned to the repo owner — the shepherding surface
that doesn't rot: it persists, refreshes each run, and closes itself when the drift clears.

```
pnpm steward:scan                 # human-readable drift report
pnpm steward:scan --json          # structured findings (what the workflow acts on)
pnpm steward:scan --md            # the tracking-issue body
pnpm steward:scan --since "30 days ago"   # widen the unmarked-feature window
```

### The finders (`scan.ts`)

| finder             | drift it catches                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reverse_drift`    | an item still unshipped whose own freezing ADR is already **accepted** (shipped-but-unmarked). A tripwire — `roadmap-truth:check` errors on this at PR time, so it should stay empty on `main`. |
| `unmarked_feature` | a merged `feat` PR (after the anchor convention, [`ANCHOR_EPOCH_PR`](./lib.ts)) that no shipped item anchors and no shipped item's `frozenBy` covers — candidate undeclared/unmarked work.      |
| `stale_prose`      | a doc saying _"not yet built / implemented"_ while citing an ADR that is now **accepted** — prose lagging reality (we hit this by hand twice).                                                  |

### Autonomy ([`tasks.ts`](./tasks.ts))

Each task declares its own autonomy — the reusable knob ADR 112 §2 calls for, so a future specialized
seat sets its own:

- **`propose`** — becomes a human-approved change (v1: the tracking issue; with the agent layer, a draft PR).
- **`auto-merge`** — a purely mechanical, statically-guarded fix the seat may land unattended.

**Every v1 task is `propose`.** There is honestly no deterministic `auto-merge` work yet: the mechanical
drift such a task would fix is _already prevented from reaching `main`_ by the static checks (that's the
point of them). The level exists and the workflow honours it; the first `auto-merge` task lands with the
judgment/agent layer — by editing `tasks.ts`, reviewed like any change.

## Activation & the upgrade path

**v1 needs no secrets.** The workflow uses the default `GITHUB_TOKEN` (scoped to `issues: write`) to open
the tracking issue. It is live once this lands; trigger it by hand from the Actions tab (**workflow_dispatch**).

The richer ADR-112 modes are the next increment and need provisioning **you** do (granting an automated
writer its keys is deliberately a human act):

1. **Draft-PR `propose`** — instead of an issue, open a draft PR that drafts the fix (e.g. marks an item
   `shipped: { prs }`, refreshes stale prose). Needs a **`STEWARD_TOKEN`** (a PAT / GitHub App token with
   `contents` + `pull-requests` write) — the default `GITHUB_TOKEN`'s PRs don't trigger the required `gates`
   check, so auto-merge would stall.
2. **`auto-merge`** — the seat arms `gh pr merge --auto` on a mechanical, statically-guarded fix. Still a PR
   through the same protected-`main` gates; nothing bypasses CI. `roadmap-truth:check` is the seatbelt.
3. **Agent drafting** — for findings that need judgment (write a new roadmap item, reword prose), a CI-launched
   session drafts the change from the `--json` findings. Needs an **`ANTHROPIC_API_KEY`** secret.
4. **Reachability chase** — post the PR to the musterd team and re-ping via the ladder if unreviewed; arrives
   with daemon-triggered residency (the reserved roadmap item), swapping the cron trigger under the same seat.

Until then, v1's assigned, self-updating issue is the shepherding surface — and the whole loop stays
`propose`, human-approved, so _curated is a feature_ holds.
