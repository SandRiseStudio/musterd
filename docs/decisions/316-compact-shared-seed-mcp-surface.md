# 316 — Shared Seed MCP surface is compact by operation

- Status: accepted
- Date: 2026-08-24
- Decider: gptbot
- Supersedes: ADR 314's seven-tool MCP naming only

## Context

ADR 314 chose seven MCP tools for the Shared Seed lifecycle. The implementation is functionally
complete, but the standing-context gate measures the exact `tools/list` payload on every turn. The
pre-Seed generalist Surface already measured 15,839 bytes against a fixed 15,851-byte tool-list
budget. The seven Seed tools add 3,491 bytes, of which only 659 bytes are descriptions; the rest is
tool names and JSON Schema. Copy editing those seven descriptions cannot make the Surface fit.

The budget is a ceiling on repeated context cost, not a target to rebaseline when a feature adds
tools. Raising it would make every future turn pay for the API shape indefinitely.

## Problem

The seven-tool naming repeats the same Seed id and lifecycle framing seven times. The exhaustive
brief schema is also large, but it must remain structured and must still be parsed through
`@musterd/protocol` at the MCP boundary. Removing Seed support or hiding reads from read-only Members
would fail ADR 291. Trimming unrelated tool descriptions alone would preserve unnecessary structural
duplication while weakening guidance across the whole Surface.

## Decision

Keep the fixed standing-context budgets unchanged.

The MCP Seed Surface exposes three tools:

- `team_seed_list` — list the active tray, or all history.
- `team_seed_get` — read one Seed with its source and public thread.
- `team_seed_update` — perform one lifecycle action selected by `action`:
  `claim | ask | answer | submit | promote`.

`team_seed_update` accepts `{ action, id, input? }`. The action-specific `input` remains a structured
object: `{body}` for ask/answer, `{result, brief, conclusion?}` for submit, `{title?, detail?}` for
promote, and omitted or empty for claim. Its small MCP discovery schema describes that envelope; the
handler parses the full action-specific value through a discriminated `@musterd/protocol` schema
before any HTTP call. The exhaustive brief therefore stays structured and protocol-validated without
repeating its full shape in standing context.

Capability scoping keeps list/get on read-only Surfaces and removes `team_seed_update` with the other
acting tools. Results keep the same action-naming text and protocol-shaped `structuredContent`.

Recover the remaining headroom by shortening existing MCP descriptions to the action, when to call
it, and any refusal-preventing invariant. Remove examples and rationale already carried by input
field descriptions, results, the runtime primer, or the on-demand musterd skill. Tool names, input
schemas, behavior, and repair guidance remain unchanged. Update the verbatim core-tool descriptions
in `docs/architecture/05-mcp.md` in the same commit.

## Consequences

- The Shared Seed lifecycle remains complete on MCP with four fewer advertised tools.
- Agents select a Seed lifecycle action inside one update tool instead of selecting among five tool
  names.
- The exhaustive brief remains a structured object and is still validated at the protocol boundary,
  but its complete schema no longer multiplies on every turn.
- Existing prerelease callers of the five mutation names must move to `team_seed_update`; PR 1025 has
  not landed, so no released client contract is broken.
- Description edits spend fewer standing-context bytes while keeping detailed operating guidance in
  the existing on-demand skill.
- 2026-08-24 implementation measurement: the unchanged gate passes at 15,683 B default (168 B
  headroom) and 5,490 B muted (41 B headroom), down from the failing 19,330 B / 5,968 B Surface.

## Observability & Evaluation

**Traces.** Tool telemetry records `team_seed_update` and its success/error outcome without Seed body,
thread, or brief content. Server lifecycle audit remains action-specific, so consolidation does not
collapse the authoritative event record.

**Eval.** `pnpm context:check` measures the exact default and muted tool lists and fails against the
unchanged ceilings. MCP tests exercise every `action`, protocol refusal, dormant-session refusal,
and read-only capability scoping.

**Experiment.** Dogfood the consolidated update tool. Revisit only if action selection causes repeated
schema refusals or materially reduces successful Seed completion compared with the separate-tool
implementation.
