# 416 — The surfaces that show a model carry its tier

- Status: accepted
- Date: 2026-09-17
- Relates to: [ADR 101](101-model-as-a-variable.md) (the model is attested, never verified),
  [ADR 158](158-model-attestation-truth.md) (observed outranks declared),
  [ADR 236](236-sleeping-host-defers.md) (absence is not an assertion),
  [ADR 301](301-per-act-model-source-tier.md) (`model_source` names which tier produced `model`),
  `docs/design/attestation-copy-spec.md` §3 (the "seen / said / unattested" label)
- Lane: `01M2PAFNAS1R43HFWVRZPWNPRG`

## Context

ADR 301 put `model_source` on the wire beside `model`: `observed` when a harness probe saw the
model during the session, `environment` or `binding` when a person or a config declared it. It
travels on the heartbeat frame, the claim handshake, and the requests row, and the daemon stores
it on the presence row (migration 42).

It never reached the two surfaces that show a model to a person. `PresenceSchema` — the occupancy
shape inside `MemberSummary`, which the roster and `/live` read — carried `model` and no tier. An
audit row carried an actor's name and nothing about what that actor was attesting when it acted.
The attestation copy spec's §3 label, the one sentence ADR 320 §5 puts in front of every stranger
(_the record holds what the harness observed, not what the agent declared_), had nothing to derive
from. Miley found this while building the label (lane 01M2P8WKA4); the spec's first draft had
assumed the field was on the page.

## Problem

Two absences, one cause. The tier was carried everywhere the daemon _consumes_ a model and nowhere
it _presents_ one, so a reader of the roster could not tell a measured model from an assumed one,
and a reader of the audit log could not tell what a seat was claiming to be at the moment it acted.

The audit half has a second shape. The roster shows what a seat attests _now_; a presence row is
overwritten on re-attestation and dropped on disconnect. An audit row is a record of a moment, and
"what was this seat attesting when it did this" cannot be reconstructed later from the presence
table. It has to be written down when the row is.

Found while landing this: the stateless HTTP claim mirror (`POST /teams/:slug/claim`) had no
`model_source` in its body schema at all — every occupancy born through it carried a model with
no tier. It is the third field that mirror had resolved-then-dropped, after `workspace_key`
(2026-09-04) and `provenance` (ADR 131 §6 repair). <!-- claim: defect -->

## Decision

1. **`Presence.model_source`** is on the wire beside `Presence.model`, an optional
   `WIRE_ATTESTATION_SOURCES` enum, nullish. The daemon projects it from the presence row through
   `isWireAttestationSource`, so a stored value this wire does not know reads as unknown rather
   than passing through. It is null whenever `model` is null. Null beside a real `model` means the
   tier is _unknown_ (a pre-migration-42 row, or a client too old to send one) and is never
   defaulted to `binding`: "we do not know which tier" is a different fact from "it was a
   declaration".

2. **`AuditEntry.actor_model` and `AuditEntry.actor_model_source`** are on the wire, both nullish.
   The daemon stamps them at the write edge (migration 68 adds the columns) from the actor's newest
   live presence that attests a model, looked up by seat name, and never updates them. A row that
   names no actor, an actor attesting nothing, or a human (humans never carry a model, ADR 121) all
   read null/null. A replicated row keeps the origin's stamp: the fold carries both fields through,
   because the origin saw the model and the folding node may hold a different presence for that
   seat, or none.

3. **The HTTP claim mirror accepts `model_source`** beside `model`, carries it onto the occupancy
   it creates and across the approval gap on the requests row, gated exactly as `model` is.

4. **Absence is not an assertion.** Both new audit fields are absent from rows an older daemon
   wrote and from rows written before migration 68. A consumer reads absent as "not recorded",
   distinct from "attested nothing" only by the row's age. Neither field is ever backfilled.

## Consequences

- The roster and `/live` can label a model _seen_ (observed), _said_ (environment/binding) or
  _unattested_ (no model), per the copy spec's §3 table, and a tier-unknown model gets the honest
  fourth state rather than a guess. The spec's §3 precondition is met; its words are unchanged.
- `/audit` can show, on hover, what a seat was attesting when it acted, and the record survives
  the seat re-attesting, disconnecting or being removed.
- Every audit write costs one indexed read (`members` by name, `presence` by member, newest
  attesting row). Rows with a null actor skip it.
- Not done here: the CLI still does not _send_ `model_source` on the HTTP claim route, so a seat
  that occupies via `musterd claim` reads tier-unknown on the roster even when its harness observed
  the model. The MCP adapter does send it. Follow-on lane `01M2RTF2D0MMSBFH1YKDXZS30B`, unowned.
- Not done here: the label itself. That is the copy spec's implementation lane (miley,
  01M2P8WKA4); this ADR gives it the field.

## Observability & Evaluation

**Traces.** Every audit row written from now on carries `actor_model` and `actor_model_source`,
which is itself the trace: the columns say, per row, what the acting seat was attesting. The
existing `occupancy.model_attested` row still records each change of attestation, so the two read
together — the model-attested row says when a seat's claim changed, and every row between two of
them carries the value that held at the time. No new verb.

**Eval.** Six tests, each mutation-controlled (neutralise the production line; exactly the claimed
tests go red, the rest stay green — verified 2026-09-17, all six red with `stampFor` and the
presence projection removed):

- The roster projection carries `model_source` for `observed`, for `binding`, and `null` for a
  model attested with no tier (`store.test.ts`, `integration.test.ts` over `GET /members`).
- An audit row naming an attesting actor is stamped; one naming a seat with no live attestation,
  and one naming no actor at all, are both null/null (`store.test.ts`).
- The stamp is frozen at write time: a re-attestation between two rows leaves the first row alone
  (`store.test.ts`).
- A replicated entry that arrives carrying its own stamp keeps it (`store.test.ts`).
- `POST /claim` with a tier lands it on the occupancy and on the `claim.occupied` row
  (`claim-http.test.ts`).

Baseline: on `origin/main` at `bab32e20`, every one of those reads is absent or null — the dataset
is the six cases above, and the pre-change value of each is "the field does not exist".

**Experiment.** At the first post-merge read of `/audit` on the live daemon, measure the share of
rows with a non-null `actor` and a null `actor_model`, among rows written after migration 68 whose
actor is an agent seat. The prediction is that the share is small: agent seats that act are
usually seats that attested at claim. A large share falsifies the by-name-lookup design — it would
mean the write edge routinely cannot find the actor's presence (a seat renamed, a presence expired
between the action and the write), and the stamp should read the request's own attestation header
instead of the presence table. No threshold is pre-registered because the base rate of
attesting-vs-not among acting seats has never been measured; this read establishes it.
