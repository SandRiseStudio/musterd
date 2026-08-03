# ADR 205 — Team and Member working-hours inheritance

**Date:** 2026-08-03
**Status:** accepted

## Context

The live office needs to show a Team's recurring working hours without embedding a display string in
the web surface. A Team may establish a shared schedule, while an individual Member may need a
different schedule. Existing `availability` represents a Member's current self-declared presence axis;
it is not a recurring schedule and cannot express Team defaults or inheritance.

## Problem

Working hours need to be optional, recurring by day, timezone-aware, and available at both Team and
Member scope. A Member-specific schedule must take priority over its Team schedule. The representation
must remain a shared, validated protocol value so the daemon, CLI, MCP adapter, and web surface cannot
drift into separate formats.

## Decision

Add an optional structured `working_hours` schedule to Team and Member projections and their durable
roster representations. The schedule contains an IANA timezone, a non-empty set of weekday keys, and
an inclusive daily start/end time in `HH:mm` form:

```ts
{
  timezone: 'America/Los_Angeles',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '11:00',
  end: '15:00'
}
```

The Team schedule is the inherited default. A Member schedule, when present, replaces the Team
schedule for that Member; there is no field-level merge. No schedule means no working-hours sign. The
server stores the values but does not enforce availability or automatically change Presence, matching
the existing availability contract.

For Team `revive`, the initial schedule is Monday through Friday, 11:00–15:00 in
`America/Los_Angeles` (Pacific time with DST handled by the timezone identifier).

## Consequences

- The protocol gains one additive, zod-validated concept and needs no wire-version bump.
- The database and durable roster formats need additive fields/migration support.
- Roster reads can expose both the Team default and each Member's effective schedule; the web sign uses
  the Team schedule and does not duplicate schedule rules.
- Member overrides are explicit and replace the Team schedule wholesale, which is predictable and avoids
  ambiguous partial inheritance.
- The schedule is informational in v1; enforcement remains out of scope.

## Observability & Evaluation

- Traces: n/a — this is a durable projection and presentation change; no new agent action is introduced.
- Eval: protocol, storage, reconcile, HTTP inheritance, formatter, and canvas render tests cover the
  valid schedule, Team inheritance, Member replacement, revive seed, and sign copy.
- Experiment: n/a — the sign is deterministic from the server projection and the existing office scene
  clock; no runtime experiment or dataset is required.
