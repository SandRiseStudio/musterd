# Merge-verified submit — `awaiting_acceptance` means landed

**Date:** 2026-08-21
**Lane:** 01M0JSKTA3YH2CTHD869X1YWCZ (izzo)
**Status:** approved design, pre-implementation

## Problem

A lane in `awaiting_acceptance` cannot distinguish "waiting for a reviewer" from "waiting
for its author to press merge". Observed instance (2026-08-21, dolly's #961/#963): both PRs
had green gates from the moment they opened, auto-merge was never armed, and the lanes sat
`awaiting_acceptance` while nothing had landed. The acceptor (wanderer) spent two check
cycles holding for lanes that had nothing to accept; a false "landed" citation propagated
into ryder's wiki page and cost a second seat a lane (#967).

The premise the incident report carried — "the daemon knew" — is falsified. musterd has no
PR-state knowledge of any kind (verified by grep on c5acf488; the only GitHub PR reader in
the repo is `scripts/adr-next.ts`, standalone). Falsifier: a real PR reader in
`packages/*/src` outside a permission string or comment.

## Constraint

No poller. ADR 294 decision 2 and ADR 297 both forbid the background-sweep shape. Whatever
carries the signal must ride an act a seat already performs.

## Key insight

musterd does not need PR state, because the repo is the source of truth for "merged". A
merge attestation is a SHA, and any seat can verify "is this SHA an ancestor of
`origin/main`" with a local git read — no GitHub API, no poller, no new credential. The
absence-is-not-an-event asymmetry dissolves at `lane_submit`: the author's own submit *is*
the event, and it is guaranteed to reach the one seat that owns the missing act.

## Decision

`awaiting_acceptance` should mean "landed, awaiting judgment". `lane_submit` verifies the
merge attestation seat-side before the state flips, refuses only on positive evidence of
not-landed, and records a verification tier on the attestation for everything else.

### Verification tiers

New module `packages/mcp/src/mergeVerify.ts`. Given `{sha?, pr?}` and the adapter's
worktree, it runs `git fetch origin main` (best-effort, short timeout) and classifies:

| Tier | Meaning | Submit outcome |
|---|---|---|
| `ancestor` | `git merge-base --is-ancestor <sha> origin/main` succeeds | proceeds — landed |
| `not_ancestor` | SHA resolves locally but is not on `origin/main` | **refused** — positively unmerged |
| `unknown_object` | SHA does not resolve in this repo (cross-repo lane, shallow clone) | proceeds, tier recorded |
| `fetch_failed` | git or network error | proceeds, tier recorded |
| `unattested` | no SHA given | see refusal rules |

### Refusal rules (ADR 145: degrade, never wedge)

Refuse the state flip only on positive evidence:

- `not_ancestor` → refused: "this SHA is not on origin/main — nothing landed; arm
  auto-merge and resubmit with the squash SHA."
- `pr` present with no `sha` → refused: "a PR number without a landed SHA is an open PR —
  arm auto-merge, then resubmit with the squash SHA." (The dolly case. The nudge reaches
  the author inside an act they already perform.)
- `unknown_object` / `fetch_failed` → proceeds with tier recorded. Cross-repo lanes
  (e.g. project=sandrise work submitted from an agents worktree) keep working.
- no `pr`, no `sha`, no `branch` → non-code outcome; proceeds as today, tier `unattested`.

A refusal is an error result from the tool with actionable guidance, not a lane mutation.
The server is not an enforcement point for this: an older client can still flip state bare
(skew-safe by design); increment 2 makes that visible instead.

### Attestation carries its tier

`Lane.merged` (packages/protocol/src/lanes.ts) gains optional
`verification: 'ancestor' | 'unknown_object' | 'fetch_failed' | 'unattested'`
(named `verification`, not `verified` — `Lane.verified` already means "close was a
counterpart acceptance", ADR 169/191, and must not be overloaded; `not_ancestor` never
lands on a lane — it is refused). The adapter stamps it; the server
persists it inside `merged_json` unchanged. Schema-optional, so older daemons and clients
interoperate.

### Increment 2 — reader-side rendering + control

- `review_debt` / `team_next` badge lanes in `awaiting_acceptance` whose attestation is
  missing or unverified: "no merge attestation — nothing to accept yet". Covers
  grandfathered lanes and old clients. Acceptors stop holding for unlanded lanes.
- Controls-registry entry documenting the ritual (arm auto-merge before submit) as the
  human-side statement of the same invariant — documentation of the structural fix, not a
  substitute for it.

## What this is not

- Not a "your PR is green and unmerged" push nudge. That version needs live PR state
  (green?) musterd does not hold, and a channel to a seat that is not currently acting.
  If submit-time refusal proves insufficient, that is a separate lane with its own
  justification.
- Not a poller, a schedule, or a watch.
- Not server-side enforcement. The daemon records; the adapter refuses; the renderer
  reveals.

## Testing

- Unit tests on `mergeVerify` with injected exec (every tier, timeout, malformed SHA).
- Tool tests on `lane_submit` for each refusal and proceed path, message text asserted.
- One real-git integration test on a temp repo: ancestor / not-ancestor / unknown-object.
- Protocol schema round-trip for `merged.verified` (present, absent, unknown value from a
  newer client).

## Observability & Evaluation (ADR 052 form, for the ADR)

- **Traces:** submit attestations in the act log now carry `verified`; refusals are
  visible as submit errors in gate/tool telemetry.
- **Eval:** dataset — the act log's `lane_submit` attestations. Baseline (2026-08-21):
  100% of submits carry no tier; dolly's shape (awaiting_acceptance with an open PR)
  occurred ≥2 times in one evening. Target: zero `awaiting_acceptance` lanes whose PR is
  open; every new submit carries a tier.
- **Experiment:** after one week, count refusals by reason. A `pr`-without-`sha` refusal
  observed in the wild is the design working; zero refusals with tiers present is also a
  pass (the ritual held); tiers absent means the rollout failed.

## Falsifier

If a legitimate submit flow exists where the artifact landed on a branch other than main
by design (not skew, not cross-repo), the refusal rule is wrong as stated and needs a
target-branch parameter.
