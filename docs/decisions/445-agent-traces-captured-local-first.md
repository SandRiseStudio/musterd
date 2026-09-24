# 445 — Agent traces are captured local-first: every harness action, on the machine that made it

- Status: proposed — 2026-09-24 (scope chosen with nick in session: full fidelity, local-first)
- Date: 2026-09-24
- Lane: `01M3AJQXXJ2B6NN43E11A41AKX` (goal `research-corpus`)
- Reverses: `docs/design/observability.md` §7's first non-goal — for capture on the producing
  machine only; the "we link, we don't replicate" posture stays for anything that leaves it.
- Builds on: [ADR 015](015-otel-layer1-server.md) / [ADR 082](082-instrument-by-default-telemetry.md)
  (off-by-default, no phone-home, instrument-by-default for dogfood daemons),
  [ADR 089](089-telemetry-l2-client-sdk.md) (the adapter/CLI SDK this ADR switches on),
  [ADR 144](144-mcp-tool-surface-measure-then-craft.md) (the one per-tool-call telemetry that exists,
  for musterd's own tools), [ADR 150](150-structural-inducement-pretooluse-gates.md) /
  [ADR 163](163-actor-attestation-tool-boundary.md) (the PreToolUse hook rail this ADR widens),
  [ADR 184](184-dataset-consent-and-redaction.md) (emitted ≠ published — the line this ADR keeps),
  [ADR 251](251-native-backend-musterd-as-its-own-harness.md) §7 (daemon-owned transcript capture,
  today native-only), [ADR 371](371-the-record-kind-and-the-rest-of-the-ledger.md) (the `record`
  sync kind that decides what replicates), [ADR 194](194-flywheel-practice-not-batond.md) (emit in
  musterd, compare in the research practice).
- Audit: [observability — current state](../wiki/observability-current-state.md), 2026-09-24.

## Context

nick's ask on 2026-09-24: _"We need to be able to fully capture e2e agent traces/runs that include
every single action (commands, reasoning, tool calls, code execution, MCP tool calls, hooks etc,
outputs, turns etc)."_ The audit behind this ADR found that the plan never intended that, and the
build never did it:

- **The plan drew the line at coordination.** `observability.md` §7: "Observability of agent
  internals (reasoning steps, LLM calls) — that's the existing market's job; we link to it, we don't
  replicate it." Layer 1 instruments musterd, Layer 2 derives insight from the act log. The only
  intended bridge to what an agent did inside its harness was the ADR 011 `traceparent` link — a
  join key into a backend the operator brings, which on the dogfood box nobody has brought.
- **Coordination capture is complete and running.** Acts, lanes, audit verbs, presence, attested
  model, musterd-tool aggregates (`tool_call_stats`, 25,077 calls since 2026-07-15), wake cost —
  all recorded; the envelope span exports live to the local sink.
- **Harness capture is nil.** Every harness on the box already runs a musterd hook on every tool
  call (ADR 150's gate, the interrupt probe, Codex/Cursor/Grok observers), and those hooks forward
  nothing about the call unless it matches an enforcement class — then a class name and a sha256
  fingerprint. No hook forwards a tool name, input, output, duration, prompt, response, turn or
  subagent boundary as data. The session's `transcript_path` is written to the local binding and
  read for mtime, size and a model id — never for content.
- **The raw material exists, unread.** Claude Code persists `thinking`, `tool_use`, `tool_result`
  and per-message `usage` to `~/.claude/projects` (781 MB here); Codex persists `reasoning`,
  `custom_tool_call`/`_output` and `token_count` to `~/.codex/sessions` (910 MB). Nothing musterd
  owns reads either. Claude Code's own OTel exporter can emit prompts, responses, tool results and
  cost with opt-in content flags, never thinking; it is not enabled.
- **The one full-fidelity store is the wrong shape.** ADR 251 §7's `wake_turns.transcript_json`
  captures every turn — for the native backend only (16 rows). The seats doing the work are on
  Claude Code, Codex, Cursor and Grok.
- **The client SDK is dormant.** ADR 089's `musterd.tool.call` / `musterd.cli.command` spans never
  export because the adapter and CLI processes are launched without `OTEL_EXPORTER_OTLP_*`; the
  ADR 011 cross-agent trace has therefore a measured link rate of 0%, as at its baseline.

Why the non-goal no longer holds. It was written for a product that sits _between_ single-agent
observability vendors; that positioning is unchanged (§3). But the research corpus (ADR 056's produce
side) and every cookoff/wasted-work number so far were reconstructed from harness transcripts by
hand — "a non-Claude agent's is unrecoverable" (ADR 082) — and the dataset musterd can uniquely
publish is _coordination acts joined to what each seat actually did_. Linking to a vendor backend
nobody runs is not a join. The join has to be made on the machine where both halves exist.

## Problem

Decide, in one place, (1) whether musterd captures agent internals at all, (2) through which rails,
(3) where the capture lives and what may leave the machine, so that increments can be built lane by
lane without re-deriving the posture, and so that ADR 184's publication line is not eroded by the
capture it now sits in front of.

## Decision

### 1. Capture is local-first; the non-goal is reversed for the producing machine only

musterd captures a seat's harness activity — prompts, tool calls with inputs and outputs, reasoning
where the harness persists it, token usage, hook outcomes, turn and subagent boundaries — into the
daemon's own store on the machine that produced it. `observability.md` §7's non-goal is amended to
say so. What §7 still means: musterd does not build a spans database, an LLM-call dashboard or an
eval platform for _other people's_ traces, and does not ship agent internals anywhere by default.
Emission to an operator's OTLP backend stays "integrate, don't build" (§3).

### 2. Three rails, in priority order

- **R1 — the hook tap (primary).** The hooks every harness already runs forward a structured
  `TraceEvent` for every hook the harness fires: `SessionStart`/`SessionEnd`, `UserPromptSubmit`,
  `PreToolUse`/`PostToolUse`/`PostToolUseFailure`, `Stop`, `SubagentStart`/`SubagentStop`,
  `PreCompact`, and their Codex/Cursor/Grok equivalents. Fields: harness, session digest (ADR 131
  §5 — never the raw id), seat, `hook_event`, `tool_name`, `tool_use_id`, `agent_id`/`parent_agent_id`,
  `duration_ms`, outcome, and a **content** part (`tool_input`, `tool_response`, prompt,
  `last_assistant_message`). The tap is best-effort and fail-open: it never blocks or slows the tool
  call it observes (batched, posted asynchronously, dropped on daemon unreachability with a local
  counter). musterd's own hooks record their own outcome (hook, exit code, duration) as a
  `TraceEvent` too — the harness's hook spans are beta-gated and Claude-only.
- **R2 — the transcript tail (the reasoning rail).** The host tails `binding.session.transcript_path`
  locally and emits `reasoning`, `assistant_text` and `usage` events per turn, keyed to the same
  session digest and joined to R1 by `tool_use_id`/turn. The parser is per-harness, version-stamped
  and tolerant: an unrecognised record is emitted as `{kind:'unknown', bytes}`, never dropped
  silently, and a parse failure downgrades the session to structural-only with an audit row. The
  harness's on-disk format is not a contract (Anthropic says so) and this ADR does not make it one.
- **R3 — harness-native OTel, and the dormant SDK switched on.** For dogfood seats (ADR 082's
  scope), the launcher marker (`musterd wire`, ADR 286) writes `OTEL_EXPORTER_OTLP_ENDPOINT` into
  the MCP registration when the daemon's plist carries one, so ADR 089's adapter spans and the
  ADR 011 link fire; the same path sets `CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTLP exporters for
  Claude Code seats, content flags off. R3 is a link and a cost/token cross-check, not a store.

### 3. One table, two body classes, and what leaves the machine

- A per-event table `trace_events` (team, seat, session digest, monotonic seq, ts, harness, kind,
  structural columns) with the content part in a separate nullable column. Per-call rows, not
  aggregates — `tool_call_stats` stays as the hourly view for musterd's own tools.
- **Structural** columns follow ADR 184 §2's definition (names, ids, kinds, timings, counts,
  fingerprints) and replicate under ADR 371's `record` kind and export under `dataset:export` as
  today. **Content** columns (inputs, outputs, prompts, responses, reasoning) never replicate, never
  export, and never cross the wire off-machine without ADR 184 §3 consent recorded per author. They
  are readable through the daemon by the seat that produced them and by admins (ADR 128's
  recipient-scoping applied to a seat's own trace).
- Content is bounded: `WAKE_TURN_TRANSCRIPT_MAX_BYTES` (256 KiB) per event, truncation recorded on
  the row; content older than 30 days is pruned unless `corpus:snapshot` captured it; structural
  rows keep the messages table's lifetime.
- Bash commands in content are stored as text — the sha256 fingerprint stays on the ADR 150 gate
  rows, which are the enforcement record and unchanged.

### 4. Posture

Off by default for the product (ADR 015/082: no OTLP endpoint → no export; no `trace` config →
no tap); instrument-by-default on the daemons we run. A seat can see that it is being traced:
`musterd status` and `team_status` say `traced: hooks+transcript` when the tap is on.

### 5. What this does not decide

The `/live` timeline and `musterd report` views over `trace_events` (an increment of their own);
Cursor/Grok/OpenCode transcript parsers (R2 ships Claude Code and Codex first); any change to
ADR 184's publication gate; a spans backend.

### 6. Increments

0. R3 config: adapter/CLI export switched on for dogfood seats via the launcher marker; Claude Code
   OTel into the existing sink. No schema change. Falsifier: `musterd.tool.call` spans in the sink.
1. R1 structural + content, Claude Code first, then Codex/Cursor/Grok hook adapters; `TraceEvent`
   protocol schema; `trace_events` migration; `POST /teams/:slug/trace/events`.
2. R2 transcript tail for Claude Code and Codex; join on `tool_use_id`; `musterd trace show
   <session>` renders one session end to end.
3. Replication/export wiring: structural columns into the `record` sync kind and `dataset:export`;
   content pruning; `corpus:snapshot` includes `trace_events`.
4. Views: `/live` per-seat timeline; `musterd report trace` (coverage, cost per lane, tool mix).

## Consequences

- `observability.md` §7 is amended in this PR with a dated pointer; §4's "CLI and MCP adapter only
  get error/diagnostic logging" line, stale since ADR 089, is corrected alongside.
- `07-conventions.md`'s "agent-turn detail" (the ADR 052 section) finally has a referent: the
  `TraceEvent` kinds of §2. ADR 184's table row "spans — prompt by hash + version — enforced" gets a
  dated note: nothing emits a prompt hash today; R1/R2 content is governed by §3 above instead.
- `docs/dogfood-telemetry.md`'s "export leftover" (2026-08-14) is corrected: the plist carries the
  endpoint and the sink is live; what is dormant is the adapter/CLI side (§2 R3).
- The research corpus gains the half it has reconstructed by hand since finding 001: per-seat
  action, cost and reasoning joined to coordination acts, for every harness, not only Claude.
- Risk: content capture makes the daemon's store sensitive in a way the act log already was
  (ADR 184's `messages.body` is verbatim prose today). The mitigation is §3 — the content column is
  the only new sensitive surface, it is bounded, pruned, and structurally barred from replication
  and export — not a scrubber.
- Cost: one hook round-trip per tool call already exists (ADR 150); R1 adds a payload to it and a
  batched POST, so the per-call overhead is what the gate costs now. R2 is a file tail.

## Observability & Evaluation

- **Traces:** the `TraceEvent` rows themselves are the trace; the daemon adds a
  `musterd.trace.ingest` counter (harness, kind, dropped) and the tap logs its drop count locally.
  Coordination acts gain nothing new; the join is by session digest and `tool_use_id`.
- **Eval:** per session, **coverage** = tool calls seen by R1 ÷ tool calls in the harness transcript
  (R2's count), and **reasoning coverage** = turns with a reasoning event ÷ turns. Dataset: every
  dogfood session after increment 2 lands; baseline today is 0 / 0 (nothing is captured). Target
  ≥ 0.98 tool coverage on Claude Code and Codex; a session below it is audited as
  `trace.coverage_low`.
- **Experiment:** run one seat through a real lane with all three rails on, then reconstruct the
  lane's wasted-work and coordination-token ratio (finding 001's hand-computed numbers) from
  `trace_events` alone; the numbers must match a hand read of the transcript within 5%.
