# 128 — Recipient-scoped message reads: close the DM-leak on GET /messages + the firehose

- Status: accepted
- Date: 2026-07-10

## Context

Need-to-know was enforced for **roster and capabilities** (ADR 070/071: a `team`-visibility seat
sees other seats' presence but not their capability records), but **not for message content**. Two
read paths returned every envelope on the team regardless of who the caller was:

- `GET /teams/:slug/messages` (the firehose history backfill, ADR 061) — `listTeamMessages` returned
  the whole timeline, gated only on `assertSeatCanRead` (account status), so any member could read
  every directed DM between any two other members.
- the live `team-all` firehose (`subscribe`, ADR 061) — `broadcastFirehose` pushed every envelope to
  every subscriber, gated only on `can_observe` (which controls firehose *access*, not per-envelope
  content).

Flagged as a known gap on 2026-07-02 (`security.md`, the `team-hardening` roadmap item: "the acts
addressed to them need-to-know is enforced for roster/capabilities but not message content"), and it
gates the derived insight layer (a scoped read model can't be built on an unscoped source).

## Problem

Enforce need-to-know on message **content** without breaking the read-only dashboard (the `/live`
office/stream is largely a visualization of *directed* coordination — handoffs, steers, DMs), and
without a schema migration, a new capability, or a wire change.

## Decision

Recipient-scope both read paths. A caller is a **party** to an envelope if it is the sender, the
recipient (`to_member`), or the envelope is a team/broadcast act (`to_kind IN ('team','broadcast')`) —
the same predicate the inbox already uses. Then:

- **Regular members** see only envelopes they are a party to. `GET /messages` passes `forMemberId` to
  `listTeamMessages` (adds `AND (from_member = ? OR to_member = ? OR to_kind IN ('team','broadcast'))`);
  the firehose skips directed (member-kind) envelopes for them.
- **Full-visibility seats — admins (`is_admin`) and read-only observer seats (ADR 063)** — see the
  whole timeline. The observer allowance is justified by **localhost-trust**: observer provisioning is
  unauthenticated on the loopback bind (ADR 040), so the `/live` dashboard observer *is* the trusted
  local operator. Actor identity comes from the message row (`from_member`/`to_member`), never a new
  capability.

The firehose already skips parties (sender + recipients get direct delivery), so every subscriber that
reaches the broadcast loop is a non-party; a directed envelope is therefore delivered there only to
full-visibility connections. `can_observe` still gates firehose *subscription* (unchanged, ADR 071).

**Deferred (tracked follow-up): local-vs-shared observer scoping.** A shared external watch-link
should see only public traffic, but observer provisioning is anonymous localhost-trust with **no
local-vs-shared signal** today — building that distinction belongs with the off-loopback / shared-link
hardening in the `team-hardening` cluster, not here. Until then, all observers are full-visibility.

## Consequences

- The member-level DM-leak is closed: a regular agent/member can no longer read other seats' DMs via
  `GET /messages` or the live firehose. The `/live` dashboard is unchanged (observers stay full).
- No schema migration, no new capability, no protocol/wire change — pure enforcement over the existing
  row shape and capability record. Reversible.
- Unblocks a scoped derived-insight read model (the source is now need-to-know-clean).
- A shared watch-link still sees directed traffic until the deferred local-vs-shared work lands —
  called out here so the residual is not mistaken for the whole gap being closed.

## Observability & Evaluation

**Traces** — n/a — a pure read-scoping gate emits nothing new: it removes rows from a response, which
is not a countable event. The existing `observe.denied` audit verb (ADR 071) still fires when a
`can_observe:false` seat attempts a `team-all` subscribe.

**Eval** — enforced by integration tests over the real HTTP+WS server. _Dataset:_ seeded envelopes —
an Ada→Lin DM, a Bo→Ada DM, a Lin→team broadcast. _Baseline:_ the pre-fix behaviour where any
member/observer received every DM (the prior tests asserted exactly that leak). _Targets:_ a regular
member's `GET /messages` returns only its party envelopes while an admin sees all; the firehose
delivers a directed DM to a recipient and a full-visibility observer but not to a non-party member;
team/broadcast acts stay visible to all. The prior leak-asserting tests were inverted, so the leak
cannot silently return.

**Experiment** — n/a — a binary security-boundary fix, not a tunable; no A/B. The deferred
local-vs-shared observer scoping gets its own evaluation when built.

## Related

[ADR 061](061-team-firehose-observer-stream.md) (the firehose this scopes),
[ADR 063](063-read-only-observer-seat.md) (observer seats — the deferred local-vs-shared distinction),
[ADR 070](070-v0.3-p1-seats-data-model.md) / [ADR 071](071-v0.3-p2-in-band-enforcement-and-audit.md)
(roster/capability need-to-know this extends to content),
[ADR 040](040-secured-off-loopback-bind.md) (localhost-trust — why observers are allowed full
visibility), `docs/design/security.md` + the `team-hardening` roadmap item (where this gap was
tracked).
