# Codex observation causality implementation plan

**Goal:** Let a trusted Codex project hook attest the active Codex session and
model without letting configuration, transcript inference, or stale local
state impersonate that evidence.

**Architecture:** A protocol-owned, local-only schema validates the documented
Codex hook input. A dedicated CLI subcommand maps each validated event to the
existing local session-capture and model-observation mechanisms. The Codex
onboarding adapter owns reversible `.codex/hooks.json` edits; it does not alter
the MCP configuration or the daemon protocol.

**Constraints:** ADR 249; no new runtime dependency; no daemon protocol or
database change; raw session ids and transcript paths remain local; hook
commands never receive credentials in argv; malformed hook input exits zero
without a write; no production hook-trust bypass.

## File map

- `packages/protocol/src/codexHooks.ts` — strict external-input schemas and
  event-to-local-action parsing.
- `packages/protocol/src/codexHooks.test.ts` — boundary and mismatch tests.
- `packages/protocol/src/index.ts` — protocol export.
- `packages/cli/src/commands/session.ts` — Codex hook dispatcher and
  harness-selected capture/observation paths.
- `packages/cli/src/commands/session.test.ts` — persisted capture, observation,
  race, and malformed-input evidence.
- `packages/cli/src/onboard/harnesses/codex.ts` — marker-owned project hook
  install/removal and doctor state.
- `packages/cli/src/onboard/harnesses/codex.test.ts` — ownership-preserving
  hook-file configuration tests.
- `docs/architecture/02-protocol.md`, `docs/architecture/04-cli.md`,
  `docs/architecture/05-mcp.md`, `docs/architecture/06-testing.md` — current
  implementation and verification contract.

## Increment 1 — validate the event before it can affect a binding

- [ ] Add a failing `CodexHookEventSchema` test for each accepted event:
  `SessionStart`, `SessionEnd`, and `PostToolUse`.
- [ ] Add failing negative tests for a missing/empty `session_id`, an unknown
  event, and an event/subcommand mismatch. Assert unknown fields are stripped
  and no schema exposes a credential field.
- [ ] Add `packages/protocol/src/codexHooks.ts`; use a discriminated event
  schema with bounded non-empty string fields (`session_id`, `cwd`, optional
  `transcript_path`, and `model` only for `PostToolUse`) and a pure
  `parseCodexHookEvent(raw, expected)` helper that returns `undefined` on any
  invalid external input.
- [ ] Export the helper and schema from `index.ts`; update the protocol source
  tree in `02-protocol.md`.
- [ ] Run `pnpm --filter @musterd/protocol test -- codexHooks` and record the
  red/green result before committing.

## Increment 2 — make a valid event the only capture and observation writer

- [ ] Add a failing CLI test: a valid `SessionStart` records a local capture
  with `harness: 'codex'`, its exact id/path, and a start attestation; a valid
  `SessionEnd` only ends that same capture.
- [ ] Add a failing CLI test: `PostToolUse` writes `model_observed` directly
  from its `model`, retains the capture, and does not require a transcript.
- [ ] Add failing regression tests proving an event/subcommand mismatch,
  malformed JSON, an absent binding, and an older SessionEnd leave the binding
  unchanged. The production change that makes these fail is accepting a raw
  payload or calling the generic Claude capture path.
- [ ] Implement `musterd session codex-hook <start|end|post-tool-use> --stdin`.
  It calls the protocol parser before resolving a workspace, uses the payload
  `cwd`/explicit binding anchor, and shares the existing best-effort attestation
  write with an explicit `harness: 'codex'`. It must always return zero for
  hook input failures.
- [ ] Preserve Claude and Cursor entry points and make the shared capture
  helper accept a harness argument instead of assigning `claude-code`.
- [ ] Run the focused CLI command tests, then `pnpm --filter @musterd/cli test`.

## Increment 3 — own the project hook configuration and document the boundary

- [ ] Add failing onboarding tests showing that installation creates
  `.codex/hooks.json` with marker-owned commands for `SessionStart`,
  `SessionEnd`, and `PostToolUse`; a second install is idempotent; user entries
  remain intact; removal deletes only marker-owned entries.
- [ ] Add a failing doctor test that differentiates configured MCP only from
  configured MCP plus complete musterd hook definitions. It must not call the
  latter runtime evidence or hook trust.
- [ ] Implement the minimal JSON renderer/parser in the Codex harness adapter.
  Invoke install after MCP configuration and remove on unprovision/uninstall;
  preserve an unparsable user hook file and report a warning instead of
  overwriting it.
- [ ] Update architecture/testing docs: hooks are project-local configuration;
  observed surface/model evidence begins only after the valid event is handled;
  tests are hermetic and no paid Codex invocation is added.
- [ ] Run `pnpm typecheck && pnpm format:check`, then commit the increment with
  `Refs ADR-249` and the `gptbot` co-author trailer.

## Verification and handoff

- [ ] Re-read ADR 249 against the implementation: no credentials in argv, no
  session id/path on the wire, no automatic Surface rewrite, no desktop wake
  claim, and no transcript-derived current model.
- [ ] Run `pnpm -r build && pnpm -r lint && pnpm test` and inspect the complete
  result before creating or updating the PR.
- [ ] Push with `--force-with-lease`; enable squash auto-merge only after the
  required gate is green; then submit the claimed lane for outcome acceptance.
