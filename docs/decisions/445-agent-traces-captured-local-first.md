# 445 — Agent traces are captured local-first: every harness action, on the machine that made it

- Status: accepted — 2026-09-24, by nick in session ("approved"), on the narrowed text (scope
  chosen with nick: full fidelity, local-first; narrowed the same day on nick's acceptance of three
  changes — a scope not a reversal, content opt-in with a credential scrub, a separate trace
  database — see §1, §3, §4; R3 corrected for ADR 286 in #1697 before this flip). Increment 0
  landed the same day (#1699) and its falsifier held — see Consequences.
- Date: 2026-09-24
- Lane: `01M3AJQXXJ2B6NN43E11A41AKX` (goal `research-corpus`)
- Scopes: `docs/design/observability.md` §7's first non-goal. The non-goal **stands as a product
  boundary** — musterd does not ship agent-internals observability and does not replicate a
  vendor's trace store. What this ADR adds sits under [ADR 082](082-instrument-by-default-telemetry.md)'s
  existing line instead: the daemons _we_ run capture their own seats' harness activity as research
  substrate, on the producing machine, off by default for the product.
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

Why the non-goal needs a scope, not a repeal. It was written for a product that sits _between_
single-agent observability vendors; that positioning is unchanged (§3) and stays the product
boundary. But the research corpus (ADR 056's produce side) and every cookoff/wasted-work number so
far were reconstructed from harness transcripts by hand — "a non-Claude agent's is unrecoverable"
(ADR 082) — and the dataset musterd can uniquely publish is _coordination acts joined to what each
seat actually did_. Linking to a vendor backend nobody runs is not a join. The join has to be made
on the machine where both halves exist, by the daemons we run, as substrate — which is a research
scope under ADR 082, not a change to what the product ships.

## Problem

Decide, in one place, (1) whether musterd captures agent internals at all, (2) through which rails,
(3) where the capture lives and what may leave the machine, so that increments can be built lane by
lane without re-deriving the posture, and so that ADR 184's publication line is not eroded by the
capture it now sits in front of.

## Decision

### 1. Capture is a research substrate, local-first; §7 stays a product boundary

musterd captures a seat's harness activity — prompts, tool calls with inputs and outputs, reasoning
where the harness persists it, token usage, hook outcomes, turn and subagent boundaries — into a
daemon-owned store on the machine that produced it. This is **scoped under ADR 082**: it is what the
dogfood daemons do to their own seats so the research corpus stops being reconstructed by hand. It
is not a product feature and `observability.md` §7 is not reversed: musterd does not build a spans
database, an LLM-call dashboard or an eval platform for _other people's_ traces, does not ship
agent internals anywhere by default, and emission to an operator's OTLP backend stays "integrate,
don't build" (§3). §7 gains a dated scope note pointing here; its text stands.

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
  scope), the adapter and the CLI resolve their OTLP endpoint from **machine-local config** when
  the standard env is absent: `~/.musterd/config.json` `telemetry.otlp_endpoint`, written by
  `musterd service install --otlp-endpoint` beside the daemon plist. It is **not** written into the
  MCP registration env — [ADR 286](286-launcher-surface-convergence.md) §1 fixes that env to exactly
  `MUSTERD_LAUNCH_SURFACE`, and this ADR keeps it so. `OTEL_SDK_DISABLED=true` still wins, and an
  explicit `OTEL_EXPORTER_OTLP_*` env still wins over the file, so ADR 015's "operator points us at
  an endpoint" posture is unchanged in kind: the pointer may live in a file the operator wrote.
  With that, ADR 089's `musterd.tool.call` / `musterd.cli.command` spans and the ADR 011 link fire.
  For Claude Code seats the onboarding reconciler (ADR 282) may additionally carry a settings `env`
  fragment (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP exporters to the same endpoint, content flags
  off) — dogfood-only, declined like any other fragment. R3 is a link and a cost/token
  cross-check, not a store.

### 3. One table in its own database, two body classes, and what leaves the machine

- A per-event table `trace_events` (team, seat, session digest, monotonic seq, ts, harness, kind,
  structural columns) with the content part in a separate nullable column. Per-call rows, not
  aggregates — `tool_call_stats` stays as the hourly view for musterd's own tools.
- **A separate database file**, `trace.db` beside `musterd.db` (same directory, same
  `better-sqlite3`, its own migration ladder). Per-call rows with up to 256 KiB of content each will
  outgrow the coordination store within weeks, and the daemon wedged twice on 2026-09-24 in
  synchronous SQLite work on `musterd.db`; the trace store must not add to that file's size, lock
  contention or backup weight. `corpus:snapshot` captures both files; nothing joins across them at
  write time — the join key (session digest + `tool_use_id`) is carried in both.
- **Structural** columns follow ADR 184 §2's definition (names, ids, kinds, timings, counts,
  fingerprints) and replicate under ADR 371's `record` kind and export under `dataset:export` as
  today. **Content** columns (inputs, outputs, prompts, responses, reasoning) never replicate, never
  export, and never cross the wire off-machine without ADR 184 §3 consent recorded per author. They
  are readable through the daemon by the seat that produced them and by admins (ADR 128's
  recipient-scoping applied to a seat's own trace).
- **Content capture is opt-in per team; structural is the default.** A team-level setting
  `trace.content` (default `off`) decides whether the content column is written at all; `revive` sets
  it `on`. With it off, R1 still records every event's structural columns, so the coverage eval in
  §Observability holds either way.
- **Credentials are scrubbed at the hook, before anything is stored.** Tool inputs and outputs can
  carry secrets verbatim (a `cat` of a binding, a token in a curl header). The tap replaces every
  token matching the protocol's `TOKEN_PREFIXES` shapes (`mskey_`, `msgr_`, `mscr_`, `msac_`,
  `msls_`, and any later prefix registered there) and the generic bearer/API-key shapes
  (`Authorization: Bearer …`, `sk-…`, `ghp_…`, 32+-char hex/base64 runs after `token=`/`key=`)
  with `<redacted:kind>` and records `redactions: n` on the row. This is a **credential** scrub
  only — hard rule 5 ("never log secrets") applied to a new log — not a PII scrubber, which ADR 184
  §2 rejects as false safety; prose stays prose.
- Content is bounded: `WAKE_TURN_TRANSCRIPT_MAX_BYTES` (256 KiB) per event, truncation recorded on
  the row; content older than 30 days is pruned unless `corpus:snapshot` captured it; structural
  rows keep the messages table's lifetime.
- Bash commands in content are stored as text (after the scrub) — the sha256 fingerprint stays on
  the ADR 150 gate rows, which are the enforcement record and unchanged.

### 4. Posture

Off by default for the product (ADR 015/082: no OTLP endpoint → no export; no `trace` config →
no tap); structural tap on by default for the daemons we run; content only where `trace.content`
is `on`. A seat can see that it is being traced and how deep: `musterd status` and `team_status`
say `traced: structural` or `traced: structural+content` when the tap is on.

### 5. What this does not decide

The `/live` timeline and `musterd report` views over `trace_events` (increment 4 — **human-gated**:
views are where a research substrate starts to look like the product §7 says we do not build, so
that increment opens only on nick's explicit word, not as a natural next step);
Cursor/Grok/OpenCode transcript parsers (R2 ships Claude Code and Codex first); any change to
ADR 184's publication gate; a spans backend.

### 6. Increments

0. R3: adapter/CLI resolve the OTLP endpoint from `~/.musterd/config.json` when the env is absent
   (`service install --otlp-endpoint` writes both plist and file); Claude Code OTel `env` fragment
   into the existing sink. No protocol schema change. Falsifier: `musterd.tool.call` and
   `claude_code.*` records in the sink after an adapter restart.
1. R1 in two halves. **1a structural**: `TraceEvent` protocol schema, `trace.db` + `trace_events`
   migration, `POST /teams/:slug/trace/events`, the Claude Code hook payload, then Codex/Cursor/Grok
   hook adapters — no content column written. **1b content**: the credential scrub (with its own
   test corpus of every `TOKEN_PREFIXES` shape and the generic shapes), the `trace.content` team
   setting, and the content column. 1b does not ship without the scrub tests green.
2. R2 transcript tail for Claude Code and Codex; join on `tool_use_id`; `musterd trace show
   <session>` renders one session end to end.
3. Replication/export wiring: structural columns into the `record` sync kind and `dataset:export`;
   content pruning; `corpus:snapshot` includes `trace_events`.
4. Views (human-gated, §5): `/live` per-seat timeline; `musterd report trace` (coverage, cost per
   lane, tool mix).

## Consequences

- `observability.md` §7 keeps its non-goal and gains a dated scope note pointing here (the first
  cut of this ADR, merged in #1691, struck the line as "reversed"; nick declined that framing the
  same day and the strike is undone); §4's "CLI and MCP adapter only get error/diagnostic logging"
  line, stale since ADR 089, is corrected alongside.
- `07-conventions.md`'s "agent-turn detail" (the ADR 052 section) finally has a referent: the
  `TraceEvent` kinds of §2. ADR 184's table row "spans — prompt by hash + version — enforced" gets a
  dated note: nothing emits a prompt hash today; R1/R2 content is governed by §3 above instead.
- `docs/dogfood-telemetry.md`'s "export leftover" (2026-08-14) is corrected: the plist carries the
  endpoint and the sink is live; what is dormant is the adapter/CLI side (§2 R3).
- The research corpus gains the half it has reconstructed by hand since finding 001: per-seat
  action, cost and reasoning joined to coordination acts, for every harness, not only Claude.
- Risk: content capture makes a daemon-owned store more sensitive than the act log already is
  (ADR 184's `messages.body` is verbatim prose; tool output can be a file of secrets). The
  mitigations are §3's, in order of strength: content is off unless a team turns it on; credentials
  are scrubbed before storage; the column is bounded, pruned, and structurally barred from
  replication and export; and it lives in a file the coordination store never opens. What remains
  is prose and code in `trace.db` on the operator's own disk, which is the same exposure as the
  harness's transcript directory today.
- **2026-09-24 — increment 0 landed (#1699, `e1284b4f`).** `@musterd/telemetry` reads
  `telemetry.otlp_endpoint` from the machine config when no `OTEL_*` env is set; `service install
  --otlp-endpoint` writes it; the dev sink takes `/v1/logs`. Falsifier on the dogfood box, once the
  daemon checkout had auto-refreshed: `musterd.cli.command` spans in the sink went 2 → 5 across
  `status` / `whoami` / `session`. One trap surfaced on the way: a CLI build older than a config key
  erases it on its next write (`readConfigFromDisk` whitelists keys), so a new key is stable only
  after every CLI touching the machine config is at or past the build that knows it — recorded as
  a team insight, fix candidate open.
- **2026-09-25 — increment 1a landed for Claude Code** (lane `01M3CXMVWF4E42WXTW323DHEWG`): `TraceEvent`
  schema (structural only — no content field exists in the schema), `trace.db` with its own ladder,
  `POST /teams/:slug/trace/events` (seat credential, leaseless, presence-neutral), the
  `musterd.trace.ingest` counter, and the Claude Code tap. Two things decided in the build: (1) the
  daemon assigns `seq` — a hook is a one-shot process with no counter to share; (2) the tap rides
  the processes the hooks already spawn (gate → PreToolUse, interrupt probe → PostToolUse, capture
  → SessionStart/End) and only the six events with no musterd hook get a new `musterd trace hook`
  registration, which is what keeps the per-call cost at "what the gate costs now". The 1a tail —
  Codex/Cursor/Grok hook adapters and musterd's own `HookOutcome` rows — is open; the
  `traced: structural` status line (§4) lands with it. The pre-#1699 config-erasure trap is fixed
  (#1706: unknown top-level keys pass through).
- **2026-09-25 — the 1a tail landed** (lane `01M3D1S9CE6K1JXEKS4FCBAXEC`). Codex taps `SessionStart` /
  `SessionEnd` / `PostToolUse` from `codex-hook`; Cursor taps from `session observe` (its camelCase
  events map onto this column's spelling; `postToolUse`, `afterShellExecution` and `afterMCPExecution`
  all record as `PostToolUse`, with the source name kept in `detail.hook_event` so a reader can
  de-duplicate an IDE call that fired two of them). The gate now infers the harness from the payload
  when its env names none, which fixes a mis-attribution: Grok's `PreToolUse` rows had been recorded
  as `claude-code`. `HookOutcome` rows ship for the gate (`decision`, `outcome: denied` on a deny) and
  for each harness's interrupt probe (`raised`, `deaf`). `duration_ms` is the hook process's whole
  life, node boot included, because that is what the tool call waited for. Each hook sends its
  observed event and its outcome in ONE post, and the gate posts after its decision is on stdout
  (it used to fire mid-decision). `musterd status` and `team_status` print `traced: structural` when
  the tap would record: no kill switch, an agent key and a seat credential, and a daemon whose
  `/health` names `trace_schema`. **Open, and recorded rather than built:** Grok's `Stop` hook runs
  the interrupt check with stdin ignored, and its PreToolUse probe carries no `--hook` flag, so
  neither is tapped. Closing that means rewriting the Grok hook lines, which needs a `FEATURE_EPOCH`
  bump, so it waits for the next Grok hook change rather than forcing one. Falsifier on the dogfood
  box, once autorefresh has run: `SELECT harness, kind, count(*) FROM trace_events GROUP BY 1, 2`
  shows `HookOutcome` rows beside `PreToolUse` / `PostToolUse` from a Claude Code seat.
- **2026-09-25 — increment 1b landed** (lane `01M3D3FZ5Q6FZE7MJS0JBC71H3`). The protocol gains
  `TraceContentSchema` (an optional `content` part on `TraceEvent`: prompt / tool input / tool
  response / error / assistant, bounded together to 256 KiB, with `redactions` and `truncated`), the
  `trace` policy block (`content: off|on`, default `off`; `musterd team policy --trace-content`), and
  `traceScrub.ts`. The daemon writes the content column only under `trace.content: on`, after its
  own second scrub pass; with the setting off, a content part that arrives anyway is dropped. Three
  things were decided in the build:
  (1) **The tap learns the policy from the ingest reply.** `202 {accepted, content}` carries the mode,
  the tap caches it in `.musterd/trace-policy.json`, and content flows from the next hook on. That
  costs no extra round trip, and a seat that has never heard `on` sends nothing.
  (2) **Content goes only to a loopback daemon.** A binding can name a remote server; §3's
  "never cross the wire off-machine" is enforced at the tap, not assumed.
  (3) **Two scrub findings from the corpus.** A token after a JSON-escaped newline (`\nmskey_…`) or a
  URL-encoded quote (`%22mskey_…`) slipped past a plain word-boundary test. So the start boundary
  now accepts escapes, and structured values are scrubbed leaf by leaf before they are stringified.
  Separately, musterd prefixes carry no start boundary at all, because a miss stores a secret while
  a false hit costs one identifier its tail. `traced: structural+content` shows where the hooks send
  content. Pruning at 30 days stays in increment 3 with the rest of the content lifecycle. Falsifier
  on the dogfood box, after `musterd team policy --trace-content on` on `revive`: rows with non-null
  `content` appear from the second hook of a session, and
  `SELECT count(*) FROM trace_events WHERE content LIKE '%mskey\_%' ESCAPE '\'` returns 0.
- **2026-09-25 — increment 2 landed** (lane `01M3D6H2C0652SDJBVFH1NRBRM`). Rail R2 for Claude Code
  and Codex. The protocol gains the four transcript kinds (`reasoning`, `assistant_text`, `usage`,
  `unknown` — lowercase, so the two rails stay apart in one column) and a `reasoning` content field.
  Decided in the build: **the tail is the hook processes that already exist** — Claude Code's `Stop`
  (per turn) and `SessionEnd` capture, Codex's `post-tool-use` (its rollout path rides the binding
  from SessionStart) and `end` — reading the transcript's delta from an offset cursor in
  `.musterd/trace-tail.json`; no long-lived tailer, and the per-turn cost is one bounded file read
  plus the same fire-and-forget POST the tap already pays. Parsers are version-stamped
  (`claude-code@1`, `codex@1`) and grouped to the harness's real shape: Claude splits one API
  message across jsonl lines (grouped by `message.id` — one `usage` per message, joined to R1 by the
  message's first `tool_use` id), Codex writes reasoning and its tool call as separate items (a
  reasoning item binds to the NEXT `call_id`; `token_usage_record` is the usage source and
  `token_count` a recognised skip, or every turn would count twice). Reasoning is largely encrypted
  at rest in both harnesses — what R2 stores is the summary/plaintext the harness kept, sizes
  either way. A parse failure or truncated file downgrades the session (§2): cursor flag, one
  `unknown {downgraded}` event, and a `trace.downgraded` audit row written by the ingest route.
  `musterd trace show <session|digest>` renders a session end to end over the new
  `GET /teams/:slug/trace/sessions/:digest` (ADR 128 scoping: own seat or admin; anything else
  reads empty, indistinguishable from absent). R2 content passes the same three gates as R1's
  (policy `on`, loopback daemon, scrub-then-cut). Also fixed here: `.musterd/trace-policy.json` and
  the new tail cursor are gitignored — the policy cache had been dirtying every traced seat's
  Workspace and stamping `-dirty` builds (izzo's finding). Falsifier on the dogfood box, once
  autorefresh has run and one turn has ended: `SELECT kind, count(*) FROM trace_events WHERE kind IN
  ('reasoning','assistant_text','usage') GROUP BY 1` is non-empty, and `musterd trace show` on this
  session interleaves both rails.
- Risk: the trace store grows fast. `trace.db` isolates that growth from `musterd.db`'s lock and
  backup path; the 30-day content prune bounds it; `musterd status` reports the file's size.
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
