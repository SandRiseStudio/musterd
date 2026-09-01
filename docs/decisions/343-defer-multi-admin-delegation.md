# 343 — Defer multi-admin delegation

- Status: proposed
- Date: 2026-09-01

## Context

ADR 342 inferred a duplicate-grant race from the request decision route reading
before it settles its request. That inference is false for the current daemon:
after `readJson()` resolves, the route performs synchronous SQLite and hub work
without another `await`. Node runs that section to completion before it begins
another request handler, so a second local request observes the settled row and
receives the existing conflict response.

The Team has not yet dogfooded two human admins. ADR 145 explicitly defers
multi-admin routing, delegation, and accountability design until that evidence
exists.

## Problem

Do not turn an unsupported concurrency theory into a transactional refactor or
new governance behavior, while retaining an honest path to multi-admin work.

## Decision

1. ADR 342's proposed transaction requirement and its duplicate-side-effect
   claim are withdrawn. The current conditional request settlement remains.
2. Multi-admin delegation and policy are deferred until a two-human Team
   produces an attributable decision-routing need. The existing human-only
   `is_admin` capability and admin-only governance endpoints remain unchanged.
3. Any future async persistence, multi-process daemon, or federated
   request-decision path must re-evaluate settlement atomicity before it
   introduces an await or remote boundary between reading and settling.

## Consequences

- No server, protocol, CLI, MCP, schema, or policy change follows from ADR 342.
- ADR 342 remains historical context for the concern but does not authorize the
  unimplemented transactional behavior.
- The security program proceeds with scoped bootstrap credentials and abuse
  controls, while multi-admin delegation remains evidence-gated.

## Observability & Evaluation

- Traces: no new trace is introduced; current `request.decide` audit rows
  continue to record the deciding human and outcome.
- Eval: the request-route integration suite is the dataset. Baseline and
  expected result: a first decision settles the request and a later decision
  receives `409`, with one terminal request row.
- Experiment: a two-human dogfood Team records concurrent approval behavior
  before a follow-on ADR selects routing or delegation semantics.
