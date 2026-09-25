# Observability — current state vs the plan (audit 2026-09-24)

musterd's telemetry captures the coordination layer well and the harness layer not at all: every act, lane, audit verb and musterd-tool aggregate is recorded, while every Bash/Edit/Read call, prompt, response, reasoning step, token count and hook outcome of a seat's harness session lives only in the harness's own transcript file, which nothing reads (2026-09-24; falsify: a `trace_events`-shaped table in `~/.musterd/musterd.db`, or any hook in `.claude/settings.local.json` that posts `tool_input` to the daemon). <!-- claim: defect -->

This page is the audit behind [ADR 445](../decisions/445-agent-traces-captured-local-first.md). It
records what the plan said, what shipped, what is dormant, and where the docs and the machine
disagree. Every claim is dated 2026-09-24 unless marked; the machine is nick's laptop (the dogfood
daemon, team `revive`). Sibling pages: [research corpus](research-corpus.md) (where the data lives),
[model attestation](model-attestation.md) (the one per-seat signal that is recorded),
[instrument silence](instrument-silence.md).

## What the plan was

`docs/design/observability.md` (draft 2026-06-11) defines **two** layers and a hard line: Layer 1
instruments musterd itself (OTel spans/metrics, ADR 015); Layer 2 derives coordination insight from
the act log (ADRs 089–091). §7 names the non-goal that matters here verbatim: _"Observability of
agent internals (reasoning steps, LLM calls) — that's the existing market's job; we link to it, we
don't replicate it."_ The intended bridge to agent internals was only ever a **link** — ADR 011's
`meta.otel` traceparent, so a harness's own gen_ai spans could be joined to musterd's coordination
spans in a backend the operator brings.

