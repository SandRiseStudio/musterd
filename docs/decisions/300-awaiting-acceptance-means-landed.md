# 300 — awaiting_acceptance means landed: merge-verified lane_submit

Status: accepted 2026-08-21 (izzo; design approved by nick in-session)
Spec: `docs/superpowers/specs/2026-08-21-merge-verified-submit-design.md`
Lane: 01M0JSKTA3YH2CTHD869X1YWCZ

## Problem

A lane in `awaiting_acceptance` could not distinguish "waiting for a reviewer" from
"waiting for its author to press merge". Observed 2026-08-21 (dolly's #961/#963): both PRs
green from open, auto-merge never armed, lanes sitting `awaiting_acceptance` with nothing
landed. wanderer spent two check cycles holding for lanes with nothing to accept; the false
"landed" citation propagated into a wiki page and cost a second seat a lane (#967). The same
evening, miley declined to judge a wiki lane because "its lane_review carries no merged
attestation... I can't judge an outcome that hasn't landed" — acceptors were already
enforcing the invariant by hand.

The incident report's premise — "the daemon knew" — was falsified before design: musterd has
no PR-state knowledge of any kind (verified by grep on c5acf488; the only GitHub PR reader
in the repo is `scripts/adr-next.ts`, standalone). Falsifier: a real PR reader in
`packages/*/src` outside a permission string or a comment.

## Constraint

No poller. ADR 294 decision 2 and ADR 297 forbid the background-sweep shape; whatever
carries this signal must ride an act a seat already performs.

## Decision

**`awaiting_acceptance` means "landed, awaiting judgment", and `lane_submit` enforces it
seat-side.** The repo — not GitHub — is the source of truth for "merged": a merge
attestation is a SHA, and `git merge-base --is-ancestor <sha> origin/main` answers "landed?"
from any workspace with no API, no credential, no poller. The absence-is-not-an-event
asymmetry dissolves at submit: the author's own `lane_submit` **is** the event, and the
refusal reaches the one seat that owns the missing merge at the moment it acts.

1. **Verification at submit** (`packages/mcp/src/mergeVerify.ts`): best-effort
   `git fetch origin main` (15s timeout), then classify the attested SHA:
   `ancestor` (landed) / `not_ancestor` (resolves locally, not on origin/main) /
   `unknown_object` (not in this repo — cross-repo lane) / `fetch_failed` (could not judge) /
   `unattested` (no SHA given). `not_ancestor` requires a *successful* fetch — a stale ref
   can produce a false negative, so without a fresh fetch it degrades to `fetch_failed`. The
   positive needs no fresh ref: history only grows, so a stale ref cannot fake a landing.
2. **Refusal on positive evidence only** (ADR 145: degrade, never wedge): `not_ancestor`,
   a `pr` with no `sha` (an open PR is not a landed artifact — the motivating case), or a
   malformed SHA. Refusal text says exactly what to do: arm auto-merge, resubmit with the
   squash SHA. Abstentions (`unknown_object`, `fetch_failed`) and artifact-less submits
   proceed, tier recorded.
3. **The attestation carries its tier**: `Lane.merged.verification` (a string, so a newer
   client's tier parses on an older daemon; `MERGE_VERIFICATION_TIERS` is the known list).
   Named `verification`, not `verified` — `Lane.verified` already means "close was a
   counterpart acceptance" (ADR 169/191) and is not overloaded.
4. **Reader-side badge**: `review_debt` entries carry `unlanded` (attestation has no SHA),
   rendered in `team_next` as "NO MERGE ATTESTATION (nothing landed — waiting on its author,
   not you)" — covering grandfathered lanes and older clients, which can still flip state
   bare. The server deliberately does not refuse: enforcement is seat-side, skew-safe.

Not built, on purpose: a "your PR is green and unmerged" push nudge (needs live PR state
musterd does not hold, and a channel to a seat that is not acting); any poller; any
server-side gate. The control `lane-submit-refuses-unlanded` (docs/controls/registry.ts)
records the ritual half — arm auto-merge before submitting — as documentation of this
mechanism, not a substitute for it.

## Consequences

- dolly's exact call (`lane_submit {pr}` with the PR open) now returns "arm auto-merge",
  at the author, at the moment of the act. wanderer's wasted hold becomes structurally
  impossible for verified submits and visibly labeled for unverified ones.
- Cross-repo lanes (e.g. a sandrise lane submitted from an agents workspace) keep working,
  marked `unknown_object` — honest abstention rather than false refusal.
- `lane_submit` now runs git (a fetch) in the seat's workspace; a submit costs up to ~15s
  offline. Judged acceptable: submits are rare, and the offline path degrades to
  `fetch_failed` and proceeds.
- A fabricated SHA that exists on main (someone else's commit) still passes — attestation
  quality, not fraud-proofing; the audit log's ADR 109 trail is the counter for that.

## Observability & Evaluation

**Traces.** Every `lane_submit` attestation now carries `merged.verification` on the lane
and through `git.pr_merged` in the audit log; refusals surface as lane_submit error results
in tool telemetry (the act never reaches the daemon, by design — the trace of a refusal is
the absence of a bare submit plus the seat's own transcript).

**Eval.** Dataset: `lane_submit` attestations in the act log / lanes table
(`merged_json`). Baseline 2026-08-21: 100% of submits carry no tier; the motivating shape —
`awaiting_acceptance` with an open PR — occurred at least twice in one evening (#961/#963).
Target: zero `awaiting_acceptance` lanes whose PR is open; 100% of new submits carry a
tier; `unlanded` badge rate in review_debt trends to zero as grandfathered lanes drain.

**Experiment.** After 7 days (2026-08-28), count refusals by reason and tiers by value from
the lanes table and seat transcripts. A `pr`-without-`sha` refusal observed in the wild is
the control working; zero refusals with tiers uniformly `ancestor` is also a pass (the
ritual held); tiers absent from new submits means the rollout failed (old adapter builds
still live — check the daemon/adapter skew first).
