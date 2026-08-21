# 308 — Publishing musterd.io is one seat's standing authorization

- Status: accepted
- Date: 2026-08-21
- Lane: `01M0K7SS7RWV4HBR5AEZCFAZFN`
- Relates to: [ADR 132](132-live-viewer-on-daemon-origin.md),
  [ADR 192](192-outcome-acceptance.md), [ADR 302](302-musterd-io-public-site.md)

## Context

`pnpm --filter @musterd/web deploy:site` publishes the built site to musterd.io. Until now nothing
said who may run it, so each deploy was arranged in conversation and the answer lived only in that
evening's stream.

Every other terminal act on this team is recoverable. A bad merge is reverted, a wrong lane close is
reopened, a false claim in an ADR is superseded by a dated note. Acceptance (ADR 192) is the
mechanism for all of it: a second member judges the landed artifact and the record carries their
verdict.

A deploy is outside that loop. It is the only act where **landed and live are different facts**, and
no acceptance reaches the second one.

## Problem

Three things went wrong on 2026-08-21 that this ADR exists to prevent recurring.

**Landed read as live.** #996 fixed two defects on the public site and sat merged-but-undeployed;
both defects stayed live on musterd.io while the lane read as done. The author caught it themselves
and said so, but nothing in the process would have.

**Defects only a running browser shows.** On #984 the Twitch iframe painted a postage stamp, and the
player refused autoplay under its viewport-visibility rule — so the embed would have counted no
viewers at all, the feature silently not doing the one thing it exists for. Neither was visible in
the diff, in staging, or in `vite preview`, which serves the static shell and shows content routes
as empty.

**A permission relayed is a permission unverified.** nick gave the rule to one seat, who relayed it
faithfully to the seat it concerned. The recipient declined to act on it and asked nick directly —
correctly: the relay was accurate and still insufficient, because the missing property was
provenance, not accuracy. nick's direct answer contained a scope the relay did not carry, and the
first written version of this rule was two-thirds true as a result.

## Decision

**miley holds a standing authorization to publish musterd.io.** They run `deploy:site` when a change
is ready. They do not seek per-publish approval, and other members do not run it: land the change
and tell miley.

Four boundaries, because the summary sentence is guessable in three wrong directions and each was
guessed at least once while this was being written:

- **It is authorization, not routing.** Routing-through-miley and miley-may-publish-freely have the
  same one-line summary and are different rules. This is the second.
- **Deploy authority is not review authority.** It does not license merging work the deploying
  member has not read. miley drew this line themselves — merging #1002 after reading it, and
  declining to touch #1000 which they had not.
- **It covers the public origin only.** `/live` is not a deploy: the build-publisher republishes it
  from `main` within ~60s with no daemon bounce (ADR 132). `musterd service refresh` is the daemon.
  Neither passes through this gate.
- **A rule about who may take an irreversible action is not relayable.** It reaches the member it
  authorizes from the human whose authority it is, or it does not take effect. A faithful relay is
  not a defect and is still not sufficient.

## Consequences

- Deploys stop being negotiated per instance. The publish follows the merge without a round trip,
  which is what closes the landed-versus-live gap that #996 demonstrated.
- The authorization is a **person**, not a rule a check can enforce. Nothing in CI stops another
  member running `deploy:site`; this is a team agreement, and its enforcement is that it is written
  down where the command is documented (`packages/web/AGENTS.md`).
- It concentrates a capability in one seat, and that is a real cost: while miley is away, a
  finished change waits. Accepted deliberately — the alternative on the evidence above is publishing
  by a member who has not opened the page in a browser. If the wait becomes the binding constraint,
  the fix is a second authorized member, not a general licence.
- **This ADR does not decide what verification a deploy requires.** The evidence says a real browser
  on the public origin catches what staging does not, and every deploy so far has been verified that
  way by the seat now holding the authorization. Making that a *requirement* is a separate decision
  and is not taken here.

## Observability & Evaluation

**Traces.** No new act or span. A deploy is currently invisible to the coordination record: it
leaves no `status_update` by construction, and the only durable evidence is the version string the
Worker serves. That is a gap this ADR names rather than closes — the fact that a lane can read
`done` while its change is unpublished is exactly the ADR 294 shape, a state no instrument reports.

**Eval.** Metric: the wall-clock gap between a public-site PR merging and musterd.io serving it.
Dataset: web PRs touching `packages/web/content/**` or the staged route set. Baseline 2026-08-21,
measured across the three deploys of that day — #984 merged 21:00 and was deployed with the copy
that followed rather than on its own; #996 merged and sat undeployed until its author noticed and
asked; #1002 merged and deployed inside four minutes, the first under this authorization. Success is
that gap having no instance where a merged public-site change is discovered undeployed by chance.

**Experiment.** None yet, and the honest reason is that the baseline is three points from one
evening with one authorized member — too few to distinguish this rule working from that member being
attentive. The cheap first instrument, if this is ever worth measuring: compare the deployed version
string against `origin/main` and report the lag, which would have surfaced #996 without anyone
noticing by hand.
