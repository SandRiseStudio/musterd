# 109 — Seat-level git attribution + the authorized-by trail

- Status: accepted — seat git attribution + `authorized_by` merge trail shipped (#167/#170)
- Date: 2026-07-08
- Builds on: ADR 065 (agent workspace worktrees), ADR 069 (v0.3 governance: keys/grants), ADR 071
  (audit log), ADR 077 (request lane — `request.decide`), ADR 083 (lanes carry a `branch`), ADR 101
  (attested-not-verified per-occupancy attributes), ADR 106 (unified git workflow)

## Context

Every commit in a musterd dogfood repo is authored as the human owner's git identity, with a generic
`Co-authored-by: Claude <model>` trailer, and every `gh pr merge` runs as the human's GitHub auth.
Asked "what did seat X last implement?", the answer is unrecoverable: nothing in git — author, trailer,
or merge record — ties a commit, PR, or merge back to the **seat** (the durable team identity of ADR
058/069) that actually did the work. The gap is symmetric with the write-action-governance demand
recorded in `docs/design/landscape.md` §6: production write actions need approvals *and* logs — and a
squash-merge to `main` is exactly such a write action, with no record of the acting seat or the
authorizing human.

The pieces already exist:

- ADR 065 gives each seat its own worktree — one folder = one identity, so git identity can be set
  **per worktree**, once, at provisioning.
- ADR 101 established the pattern for actor attributes musterd cannot verify: **attested, not
  verified** — the client reports, the daemon stamps and records, `unknown` never blocks.
- The audit log (ADR 071) already keys rows on `actor` and records governance verbs; lanes (ADR 083)
  already carry the `branch` ref the work rides on.
- ADR 069's grant machinery already records *who authorized what*: a grant row names its issuer; a
  `request.decide` audit row names the deciding admin.

What is missing is only the wiring: seat identity into git commits, and merges into the audit log.

## Decision

Three mechanisms, minimal-first. All attribution is **attested** (ADR 101 doctrine): musterd records
what the seat's tooling reports; it does not verify git state against GitHub.

### 1. Per-worktree git identity (provisioned, durable)

`provisionWorkspace()` (ADR 065) sets a worktree-scoped git identity when it creates — or reuses — a
seat worktree:

```
git config extensions.worktreeConfig true       # at the repo toplevel, once
git config --worktree user.name  "<seat> (musterd seat)"
git config --worktree user.email "<seat>@<team>.musterd"
```

`--worktree` (not plain `--local`) is load-bearing: repo-local config is **shared across all
worktrees**, so without `extensions.worktreeConfig` the last-provisioned seat would silently rename
every other seat's commits. The `@<team>.musterd` domain is synthetic by design — it is an identity
label, not a mailbox, and it never collides with a real address.

Every branch commit a seat makes is now natively attributed: `git log --format='%an <%ae>'` answers
"who wrote this" without any musterd query.

### 2. The seat trailer survives the squash (convention)

ADR 106 squash-merges everything, and GitHub authors the squash commit as the merging GitHub
account — so per-worktree author identity is **lost on `main`** unless it rides in the squash body.
GitHub's default squash body concatenates the branch's commit messages, including trailers. So the
convention (AGENTS.md, git-workflow section):

- Commits carry `Co-authored-by: <seat> <seat@<team>.musterd>` — the seat line **replaces** the
  generic model trailer as the stable identity; harnesses may add their model line alongside it.
- When editing a squash body, keep the seat trailer lines.

`Co-authored-by` (rather than a custom `Musterd-Seat:` trailer) is deliberate: GitHub parses it,
renders it, and its blame/attribution tooling understands it. A `prepare-commit-msg` hook that injects
the trailer automatically is **deferred** — convention first; build the hook only if trailers get
forgotten in practice.

### 3. Merge attribution: an audit verb, not git plumbing

`gh pr merge` acts as the human's GitHub auth; we do not fight that (per-seat GitHub accounts / bot
tokens are deferred). Instead the **audit log** is the join table between seats and `main` SHAs:

- New `AuditAction`: `git.pr_merged`. Written when a lane carrying a `branch` reaches a terminal
  state (the `lane_resolve` seam — the moment the loop's step 6 fires). Row shape: actor = the
  resolving seat, target = the branch, detail = attested `{ pr, sha, authorized_by }` from optional
  fields on the lane-update body. Server-side hygiene per ADR 101: only those three keys are copied
  off the client body; everything else is stripped.
- `musterd audit` then answers both "which seat landed PR #N / SHA S" and "who authorized it".

### 4. Who is the authorizing human? (document, don't build)

No new machinery. The authorizing human for a privileged git action **is already recorded** by the
governance layer; this ADR fixes the interpretation:

- **Standing authorization** — the admin who issued the seat's grant (ADR 069/076). A seat operating
  under a standing grant merges on that admin's standing authority.
- **Per-action authorization** — the `request.decide` actor (ADR 077) when the action routed through
  the approval lane.

Clients pass that identity as `authorized_by` in the resolve detail (§3); when omitted, the standing
grant issuer is the implied authorizer. Like the model attestation (ADR 101), this is a claim the
daemon records, not a proof it checks.

## Consequences

- "What did seat X implement?" becomes answerable three ways, cheapest first: `git log
--author=<seat>` on branches, seat trailers in squash bodies on `main`, and `musterd audit` rows
  joining seats → PRs/SHAs → authorizing humans.
- The audit rows are attested, so a misbehaving client can misreport `pr`/`sha`/`authorized_by`. Same
  trade as ADR 101: the reporter is the only party that knows, and the row's `actor` (server-derived
  from the authed seat) is trustworthy even when the detail is not. GitHub-webhook-verified merge
  records are the escalation path if misreporting ever matters.
- Provisioning gains two `git config` calls; re-provisioning repairs identity idempotently. Existing
  worktrees pick up identity on their next `musterd agent` run (or a manual `git config --worktree`).
- Deferred, in order of likely need: the `prepare-commit-msg` trailer hook; per-seat GitHub
  accounts/tokens (real merge-as-seat); signed commits; webhook-verified merge records.

## Observability & Evaluation

**Traces** — the `git.pr_merged` audit rows *are* the observable: append-only, queryable via
`GET /audit` / `musterd audit`, alongside the grant/decide rows that carry the authorization side.
Branch-level attribution is observable in git itself (`git log --format='%an'`).

**Eval** — the metric is **attribution coverage**: the fraction of squash commits on `main` whose body
carries a seat trailer, and of terminal branch-carrying lanes with a `git.pr_merged` row. *Baseline:*
0% (nothing before this ADR attributes to seats). *Target:* every post-109 lane-landed PR carries
both. *Dataset:* `git log main` + the audit table.

**Experiment** — dogfood on this ADR's own PR: land it with the seat trailer and confirm the squash
body on `main` retains it; resolve the lane with `{pr, sha, authorized_by}` and confirm the audit row
renders in `musterd audit`. If trailers get forgotten across the next handful of lanes, promote the
deferred `prepare-commit-msg` hook.
