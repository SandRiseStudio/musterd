# Dogfood telemetry — instrument-by-default (ADR 082, slice 1)

The dogfood daemon boots OpenTelemetry by default so the **next multi-agent session is measurable live**
instead of reconstructed forensically (lab-notebook finding 001). Layer 1 (ADR 015) already emits the
envelope span + coordination metrics; this wires it to a local sink on the machine that runs the daemon.

> **Scope.** This is the _dogfood_ posture — the daemons we operate. The **product** default stays
> off / no-phone-home (you opt in via the standard OTel env vars, `observability.md` §config). The
> public statement of that product default is [`PRIVACY.md`](../PRIVACY.md). The sink here is a
> throwaway **local OTLP collector** (ADR 082): emission is pure OTLP, so any real collector —
> including a future parked batond product (ADR 194) — replaces the _endpoint_, never the
> instrumentation.

## What's wired (machine-local, not committed)

Two LaunchAgents under `~/Library/LaunchAgents/` (macOS):

| LaunchAgent                               | Role                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio.sandrise.musterd.plist`           | the daemon; its `EnvironmentVariables` now set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (and `OTEL_METRIC_EXPORT_INTERVAL=5000` for a snappy dogfood cadence)                                                                                                                                                                                                |
| `studio.sandrise.musterd-otel-sink.plist` | runs [`scripts/dev-otel-sink.mjs`](../scripts/dev-otel-sink.mjs) — a minimal OTLP/HTTP receiver on `:4318` that logs spans + metric data points to `~/.musterd/otel-sink.log`. It mirrors those lines to stdout **only** when stdout is a TTY, so under the LaunchAgent the plist's `StandardOutPath` holds crashes rather than a byte-identical second copy of the log |

The daemon's L1 SDK (`packages/server/src/telemetry.ts`) uses the **OTLP/HTTP (JSON)** exporters, so it
POSTs to `.../v1/traces` and `.../v1/metrics` — which the dev sink parses directly (no protobuf, no
external dependency).

## Verify it's live

```sh
# 1. daemon booted telemetry?
grep telemetry_on ~/.musterd/daemon.log        # → endpoint=http://localhost:4318

# 2. route an act, then watch the sink capture the span + counters
musterd send --act status_update 'telemetry check'
tail -f ~/.musterd/otel-sink.log
#   span "musterd.envelope.process" musterd.team=… musterd.act=status_update musterd.from=…
#   metric "musterd.envelopes" points=[1]   (+ presence.active, delivery.latency, presence.churn, inbox.lag)
```

Reload after editing the daemon plist so launchd picks up the new env:
`launchctl unload <plist> && launchctl load <plist>` (bounces the daemon — heads-up teammates first;
a standing grant re-occupies seats zero-touch).

## Swapping in a real collector / batond

Point the daemon's `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP backend and stop the dev-sink LaunchAgent:

- **All-in-one (traces + metrics + UI), when Docker is running:**
  `docker run -p 4317:4317 -p 4318:4318 -p 3000:3000 grafana/otel-lgtm` → Grafana on `:3000`.
- **batond** (the coordination-observability product, ADR 082 / `observability.md` §5): becomes just
  another OTLP endpoint — no re-instrumentation.

Rejected as the primary sink (ADR 082): **Langfuse** (its LLM-trace/generation model doesn't fit
coordination spans) and **PostHog** (event-analytics, not OTLP-native, and funneling our own coordination
metrics into a generic analytics tool undercuts the batond thesis).

## Coordination metrics (slice 3 — the server-derivable half)

The route path now emits first-party what finding 001 had to reconstruct:

- **`musterd.coordination.loop_latency`** (histogram, ms, by closing `musterd.act`) — accept/decline
  measured against the request_help/handoff they answer (`meta.in_reply_to`); resolve against its
  thread root. This is the "directed-act latency" + resolve-side of the finding.
- **`musterd.coordination.open_loops`** (gauge) — request_help/handoff acts not yet answered by an
  accept/decline, sampled on each metric collection.
- Act mix / resolve-rate are already derivable from the per-act `musterd.envelopes` counter.

Not emittable server-side (needs harness/git data → slice 4): coordination-token ratio, wasted-work
ratio, dup-rate.

## HTTP request log (slice 2)

Every HTTP request now logs a structured `http_request` line — `method` / `path` / `status` / `ms` —
info on 2xx/3xx, **warn on 4xx, error on 5xx** (errors land in `daemon.err.log`, which finding 001
found empty by design). Path only, never query/headers, and the path redacted — anything under
`/mcp/` and any credential-shaped segment logs as `[redacted]` (no secrets); healthy `/health` polls are
skipped so the CLI guard doesn't drown the log.

## Per-agent token usage (slice 4 — the in-band half)

Any sender can self-report its harness token usage by attaching **`meta.usage`** to any act:

