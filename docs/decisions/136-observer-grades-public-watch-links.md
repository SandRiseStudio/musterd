# 136 — Observer grades: a shared watch-link sees only public traffic

- Status: accepted
- Date: 2026-07-13

## Context

[ADR 128](128-recipient-scoped-message-reads.md) closed the member-level DM-leak and named what it did
not close:

> **Deferred (tracked follow-up): local-vs-shared observer scoping.** A shared external watch-link
> should see only public traffic, but observer provisioning is anonymous localhost-trust with **no
> local-vs-shared signal** today.

[ADR 134](134-provisioning-is-localhost-trust-enforced.md) then made provisioning actually
localhost-trusted, so an observer can no longer be minted anonymously over the network. The residual it
left is this one: the `/live` **watch-link** embedded `cfg.token` — _the operator's own full-visibility
observer credential_ — in the shareable URL. Handing someone a watch link handed them every directed
message on the team.

## Problem

The deferral said the blocker was a missing **trust signal**: nothing distinguishes a local observer
from a shared one, so there is nothing to branch on.

That framing is what kept it stuck. There is no signal to _infer_, and there never will be — a
credential in someone else's browser looks exactly like a credential in yours. The distinction is not
discoverable at read time.

## Decision

Stop inferring trust; **issue** it. Grade the observer at mint.

- **`members.observer_scope`** (migration v18) — `'full'` or `'public'`. `members.observer` said _that_
  a seat is a read-only watcher; this says _how much it may see_.
- **The `/live` dashboard mints `full`** (the default): it runs on the operator's own machine, and the
  office/stream are largely a visualization of _directed_ coordination — handoffs, steers, DMs. A
  dashboard that could not see them would not be a dashboard.
- **A watch-link mints its own `public` seat**, on first share, cached per team. It is a _distinct
  seat_, not a share of the dashboard's — which is precisely the bug it replaces.

Defaulting to `full` is safe **only because minting is privileged** (ADR 134: local peer or admin), so
every seat that reaches the default was created by a trusted party. The two ADRs are load-bearing for
each other: grades without enforced provisioning would be a lock with the key taped to the door.

**Enforcement is a deletion, not an addition.** A public observer is simply _no longer exempt_ from ADR
128's recipient-scoping — and for an observer, that existing predicate already collapses to exactly the
public timeline:

- it can never be a **sender** (`route.ts` refuses sends from observers), so `from_member = me` is
  never true;
- team/broadcast fanout **excludes** observers (they receive via the firehose, not as addressed
  recipients), so `to_member = me` is only true for a DM _deliberately addressed to it_ — legitimately
  its own mail;
- what remains is `to_kind IN ('team','broadcast')`.

So there is no "public" query to write. `forMemberId` _is_ the public scope, for this seat shape. Both
enforcement points now call one predicate — **`hasFullMessageVisibility(row)`** — rather than testing
`observer` independently in the history read and the live stream, which is the shape that lets a scoping
rule drift out of sync between them.

`Connection.fullVisibility` is deliberately a _different bit_ from `Connection.observer`: an observer is
still an observer for presence and displacement whatever it may read. Conflating "is a watcher" with
"may see everything" is the original defect.

## Consequences

- Sharing a watch-link no longer shares the team's DMs. A viewer sees team/broadcast acts and nothing
  directed — on the history backfill and the live firehose alike.
- The local dashboard is unchanged: grade defaults to `full`, and v18 backfills existing observer rows
  to `full` explicitly rather than letting them fall to a default — a silent downgrade would break a
  live dashboard for no security gain.
- If minting a watch-link seat fails, the button **fails closed** — it does not fall back to
  `cfg.token`. That fallback would hand out a full-visibility credential at the exact moment we meant
  to withhold one.
- A watch-link seat is a real seat: it is reaped at the 24h observer TTL (ADR 064) when idle, and the
  cached link is stable across shares rather than littering seats.
- Additive, nullable column; no wire break. A pre-v18 client that omits `observer_scope` gets `full`,
  exactly as before.
- **Not closed:** a `public` link still reveals _who is on the team_ and their team-level traffic. It is
  a read-only public window, not an anonymizer. Whoever you hand it to sees the team working.

## Observability & Evaluation

**Traces** — n/a. Like ADR 128, this removes rows from a response rather than producing an event; a
scoped read is not a countable act. The grade is visible on the seat row for anyone auditing who may
see what, which is the durable question.

**Eval** — integration tests over the real HTTP+WS server. _Dataset:_ a team with an Ada→Lin DM and an
Ada→team act, watched by both a `public` and a `full` observer. _Baseline:_ the pre-fix behaviour, where
every observer saw both — asserted directly by mutation: reverting the grade resolution to always-`full`
fails exactly the two discriminating tests (the `GET /messages` scope and the firehose), so they cannot
pass vacuously. _Targets:_ the public observer's `GET /messages` returns the team act and **not** the
DM; the firehose pushes it the team act and **not** the DM (asserted on the _next frame_, so a leak
would arrive first and fail the assertion); a DM addressed _to_ the public observer still reaches it;
and a legacy observer minted with no grade still sees everything — the regression that would matter
most, a silently-downgraded live dashboard.

**Experiment** — n/a — a binary need-to-know boundary, not a tunable.

## Related

[ADR 128](128-recipient-scoped-message-reads.md) (the recipient-scoping this reuses, and the deferral
this closes), [ADR 134](134-provisioning-is-localhost-trust-enforced.md) (privileged minting, without
which a default of `full` would be unsafe), [ADR 063](063-read-only-observer-seat.md) (observer seats),
[ADR 064](064-observer-seat-ttl.md) (the TTL that reaps an idle watch-link seat),
[ADR 061](061-team-firehose-observer-stream.md) (the firehose).
