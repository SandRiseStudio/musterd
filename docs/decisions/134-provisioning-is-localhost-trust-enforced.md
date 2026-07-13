# 134 — Provisioning is localhost-trust, enforced: close the anonymous observer DM-mint

- Status: accepted
- Date: 2026-07-13

## Context

[ADR 128](128-recipient-scoped-message-reads.md) closed the member-level DM-leak but deliberately
exempted **read-only observer seats** (ADR 063) from recipient-scoping, so the `/live` dashboard could
keep visualizing directed coordination. It justified that exemption in as many words:

> The observer allowance is justified by **localhost-trust**: observer provisioning is unauthenticated
> on the loopback bind (ADR 040), so the `/live` dashboard observer _is_ the trusted local operator.

That premise was load-bearing, and it was false. **Nothing enforced localhost-trust.** The server never
looked at a peer address — there is no `remoteAddress` check anywhere in it. "Local" was an emergent
property of the _default_ `127.0.0.1` bind, not a checked predicate, and ADR 040 exists precisely to
support binding _off_ loopback (TLS, or `--insecure-trust-proxy` behind a terminating proxy).

## Problem

`POST /teams/:slug/members` is unauthenticated — it routes straight to body-parsing, with none of the
`authTouch`/`authAdmin` its neighbours carry. It mints a seat and returns its secret. For
`{observer: true}` that secret is a full-visibility credential by construction: `GET /messages` skips
recipient-scoping when `member.observer === 1`, and the firehose delivers directed envelopes to
observer connections.

Chained, on any off-loopback deployment: **an anonymous network peer mints an observer seat and reads
every directed message on the team.** The default loopback bind is the only thing standing in front of
it. The same anonymous mint also hands out ordinary agent seats.

## Decision

Make the claim true: enforce localhost-trust at the provisioning route.

- **`isLocalPeer(remoteAddress, trustProxy)`** (`config.ts`) — a predicate over the _peer_ we were
  told, deliberately distinct from `isLoopbackHost`, which answers about a _bind address we chose_.
- **`POST /members` is gated on it.** A local peer provisions unauthenticated, exactly as before.
  Anyone else must present an **admin** credential (`is_admin`), with a refusal that names the real
  problem — where you are calling from, not your role.

Two properties of the peer check are load-bearing, and both are the kind that make a naive version
_worse than none_:

- **`trustProxy` poisons the signal.** Behind a TLS-terminating proxy, every remote request arrives
  _from the proxy_ — i.e. from loopback. A check that ignored the flag would read the open internet as
  "local" and hand it the keys. A trust-proxy daemon therefore trusts **no** peer; the flag is an
  argument, not an afterthought.
- **IPv4-mapped IPv6.** A dual-stack listener reports `::ffff:127.0.0.1`. Unwrapped before testing, or
  the local dashboard breaks.

A missing peer address fails closed.

## Consequences

- The anonymous-mint disclosure is closed. On an off-loopback bind, minting a seat — observer or
  otherwise — now requires admin.
- **The local `/live` dashboard is untouched.** It provisions from loopback and holds no admin
  credential (its only secret is the observer's own `mscr_`), so gating on _authentication_ rather than
  _locality_ would have broken it. This is why the gate is peer-based.
- ADR 128's observer exemption now rests on an invariant the code actually checks. The exemption itself
  is unchanged: a local observer is still full-visibility.
- **The residual is narrower, and it is the lane.** A watch-link still embeds a full-visibility
  observer credential (`live.tsx` `WatchLinkButton`), so _sharing_ one still shares the team's DMs.
  That is now an **owner-initiated** act rather than an anonymous one — a meaningful reduction, not a
  fix. Closing it needs observer **grades** (`full` vs `public`), where a watch-link mints a distinct
  public-grade seat scoped to `to_kind IN ('team','broadcast')`. That predicate already exists — it is
  ADR 128's party predicate minus its sender/recipient clauses — and the two enforcement points are the
  same two single-bit decisions. Next increment on this lane.
- `POST /teams` remains unauthenticated. Creating a team discloses nothing and mints no reader; left
  alone deliberately rather than swept up.

## Observability & Evaluation

**Traces** — the refusal is a real event, unlike ADR 128's silent row-filtering: a non-local
unauthenticated mint now fails with `unauthorized`/`forbidden` instead of succeeding, so it surfaces in
the daemon's HTTP error path. No new audit verb — the route provisions or it does not, and the existing
governance audit already records the seats that _are_ created.

**Eval** — integration tests over the real HTTP server, driving a real socket so the peer address is
genuine. _Dataset:_ a server bound on loopback with `trustProxy: true` — which models the off-loopback
deployment exactly, because it is the case where a loopback peer address stops being evidence of
anything. _Baseline:_ the pre-fix behaviour, where an unauthenticated `POST /members {observer:true}`
returned an `mscr_` that read every DM. _Targets:_ an unauthenticated non-local mint is refused (401)
for observer _and_ ordinary seats; an admin credential still provisions (201); a non-admin credential
does not (403, no privilege laundering); and — the regression that would matter most — a genuine
loopback peer still provisions unauthenticated, so `/live` is unbroken. Unit tests pin the two traps:
`trustProxy` demotes loopback to untrusted, and `::ffff:127.0.0.1` is local.

**Experiment** — n/a — a binary security-boundary fix, not a tunable. Observer grades get their own
evaluation when built.

## Related

[ADR 128](128-recipient-scoped-message-reads.md) (the observer exemption whose stated premise this
makes true), [ADR 063](063-read-only-observer-seat.md) (observer seats; grades land here next),
[ADR 040](040-secured-off-loopback-bind.md) (the off-loopback bind that turns the missing check into a
disclosure, and the `--insecure-trust-proxy` flag that poisons the peer signal),
[ADR 061](061-team-firehose-observer-stream.md) (the firehose), `docs/design/security.md` + the
`team-hardening` roadmap item.