```jsonc
{
  "act": "status_update",
  "body": "…",
  "meta": { "usage": { "input_tokens": 12000, "output_tokens": 800, "model": "claude-opus-4-8" } },
}
```

The route path emits it as **`musterd.agent.tokens`** (counter, by `musterd.member` /
`musterd.token.direction` / `musterd.model`). Opt-in and harness-agnostic — in-band self-report is the
only path that covers non-Claude harnesses (finding 001: a Cursor/GLM agent's transcript was
unrecoverable). Numbers only; junk is ignored.

## Not yet closed (ADR 082 follow-ups)

An automatic usage emitter (hook/wrapper that reads harness transcripts and attaches `meta.usage`);
the git-side metrics (wasted-work ratio, dup-rate — lanes territory); a cross-agent distributed trace
over ADR 011 traceparent propagation.

~~**Dogfood export leftover (2026-08-14, ADR 275).** The sink LaunchAgent is listening on `:4318`.
The daemon plist on this machine currently has **no** `OTEL_EXPORTER_OTLP_ENDPOINT`, and
`~/.musterd/otel-sink.log` is startup lines only.~~ **Corrected 2026-09-24 (ADR 445 audit):** the
daemon plist carries `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` and the sink holds 3,667
`musterd.envelope.process` spans plus a metric flush every ~60 s, so the table above is the live
posture for the **daemon**. What is dormant is the other side of ADR 089: the MCP adapter and the CLI
are launched by the harness / the user's shell without that env, so `musterd.tool.call`,
`musterd.cli.command` and the ADR 011 cross-agent link never export (0 such spans in the sink).
~~[ADR 445](decisions/445-agent-traces-captured-local-first.md) R3 routes the endpoint into the MCP
registration for dogfood seats~~ (that would break ADR 286 §1 — the registration env is exactly the
launch marker); R3 as accepted reads it from the machine config instead, below. The cross-agent
trace listed above as "not yet closed" is closed in code and open in config until that key is set.

## The adapter and the CLI export too (ADR 445 R3, increment 0)

`@musterd/telemetry` resolves its endpoint in this order: `OTEL_SDK_DISABLED=true` → off; any
`OTEL_EXPORTER_OTLP_*` env → that (the standard OTel way, unchanged); else
`~/.musterd/config.json` → `telemetry.otlp_endpoint`; else off. The MCP adapter is launched by the
harness and the CLI by your shell, so the daemon plist's env never reaches them — the file is how
all three processes agree on one sink without the registration env carrying anything but
`MUSTERD_LAUNCH_SURFACE` (ADR 286).

- **Fresh machine:** `musterd service install --otlp-endpoint http://127.0.0.1:4318` writes both the
  plist env and the config key (`''` clears both). The install line prints `otlp: … (daemon plist +
  <config path> for the adapter/CLI, ADR 445)`.
- **This machine (plist already carries the endpoint):** do not bounce the daemon for it — add the
  key by hand once: `"telemetry": { "otlp_endpoint": "http://127.0.0.1:4318" }` in
  `~/.musterd/config.json`. Adapters pick it up on their next launch (`/mcp` reload or a new
  session); the CLI on its next command.
- **Falsifier:** `grep -c 'musterd.tool.call' ~/.musterd/otel-sink.log` is non-zero after one
  `team_inbox_check` from a relaunched adapter, and `grep -c 'musterd.cli.command'` after one
  `musterd status`. Zero after both means the key is not being read.

**Claude Code's own OTel (the harness half of R3).** Claude Code exports its events
(`claude_code.user_prompt`, `tool_result`, `tool_decision`, `api_request`, …) and cost/token metrics
over OTLP when told to; the dev sink now summarizes `/v1/logs` too (one `log "<event>"` line per
record; restart the sink LaunchAgent after this lands: `launchctl kickstart -k
gui/$(id -u)/studio.sandrise.musterd-otel-sink`). This is a **global** Claude Code setting — it
reaches every Claude Code session on the machine, not only musterd seats — so it is a hand step,
not something `musterd` writes for you. In `~/.claude/settings.json`:

```json
"env": {
  "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
  "OTEL_METRICS_EXPORTER": "otlp",
  "OTEL_LOGS_EXPORTER": "otlp",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
  "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318"
}
```

Leave `OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_ASSISTANT_RESPONSES` / `OTEL_LOG_TOOL_DETAILS` /
`OTEL_LOG_TOOL_CONTENT` unset: the sink prints attributes verbatim into a plain-text log, and the
content rails with a credential scrub are ADR 445 R1/R2, not this. `http/json` matters — the sink
only parses JSON, and Claude Code's default is gRPC. Falsifier: `grep -c 'log "claude_code' ~/.musterd/otel-sink.log`
non-zero after one prompt in a restarted Claude Code session.
