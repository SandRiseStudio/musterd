# 311 — Shared Seeds are Slack-only

- Status: accepted. Scope note 2026-09-03: this ADR governs the **relay boundary**, which stays
  Slack-only. [ADR 373](373-a-recorded-intention-names-its-lane.md) increment 2 adds a second way a
  Seed comes to exist — a document-recorded intention captured from this repo, `source: 'repo'`, no
  Slack author — through its own route, not through the relay. Nothing in the Decision below moved.
- Date: 2026-08-24
- Deciders: nick, gptbot

## Context

ADR 248's capture Worker can accept Slack and, when explicitly enabled, Twilio SMS into the same raw
KV buffer. ADR 291 replaces immediate Lane creation with a first-class Seed whose submitting Member
is immutable and whose clarification answers are authoritative only when they come from that Member.
ADR 291 specifies a minimal Slack-user-id mapping but no phone-number mapping.

## Problem

An SMS capture has no specified way to resolve its sender to a human Member. Guessing the Team admin,
retaining ADR 248's generic human attribution, or adding phone-number identity would each change the
accepted provenance and authorization model. Advancing the cursor past an unsupported record would
also violate ADR 291's rule that rejected sources do not advance ingest state.

## Decision

The first-class shared Seed domain accepts Slack captures only. Its relay boundary requires
`source: "slack"` and a non-empty Slack user id in `meta.user`; the daemon resolves that id through an
optional `slack_user_id` on a human Member. An unknown Slack user is acknowledged by the capture
Worker but creates no Seed and records only `unknown_submitter` diagnostics.

Twilio remains an optional capture capability of the ADR 248 Worker, but it is not a source for an
ADR 291 shared-Seed ingest stream. A non-Slack record is rejected without advancing the Team cursor,
so it cannot be silently discarded. Operators must keep Twilio disabled on a relay used for shared
Seeds or segregate/remove an incompatible buffered record before ingest resumes. Existing Lanes that
ADR 248 created from SMS remain ordinary historical Lanes.

The Slack mapping is durable roster data: `slack_user_id` is valid only on a human seat, serialized in
its committed seat file, projected into the Member row, and exposed without any credential or token.

## Consequences

- Seed clarification authorization has one explicit identity join and never guesses a submitter.
- SMS capture can continue for other consumers, but it cannot share an ADR 291 ingest stream.
- An accidental SMS record fails closed and visibly wedges that Team's cursor until corrected; no raw
  idea is silently lost.
- Supporting SMS as shared Seeds later requires a separate identity-mapping decision.

## Observability & Evaluation

**Traces.** Unsupported-source and unknown-submitter outcomes record relay id, source, and Team only;
they never record the raw body, Slack user id, phone number, or thread content.

**Eval.** Compare accepted Slack captures, `unknown_submitter` outcomes, and unsupported-source holds
against ADR 248's immediate-Lane baseline. A correctly configured Slack-only stream has zero
unsupported-source holds.

**Experiment.** Dogfood with Twilio disabled and verify every accepted relay id joins to exactly one
human Member before the cursor advances.