The one plan that reached further, ADR 051 ("agent-turn detail — model id + params, tool calls,
prompt-ref, tokens/cost/latency — and coordination events on one timeline"), stayed `proposed` and
was superseded by [ADR 194](../decisions/194-flywheel-practice-not-batond.md) on 2026-07-31. Its
phrase survives in the ADR section skeleton (`07-conventions.md` "agent-turn detail it emits") with nothing
behind it — see [drift](#drift-between-docs-and-the-machine) below.

## What shipped, and what is actually running

| Piece                                                                   | ADR         | Shipped | Running on the dogfood box (2026-09-24)                                                                                                 |
| ----------------------------------------------------------------------- | ----------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `musterd.envelope.process` span per act + 9 metrics                     | 015, 082    | yes     | **yes** — 3,667 spans and a metric flush every ~60 s in `~/.musterd/otel-sink.log` (+ `.log.1`)                                         |
| `meta.otel` traceparent so a handoff is one cross-agent trace           | 011, 089    | yes     | **no** — needs an active span in the adapter; see the dormant row                                                                       |
| Client SDK: `musterd.tool.call` per MCP tool, `musterd.cli.command`     | 089 inc 1   | yes     | ~~**dormant** — 0 of 3,667 sink spans come from `musterd-mcp` or `musterd-cli`~~ FIXED 2026-09-24 by #1699 (ADR 445 increment 0): CLI spans confirmed in the sink the same day; adapter spans on the next adapter launch |
| MAST views (`musterd report coordination`, per-recipient delivery)      | 090, 091    | yes     | yes                                                                                                                                     |
| Tool-call aggregates for musterd's own tools (`tool_call_stats`)        | 144 inc 1   | yes     | yes — 25,077 calls since 2026-07-15, hourly buckets, no per-call rows                                                                    |
| Per-agent tokens (`musterd.agent.tokens` from `meta.usage`)             | 082 slice 4 | opt-in  | **no producer** — nothing in MCP or CLI attaches `meta.usage`; the counter moves only if an agent hand-writes it                         |
| Coordination metrics: token ratio, wasted-work, dup-rate, resolve-rate  | 082 slice 3 | partial | only `coordination.loop_latency` and `coordination.open_loops` (+ `seen_latency` from ADR 090)                                          |
| Wake cost per musterd-launched run (`residency.wake_cost`)              | 131, 252    | yes     | yes — musterd-launched seats only                                                                                                       |
| Full per-turn transcript capture (`wake_turns.transcript_json`)         | 251 §7      | yes     | yes — **native backend only**, 16 rows total                                                                                            |
| Structural-only dataset export                                          | 184         | yes     | exported 2026-08-19; no HuggingFace release                                                                                             |
| Firehose + `/live` viewer                                               | 061, 132    | yes     | yes — acts, lanes, presence, attested model, admin audit table; no tool calls, tokens, cost, hook events or timeline                     |

The dormant row is a configuration fact, not a code defect: `@musterd/telemetry` starts only when
`OTEL_EXPORTER_OTLP_*` is set (`packages/telemetry/src/index.ts`, `telemetryEnabled`). The daemon's
LaunchAgent plist sets it; the MCP adapter is launched by the harness with its own env (for this
workspace, only `MUSTERD_LAUNCH_SURFACE`), and the CLI runs under the user's shell — neither has the
variable. ~~Adapter and CLI spans are therefore no-ops on every seat
(2026-09-24; falsify: `grep -c 'musterd.tool.call' ~/.musterd/otel-sink.log` returns non-zero after an adapter is launched with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`).~~ <!-- claim: defect -->
FIXED 2026-09-24 by #1699: `@musterd/telemetry` now falls back to `~/.musterd/config.json`
`telemetry.otlp_endpoint` (env still wins; ADR 286's registration env untouched). Measured after the
daemon checkout auto-refreshed to it: `musterd.cli.command` spans 2 → 5 across three CLI runs. Trap
met on the way — the pre-#1699 CLI on PATH erased the new key on its next config write, because
`readConfigFromDisk` whitelists keys; ~~a new config key is only stable once every CLI touching the
machine config knows it (2026-09-24; falsify: add an unknown top-level key under `MUSTERD_CONFIG`, run `musterd status` from a build that predates it, re-read the file).~~ <!-- claim: other -->
FIXED 2026-09-25: `saveConfig` now writes unknown top-level keys through from disk on every path, so a build that cannot read a key no longer deletes it (2026-09-25; falsify: add an unknown top-level key under `MUSTERD_CONFIG`, run a config write from this build, re-read the file — the key is gone). <!-- claim: other -->

## What is captured about a seat's harness session

Every harness on the box already runs a musterd hook on every tool call — Claude Code
(`.claude/settings.local.json`: PreToolUse `gate check`, PostToolUse `inbox --interrupt-check`),
Codex (`.codex/hooks.json`: `codex-hook post-tool-use`), Cursor (`.cursor/hooks.json`:
`session observe` on postToolUse/afterShell/afterMCP), Grok (`.grok/hooks/musterd.json`). What those
hooks send the daemon is nearly nothing:

| Hook                        | Sent to the daemon                                                                                                            | Stored as                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| SessionStart / SessionEnd   | seat, harness class, HMAC digest of the session id, model, optional wake lease                                                | `audit` `residency.session_captured` / `session_ended`                           |
| PreToolUse (`gate check`)   | only enforcement-class calls: lane/action gate decisions; subagent spawns and subagent writes; Bash as a sha256 fingerprint | `audit` `lane.gate`, `action.gate`, `actor.subagent_*`                           |
| PostToolUse                 | the interrupt probe                                                                                                           | `audit` `interrupt.*`, `musterd.interrupt.check` counter                         |
| UserPromptSubmit            | nothing — prints the orient nudge                                                                                             | —                                                                                |
| **ADR 445 R1 tap (Claude Code, since 2026-09-25)** | one structural `TraceEvent` per hook event: harness, session digest, kind, tool name, tool_use_id, agent ids, sizes of the content fields — never the content (falsify: `SELECT kind, count(*) FROM trace_events` in `~/.musterd/trace.db` is empty after a Claude Code session on a seat whose CLI is at or past #1707) <!-- claim: other --> | `trace.db` `trace_events`                                                     |

No hook on any harness forwards tool name, input, output, duration, prompt, response, turn boundary or
subagent lifecycle as data — `gate check` parses `tool_name` + `tool_input` and discards everything
that does not match an enforcement class (`packages/cli/src/commands/gate.ts`, `attest`). The
session id and `transcript_path` are written only to the local 0600 `.musterd/binding.json`; the
daemon holds the digest (ADR 184 "contractually machine-local", ADR 131 §5). The transcript is read
only for mtime, byte size, the last 256 KiB for a model id, and a resume-weight byte count
(`packages/cli/src/session/enumerate.ts`, `transcript-model.ts`) — its content blocks are consumed by nothing musterd owns (2026-09-24; falsify: any `readFileSync`/stream of `transcript_path` in `packages/*/src` that parses content blocks rather than sizing them). <!-- claim: defect -->

## What the harnesses themselves persist (the unread raw material)

Both major harnesses write a full per-session record to disk, and it is large:

- **Claude Code** — `~/.claude/projects/<slug>/<session>.jsonl`, 781 MB on this box. A sampled
  transcript (`f5922c8e…`, 2026-09-21) carries `user`/`assistant` records whose content blocks are
  `thinking`, `tool_use`, `tool_result`, `text`, with per-message `usage`. **Thinking is persisted**
  (2026-09-24; falsify: a count of `"type":"thinking"` blocks in any recent transcript is zero). <!-- claim: other -->
  Anthropic's docs call the format internal and version-unstable, and say to prefer `/export`,
  `--output-format stream-json`, or the Agent SDK.
- **Codex** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, 910 MB. A sampled rollout
  (2026-09-24) carries `reasoning`, `custom_tool_call` / `custom_tool_call_output`, `function_call`,
  `message`, `token_count` payloads.
- **Claude Code's built-in OTel export** (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_*_EXPORTER=otlp`)
  emits `user_prompt`, `assistant_response`, `tool_result` (name, `tool_use_id`, success,
  `duration_ms`), `tool_decision`, `api_request` (model, tokens), `api_error`, plus cost/token
  metrics with `agent.name`/`mcp_tool.name` attributes. Bodies are redacted unless
  `OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_ASSISTANT_RESPONSES` / `OTEL_LOG_TOOL_DETAILS` /
  `OTEL_LOG_TOOL_CONTENT` are set; **thinking is never exported**; hook executions appear only as
  `claude_code.hook` spans behind beta flags. Not enabled on this box — no `OTEL_*` in
  `~/.claude/settings.json` `env`
  (2026-09-24; falsify: read that key). <!-- claim: other -->

So the complete signal set nick asked for on 2026-09-24 — commands, reasoning, tool calls, MCP
calls, hooks, outputs, turns — exists per harness, on disk, and reaches no store musterd owns.

## Drift between docs and the machine

Each of these is a doc claim that reads as current and is not
(2026-09-24; falsify: open the cited line). <!-- claim: other -->

1. `docs/dogfood-telemetry.md` "Dogfood export leftover (2026-08-14)" says the daemon plist has
   **no** `OTEL_EXPORTER_OTLP_ENDPOINT` and the sink is startup lines only. The plist sets
   `http://127.0.0.1:4318` and the sink has 3,667 spans — corrected in the same PR as this page.
2. [ADR 144](../decisions/144-mcp-tool-surface-measure-then-craft.md)'s header says increment 1 is
   "still sequenced behind the wave work"; `tool_call_stats` has recorded every musterd tool call
   since 2026-07-15 (PR #286).
3. [ADR 184](../decisions/184-dataset-consent-and-redaction.md)'s posture table marks spans'
   "prompt by hash + version" as **enforced**. No prompt hash or version is captured anywhere
   (`grep -ri 'prompt.*hash' packages/*/src` is empty); it is enforced only in the sense that nothing
   is emitted at all.
4. `observability.md` §4 "CLI and MCP adapter only get error/diagnostic logging until there's a
   reason for more" — stale since ADR 089 (2026-07-05).
5. `07-conventions.md` line 136 asks every ADR to describe "agent-turn detail it emits" citing
   ADR 194, which never defines the term; it came from superseded ADR 051 and only
   `wake_turns` (ADR 251, native backend) emits anything like it.
6. `docs/dogfood-telemetry.md` "Not yet closed" still lists the cross-agent distributed trace;
   ADR 089 closed it in code on 2026-07-05 — and it is dormant per the table above, so both
   statements are half right.
7. The `.claude/settings.local.json` PostToolUse hook `musterd gate record-subagent --stdin` fails
   silently on any `musterd` built from `main` at `40b5fbd1`: the subcommand lives on the unmerged
   `feat/the-wall-gate` branch (commit `3cde7297`, wanderer). Harmless (`|| true`), but a hook that
   runs on every `Agent` call and does nothing
   (2026-09-24; falsify: `musterd gate record-subagent --stdin </dev/null; echo $?` exits 0 with output). <!-- claim: defect -->

## The three rails that would close the gap

Measured against nick's list (commands, reasoning, tool calls, MCP calls, hooks, outputs, turns):

| Signal                             | Harness-native OTel (Claude only) | Hook tap (all four harnesses) | Transcript tail (Claude, Codex) | `wake_turns` (native, headless) |
| ---------------------------------- | --------------------------------- | ----------------------------- | ------------------------------- | ------------------------------- |
| tool name / outcome / duration     | yes                               | yes                           | yes                             | yes                             |
| tool inputs / outputs              | opt-in flags                      | yes (`tool_input`, `tool_response`) | yes                        | yes                             |
| reasoning                          | never                             | no                            | yes (internal format)           | yes                             |
| tokens / cost                      | yes                               | no                            | yes                             | yes                             |
| turn + subagent boundaries         | yes (`agent_id`)                  | yes (`Stop`, `SubagentStart/Stop`) | yes                        | yes                             |
| musterd hook outcomes              | beta spans                        | self-reported by the hook     | partial                         | —                               |
| Cursor / Grok / OpenCode           | no                                | yes (hooks already installed) | unknown                         | —                               |

The hook tap is the only rail that is contract-stable (documented hook schemas), cross-harness, and
already installed on every seat; the transcript tail is the only rail that carries reasoning; the
harness OTel is free where it exists. [ADR 445](../decisions/445-agent-traces-captured-local-first.md)
scopes all three and the storage/publication contract.
