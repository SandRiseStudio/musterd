# 314 — Shared Seed Surfaces are thin lifecycle clients

- Status: accepted
- Date: 2026-08-24
- Decider: gptbot
- Implements: ADR 291 Surface contract

## Context

ADR 291 requires human, agent, and web Surfaces for the shared Seed lifecycle. Its protocol and HTTP
API are typed, but the implementation plan does not name exact CLI commands, MCP tools, or how a CLI
caller supplies the exhaustive structured brief. The `/live` product Surface is already read-only.

## Problem

Encoding the final brief as a long set of CLI flags would make a required structured record fragile
and hard to review. Giving each Surface different lifecycle words would force Members to relearn the
same state machine. Allowing the browser to mutate Seeds would also expand the read-only observer
Surface into a second authorization client without a stated need.

## Decision

All three Surfaces are thin clients over the authenticated HTTP API. The daemon remains authoritative
for visibility, authorization, state transitions, audit, and atomic Lane promotion.

The CLI command is `musterd seed` with these subcommands:

- `list [--history] [--json]` — active tray by default; `--history` returns every Seed.
- `show <id> [--json]` — full source, thread, brief/conclusion, and linked Lane.
- `claim <id>` — take an `open` or `clarified` Seed for exploration.
- `ask <id> "<question>"` and `answer <id> "<answer>"` — the narrow clarification round.
- `brief <id> --file <path>` — parse the file through `SeedBriefSchema` and submit a viable result.
- `conclude <id> --file <path> "<conclusion>"` — parse the same brief and submit a non-actionable
  result with its conclusion.
- `promote <id> [--title <title>] [--detail <detail>]` — deliberate manual promotion.

The default tray contains `open`, `exploring`, `needs_clarification`, and `clarified` Seeds plus
`completed` Seeds whose `completed_at` is no more than three days old. Promoted and older completed
Seeds appear only with `--history`. Empty output names Slack capture as the action that fills the
tray. Success output names the resulting state; `--json` returns protocol-shaped data without ANSI.

The MCP adapter exposes equivalent typed tools:
`team_seed_list`, `team_seed_get`, `team_seed_claim`, `team_seed_ask`, `team_seed_answer`,
`team_seed_submit`, and `team_seed_promote`. `team_seed_submit` accepts the protocol's discriminated
`promote|complete` result directly because an agent tool call already carries structured input.

The web Surface remains read-only. It shows the same active tray, offers history, removes promoted
Seeds immediately, removes completed Seeds after three days, and links promoted history entries to
their ordinary Lane. It performs no client-side authorization judgement beyond hiding unavailable
controls because there are no mutation controls.

## Consequences

- CLI brief files are reviewable artifacts and pass one protocol boundary instead of many flags.
- CLI and MCP use the same lifecycle words while fitting their native input forms.
- The web Surface adds shared visibility without becoming another mutation or credential flow.
- A later editable browser Seed workflow requires a separate decision and authorization design.
- 2026-08-24: [ADR 316](316-compact-shared-seed-mcp-surface.md) supersedes only the seven-tool MCP
  naming above. The shipped prerelease Surface keeps list/get and consolidates five mutations into
  `team_seed_update` so the fixed standing-context budget remains a ceiling.

## Observability & Evaluation

**Traces.** Surface calls use the existing HTTP request spans and daemon lifecycle audit rows. Tool
telemetry records MCP tool names and outcomes, never Seed or thread bodies. CLI and web add no
content-bearing telemetry.

**Eval.** Measure lifecycle calls by Surface, schema/refusal rates, time from capture to claim, and
the fraction of promoted Lanes opened from CLI versus MCP. Compare with ADR 248's baseline, where no
Seed Surface or pre-Lane lifecycle existed.

**Experiment.** Dogfood the file-shaped CLI brief and structured MCP submit paths. Revisit only if
Members repeatedly abandon a valid brief at the input boundary or need browser-side mutation.
