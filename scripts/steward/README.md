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

## Activation

The workflow has two modes, chosen automatically by which secrets exist:

**Baseline — no secrets.** The `scan` job runs weekly and, on drift, upserts one self-updating tracking
issue via the default `GITHUB_TOKEN`. Live as soon as this lands; trigger by hand from the Actions tab.

**Agent — with both secrets.** When `ANTHROPIC_API_KEY` **and** `STEWARD_TOKEN` are set, the `agent` job
runs instead: a CI-launched **Claude Code CLI** session (`claude -p --dangerously-skip-permissions`,
**no GitHub App**) follows [`CHARTER.md`](./CHARTER.md) to draft each fix and open a **draft PR** — never
a merge. It's for the findings that need judgment (write a roadmap item, reword prose, mark an item
shipped with its PR). _(We use the CLI, not `claude-code-action`, because the action mandates the Claude
GitHub App — the CLI needs only the API key + PAT, keeping the least-privilege model.)_

- **`ANTHROPIC_API_KEY`** — the model key for the session.
- **`STEWARD_TOKEN`** — a fine-grained PAT with `contents` + `pull-requests` write (org-approved for an
  org repo; a classic `repo`-scoped PAT also works). Required over the default `GITHUB_TOKEN`: GitHub
  won't trigger the required `gates` check on a `GITHUB_TOKEN`-authored PR, so the checkout uses the PAT
  and the PRs run CI normally.

> **Validated end-to-end** (2026-07-09): against a planted fixture the steward opened draft PR #184,
> reworded the drift, and left `roadmap-truth:check` green. Draft-PR-only + the truth-check seatbelt +
> protected `main` mean the blast radius is "a draft PR a human reviews" — it cannot merge, PAT or not.
> Trigger a run any time from Actions → steward → Run workflow.

## The residency arm (ADR 112 §3 → ADR 131 inc 5): cron → wake

The named destination is built: the steward's trigger can swap from the CI cron to the wake ledger
**under an unchanged charter**. Arm B replaces "CI launches a Claude session" with "a local scan
sends a directed act; harness residency wakes the enrolled steward seat on this machine" —
GitHub Actions cannot reach the laptop-local daemon, so the trigger must live where the daemon does.

```
pnpm steward:notify                # scan + one request_help per drifted task → the steward seat
pnpm steward:notify --dry-run      # print what would be sent, send nothing
```

The ask body is **structured only** (task id + finding count — never finder detail text, which
quotes PR titles/doc prose); the woken steward re-runs `pnpm steward:scan --json` itself. Sender
identity is the CWD's binding, so the runbook uses a dedicated `steward-scan` seat — an unattended
send must not impersonate a human.

### Runbook (owner-gated — the 2-week A/B run needs an explicit go; it spends API budget)

1. **Provision the two seats** (once):
   `musterd agent steward --team <team>` (the workhorse — its worktree is where wakes run) and
   `musterd agent steward-scan --team <team>` (the sender — authenticated discovery→ask only).
2. **Enroll the steward** from its workspace (admin authorizes):
   `musterd residency on --as <admin> --lane batched --tool-policy seat-policy --timeout 15m --budget 2`
   — `seat-policy` because the charter drafts PRs (the workspace's own Claude settings govern);
   the wake path still never passes a skip-permissions flag — the CI shape does **not** transfer.
3. **Keep the actuator resident**: `musterd service install --wake`.
4. **Schedule the trigger** (matches the CI cron, Mondays 08:00): a user cron/LaunchAgent line that
   runs `pnpm steward:notify` from the `steward-scan` workspace, e.g.
   `0 8 * * 1 cd <steward-scan-workspace> && pnpm --dir <repo> steward:notify`.
5. **During arm B** disable the CI `agent` job (leave the deterministic `scan` job — the tracking
   issue is arm-independent); re-enable it for arm A. `musterd residency off` is the kill switch.

The pre-registered comparison (arms, metrics, abort conditions) lives in
[harness-residency.md §7](../../docs/design/harness-residency.md).

### Still ahead

- **`auto-merge`** — arming `gh pr merge --auto` on a mechanical, statically-guarded fix (still through the
  same gates). No task uses it yet — the static checks already prevent the mechanical drift it would fix.
- **Reachability chase** — post the PR to the musterd team and re-ping via the ladder if unreviewed —
  natural on the residency arm, where the steward is a live musterd seat.

Every task stays `propose` (human-approved), so _curated is a feature_ holds.
