# 196 — Re-bind refreshes the ADR 109 seat git identity

- Status: accepted
- Date: 2026-07-31
- Builds on: [ADR 109](109-seat-git-attribution.md) (per-worktree `user.email` =
  `<seat>@<team>.musterd`), [ADR 065](065-agent-workspace-provisioning.md) (one folder = one seat)
- Lane: `01KYR3EKBKA5QF307841TFRSFV`

## Context

ADR 109 writes the seat git identity once, at `provisionWorkspace` (`musterd agent`). Doctor detects
a mismatch (wrong or missing email) and tells the human to run two surgical `git config --worktree`
lines — it does not auto-fix, and it correctly skips humans (`mscr_`).

`musterd claim` / `musterd join` re-bind a folder by rewriting `.musterd/binding.json` (new `team` /
seat) and stop there. The worktree's `user.email` is left alone. Live consequence on revive: grokbot
moved teams and kept committing as `grokbot@<oldTeam>.musterd`, so one seat appears as two emails on
`main` and every ADR 109 rollup splits its credit.

## Problem

A re-bind that changes who this folder is (team and/or seat) must also change how git attributes
commits from this folder. Leaving the old email is silent drift — CI still passes; attribution is
wrong.

## Decision

1. **Export** `setSeatGitIdentity` from `packages/cli/src/onboard/workspace.ts` (same best-effort,
   worktree-scoped writes ADR 109 already defines).
2. **Call it after a successful agent re-bind**:
   - `musterd claim` — always (claims present the team agent key).
   - `musterd join` — only when the authenticator is an agent key (`mskey_`). Never for a human
     credential (`mscr_`); a synthetic human email is strictly worse (doctor's existing gate).
3. Idempotent and non-throwing: same semantics as provision. Outside a git repo, no-op.

MCP `team_join` / `persistBinding` stay out of this lane's surface; the CLI paths are what move a
worktree between teams in dogfood. Doctor remains the detection layer until those paths share a
helper.

## Consequences

- Re-binding a seat worktree to another team updates `user.email` to `<seat>@<newTeam>.musterd`
  without a manual `git config` or a second `musterd agent --path`.
- Seat rename on the same team is covered by the same call.
- Humans joining a team still keep their real git identity.
- Refs ADR-109.

## Observability & Evaluation

- **Traces:** n/a — local `git config --worktree` write; no new daemon spans.
- **Eval:** dataset = agent worktrees whose binding `team` differs from the domain in
  `git config user.email` (doctor's `inspectGitAttribution` note). Baseline (pre-fix, revive):
  grokbot commits split across two `@*.musterd` emails after a team move. Score: after claim/join
  onto a new team, effective `user.email` equals `<seat>@<newTeam>.musterd`.
- **Experiment:** `packages/cli/src/onboard/workspace.test.ts` (direct rewrite) +
  `packages/cli/src/commands/claim.test.ts` (claim over a stale old-team email).
