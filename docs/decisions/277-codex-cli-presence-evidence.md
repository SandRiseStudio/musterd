# 277 — Codex CLI Presence Evidence During Active Execution

- Status: accepted
- Date: 2026-08-15

## Context

The owner-gated Codex CLI acceptance starts a temporary project MCP adapter,
claims Ada, drains one directed Act, and resumes the resulting Codex thread.
The acceptance must prove both the fixed-seat binding policy and a
daemon-observed Ada `codex` Presence.

## Problem

Codex CLI terminates its project MCP adapter when `codex exec` completes. The
adapter's shutdown handler intentionally releases its Presence, which the
roster correctly omits from live Presences. A roster read after the command
therefore cannot prove the online Presence that existed while the command was
running; treating that empty roster as a join failure would contradict the
adapter lifecycle.

## Decision

The acceptance observes Ada's online `codex` Presence by polling the isolated
daemon while the first `codex exec` process remains active. It then awaits
that process and separately proves the parsed fixed-seat binding policy,
directed-inbox drain, and exact thread resume. No persistent or daemon-wake
claim is inferred from the short-lived CLI Presence.

## Consequences

- The acceptance remains owner-gated and isolated, while its join evidence is
  server-observed rather than a removed local binding field.
- A post-exit roster with no live Ada Presence is expected and is not a test
  failure.
- Codex desktop keeps its separate manual evidence matrix; this decision does
  not claim desktop lifecycle automation or daemon wake/resume.

## Observability & Evaluation

Traces: none added; the test observes the isolated daemon's roster projection.

Eval: the owner-gated acceptance succeeds only after it sees Ada online on the
`codex` Surface during active execution, then completes inbox drain and exact
thread resume.

Experiment: run the double-gated test against a supported Codex CLI build;
the previous post-exit roster baseline has zero live Presences, while the new
active-execution observation must find one.
