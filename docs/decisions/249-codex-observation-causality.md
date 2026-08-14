# 249 — Codex model observation requires causal session evidence

- Status: proposed
- Date: 2026-08-05

## Context

Reserved before authoring under ADR 223.

ADR 158 made an observation higher-trust than a declared model, but its usable
observation path is a Claude Code SessionStart/PostToolUse hook. Cursor has a
separate observed-event path. Codex is represented as a valid Surface and can
be wired with an MCP server, yet it has neither path on current main. A Codex
seat can therefore work indefinitely with a declared `surface` and model while
the roster describes both as though they were observed facts.

This is now a supported Codex capability, not a hypothetical integration. The
current Codex hooks contract supplies the current `session_id`, `cwd`,
`transcript_path`, `hook_event_name`, and active `model` to command hooks on
stdin. Project hooks are separately trusted, run with the session working
directory, and are loaded only for trusted project layers. That makes the
event payload a causal witness: a Codex hook could only have supplied it while
Codex was executing that session in that workspace. A rollout-log filename,
the declared Surface, or a stale prior binding cannot provide that fact.

An earlier, unmerged experiment installed broad Codex hooks and treated a
SessionStart capture as enough. It is not a safe base: a fresh session's
transcript has no assistant turn yet, external hook input needs a protocol
boundary, and the prior experiment did not state which event proves which
claim. Restoring it mechanically would turn its historical implementation
choices into an undocumented contract.

## Problem

The two fields that identify a live agent are epistemically different from
their current Codex sources:

- `surface: codex` is configuration, not proof that Codex ran here; and
- `model` is a declaration (or, at best, a rollout-log inference that may
  predate this session), not the model the live Codex process reported.

Consequently a stale MCP entry can describe a non-Codex session as Codex, and
a Codex session can be excluded from model-aware review and telemetry while
appearing fully attested. Treating a model parsed from a transcript at
SessionStart as current merely substitutes one stale observation for another.

We need a narrow path that records only causally witnessed facts, keeps session
identity local, and fails honestly when hooks are absent, untrusted, malformed,
or unavailable. It must not turn hook output into an enforcement, approval, or
daemon-wake bypass.

## Decision

### 1. Codex gets a project-local observational hook path

Provisioning a Codex workspace installs marker-owned command hooks in
`.codex/hooks.json`, preserving all non-musterd handlers and removing only
marker-owned handlers on unprovision. The required events are:

- `SessionStart` and `SessionEnd` for local continuity capture; and
- `PostToolUse` for a fresh model observation and the existing low-cost
  interrupt check.

The hooks are configuration, not evidence. A hook that Codex has not reviewed
and trusted is absent for musterd purposes; `init --check` reports that state
without claiming that a declaration is corroborated. Hook commands are
best-effort and bounded: malformed input, no binding, or an unreachable daemon
must not fail or delay the Codex session.

### 2. The hook event is the causal boundary

Codex hook stdin is parsed through a dedicated protocol-owned schema before it
is used. The schema accepts only the documented common fields and the expected
event name. The command rejects an event/subcommand mismatch without writing a
binding.

On a valid `SessionStart`, the hook records a local `SessionCapture` with
`harness: 'codex'`, the exact session id, reported transcript path when
present, and the hook's workspace. `SessionEnd` can end only that same capture.
Session ids and transcript paths remain in the gitignored, mode-0600 binding;
the daemon receives only the existing harness-class start/end attestation.

On `PostToolUse`, the hook records the active `model` value directly from the
Codex event as `model_observed: { model, harness: 'codex', observed_at }`.
This direct event field outranks both a declaration and a transcript parse.
The adapter's heartbeat reloads the binding, so an observation made after
adapter boot reaches the live Presence without requiring a reconnect.

The same event is proof that Codex, rather than a declaration, ran the
workspace. It may drive the existing **warning-only** Surface-drift diagnostic;
it does not silently rewrite `surface` or override an explicit environment
override.

### 3. No inferred or unaudited expansion of authority

The hook receives no credential in argv and returns only bounded, non-secret
context. It does not decide permissions, alter sandbox/approval settings, or
introduce a production hook-trust bypass. It does not create a new daemon
protocol field or make desktop Codex wakeable. The CLI backend and desktop
boundary of ADR 216 remain unchanged.

Transcript parsing remains a best-effort fallback for local liveness and old
captures only. It can never manufacture the current Codex model observation
when the current hook event did not provide one.

## Consequences

- A live Codex session can attest both its actual Surface and active model from
  the harness event that caused the claim, rather than from a configuration
  declaration.
- A Codex workspace without trusted hooks is honestly declaration-only; it
  keeps coordination working but no longer looks observed by implication.
- The binding gains no new durable secret and the server/protocol wire contract
  stays unchanged apart from the local hook-input validation schema.
- The CLI gains a Codex-hook command and reversible project-hook renderer,
  alongside hermetic tests for input validation, ownership-preserving JSON
  edits, capture ordering, and model/surface causality.
- Documentation must distinguish a configured Codex MCP server from a Codex
  session that has supplied hook evidence.

## Observability & Evaluation

**Traces.** n/a — the evidence is local binding state and the existing
warning-only surface-drift diagnostic; this change adds no wire field or
telemetry payload.

**Eval.** Baseline: a configured Codex workspace has no causal capture or
model observation, so `musterd init --check` can report only the MCP entry and
the roster can use the declared model. Success is a trusted hook fixture where
`SessionStart` captures only its own `session_id`, `PostToolUse` replaces the
declaration with its `model`, and the next adapter heartbeat re-attests that
model. The falsifiers are a malformed/event-mismatched payload changing the
binding, `SessionEnd` erasing a newer capture, or a model inferred from a
transcript rather than the `PostToolUse` payload.

**Experiment.** n/a — the control is known to be declaration-only, which is
the defect being removed; an A/B arm would intentionally preserve a stale
model observation.

The doctor reports the three independent states: MCP entry present, required
hook definitions present, and hook trust/runtime evidence available. A
Surface-drift warning names a contradiction only after a Codex hook has
captured this workspace; it remains silent for an unobserved Codex declaration.

Reference: the current official Codex Hooks documentation, consulted
2026-08-05, specifies project-layer trust, the hook input fields, and
`SessionStart`/`SessionEnd`/`PostToolUse` timing.
