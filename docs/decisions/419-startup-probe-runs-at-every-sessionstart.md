# 419 — Every SessionStart path runs the self-heal probe

- Status: proposed
- Date: 2026-09-18
- Relates to: [ADR 408](408-a-workspace-repair-is-an-audit-row.md) (workspace self-heal and
  drift-cache contract), [ADR 168](168-hook-content-drift.md) (hook epochs and repair guards),
  [ADR 333](333-orient-skill-every-harness.md) (harness startup orientation)
- Lane: `01M2TNRDAWBKEQSBXSWQJ6QF2Z`

## Context

ADR 408 makes `musterd init --check-build` the SessionStart self-heal probe. It repairs stale
guidance and in-workspace marker-owned hooks, then writes `.musterd/drift.json` for the MCP adapter
to read. The probe is deliberately best-effort and never fails a harness session.

The implementation assumed that every harness's startup hook invoked that probe. The assumption was
false. Claude Code's machine-wide SessionStart command invokes `init --check-build`, but the Codex
SessionStart command invokes only `musterd codex-hook start --stdin`. Grok's capture hook invokes only
`musterd session start --stdin`, and Cursor's orienting startup hook invokes only
`musterd session observe --stdin --orient`. These handlers capture or orient a session but did not
run the self-heal probe. The MCP adapter consequently saw a missing drift record and correctly
reported UNKNOWN, even though a harness startup hook had fired.

The existing CLI also refreshed the drift cache only after the repair/report block completed. An
unexpected exception in that block could therefore leave no receipt even when the probe started.

## Problem

A harness-specific hook implementation can silently bypass the common self-heal contract, and a
probe failure can erase the evidence needed to distinguish "clean" from "never inspected". This
makes automatic guidance refresh depend on which harness launched the Member and turns a failed
probe into the same adapter symptom as a missing hook.

## Decision

1. **The runtime handler is the backstop.** Every handler that represents a harness SessionStart
   event calls one shared CLI-local startup-probe helper with the workspace parsed from the hook
   payload. The helper lazily invokes `runSessionProbe({ cwd })`, swallows failures, and never
   changes the hook's fail-open exit contract. The existing Claude machine-wide probe remains in
   place as the early, self-gating path; the handler backstop also covers a missing or stale global
   hook and is idempotent with it.

2. **The covered paths are explicit.** Codex `codex-hook start`, Claude/Grok `session start`, and
   Cursor `session observe --orient` invoke the helper. The workspace comes from the already parsed
   event payload and its existing anchored resolver; the helper never re-anchors a named event to
   an unrelated process cwd.

3. **A probe always attempts a receipt.** `runSessionProbe` refreshes `.musterd/drift.json` in a
   `finally` path after the repair/report attempt. If repair or audit posting throws, the cache
   still records the drift that could be inspected. Cache-write failure remains silent and does not
   fail the harness hook.

4. **No hook string or protocol change is required.** Existing installed hooks gain the behavior
   when they resolve the updated CLI, so seats do not need a hook refresh merely to receive the
   runtime backstop. The generated hook text remains subject to its existing epoch and common-dir
   ownership rules.

## Consequences

- Codex, Grok, Cursor, and Claude startup paths all attempt self-heal and produce a drift receipt;
  a clean receipt means the probe reached its cache write, while an absent or stale receipt remains
  actionable evidence of a missing/broken hook or CLI process.
- Claude may run the probe twice when both its machine-wide and local capture SessionStart hooks
  fire. The operation is safe: repair is inspect/re-inspect, writes are atomic, and the receipt is
  cache-throttled by the existing drift-cache policy.
- Hook execution remains fail-open. A dead daemon, malformed hook payload, missing binding, or
  failed local write cannot prevent the harness session from starting.
- No protocol schema, transport, runtime dependency, or permission-floor behavior changes.
- The architecture description now names the handler backstop rather than claiming that one hook
  string alone proves the probe ran.

## Observability & Evaluation

- **Traces.** The existing `.musterd/drift.json` receipt remains the local trace: it records the
  inspected timestamp, daemon build when known, and remaining guidance/hook/permission counts. No
  secrets, payload bodies, session ids, or transcript paths are added. Existing workspace-repair
  audit rows remain best-effort and unchanged.
- **Eval.** Unit regressions assert that Codex `start`, session `start`, and Cursor `observe --orient`
  invoke the injected probe with the payload-anchored workspace, and that `runSessionProbe` refreshes
  the receipt when self-heal throws. Baseline: the current Codex hook fires without writing a drift
  record and the MCP adapter reports UNKNOWN.
- **Experiment.** Run the focused CLI tests, then start a real Codex session in a provisioned
  workspace and verify that `.musterd/drift.json` is created before the first MCP inbox check. The
  expected result is a clean or explicit drift warning, never the absent-record UNKNOWN warning.
