# 425 — Governed launcher adapter handoff

- Status: proposed — 2026-09-19
- Date: 2026-09-19
- Builds on: [ADR 400](400-aperture-policy-generator.md), [ADR 402](402-tailscale-transport-generator.md), and [ADR 411](411-governed-model-authorization-substrate.md)
- Design: [Tailscale + Aperture paved road](../superpowers/specs/2026-09-02-tailscale-aperture-paved-road-design.md)
- Lane: `01M2XCYF5HTX0CPZ50R2F3V0QN`

## Context

ADR 411 shipped the server-owned governed authorization substrate: a secret-free Team policy,
durable Member-to-node checks, one-shot `msla_` launch handoffs, and structured authorization
decisions. ADR 400 and ADR 402 already produce reviewed Aperture and Tailscale artifacts without
mutating either external control plane. The paved-road design still lacks the local process boundary
that can carry a human-issued launch handoff into the two initial supported harnesses, Claude Code
and Codex.

The existing host backends are a different boundary. They actuate daemon residency and wake orders,
and Stanley's active lane owns their resume behavior. Reusing those files for model-routing launch
state would mix two meanings of launch and would put this work in an active overlapping lane.

## Problem

Without a shared adapter contract, each future launcher could invent its own endpoint variable,
Surface marker, model argument, or inherited environment. That makes it easy to accidentally retain a
direct provider key, launch a different model than the server-approved exact identifier, or emit a
process plan that looks like a governed launch while no server authorization was ever used.

The complete paved-road flow is not ready to activate: a persistent bridge, MCP correlation and
one-shot consumption, live Tailscale/Aperture configuration, provider routing, cost reconciliation,
and `required` activation remain separate work. This slice needs to create useful, testable local
handoff behavior without pretending those later boundaries exist.

## Decision

The CLI gains a pure governed-launch adapter module and typed `HttpClient` methods for the already
shipped governed policy and launch routes.

The adapter accepts a protocol-validated `GovernedLaunchAuthorizationMint`, an explicit target Team
and server, the target agent Member's existing agent key, an exact model identifier, an Aperture base
URL, the target Workspace, and a small inherited environment. It returns a process plan for exactly
one of the supported Surfaces:

- Claude Code uses `claude --model <exact-model>`, `ANTHROPIC_BASE_URL`, and
  `MUSTERD_LAUNCH_SURFACE=claude-code`.
- Codex uses `codex exec --json --model <exact-model> -C <workspace>`, `OPENAI_BASE_URL`, and
  `MUSTERD_LAUNCH_SURFACE=codex`.

Both plans carry the normal MCP identity fields plus the ephemeral governed handoff fields: launch
id, one-shot `msla_` token, node id, correlation, and Aperture base URL. Those values are returned to
the process environment only; the adapter does not print, persist, hash, or log them. The child
environment is an explicit allow-list of runtime paths/locales/terminal values and harness config
home paths, followed by the harness-specific Aperture endpoint and musterd identity. Provider key
variables, proxy credentials, arbitrary inherited variables, and other direct-provider environment
state do not pass through.

Endpoint validation requires HTTPS for remote Aperture origins, allows HTTP only for loopback test
origins, and refuses URL userinfo. The adapter refuses unknown harness names. Model, launch token,
and launch metadata are validated by existing `@musterd/protocol` schemas; this ADR adds no protocol
schema or runtime dependency.

The `HttpClient` adds parsed methods for governed policy read/write, launch issue, and launch revoke.
It does not add a command that issues credentials, consume a launch, start a child, call Aperture,
apply Tailscale/Aperture configuration, or activate `required`. A later ADR must connect the process
plan to a local bridge and MCP Presence while preserving the same server-owned authorization contract.

## Consequences

- Claude Code and Codex have one deterministic, unit-testable endpoint and environment handoff shape.
- Direct provider credential environment variables cannot leak through the adapter's child allow-list.
- The adapter is useful to a future launcher or wake integration without changing the existing
  residency host backends or their overlapping resume work.
- The one-shot handoff token exists in the launched child environment, so a later bridge/MCP
  integration must keep its lifetime bounded and must never put it in logs, Acts, generated tracked
  files, or telemetry. Node credentials remain outside this pure plan until the bridge boundary is
  designed.
- The process plan alone is not evidence of a governed Presence or an allowed provider request. The
  complete §13 acceptance remains open until launch consumption, live bridge identity, Aperture
  authorization, provider cost correlation, revocation, and both-harness integration matrices pass.
- Existing unmanaged Teams and direct musterd behavior remain unchanged, and governed enforcement
  remains `off` by default.

## Observability & Evaluation

- **Traces:** The new client methods preserve server audit behavior already defined by ADR 411. The
  adapter itself emits no telemetry and never records secrets, prompt/response bodies, provider keys,
  or arbitrary environment values. A future live launcher must correlate only launch id, node id,
  Member, Surface, and the explicit correlation id.
- **Eval:** Unit fixtures cover the two supported Surface plans, exact model arguments, URL policy,
  provider-key stripping, safe environment allow-list, unsupported harness refusal, and malformed
  server response refusal. Baseline is the existing Increment 3 substrate with no local process
  adapter. This slice does not claim the §13 live acceptance because no process is spawned and no
  external service is contacted.
- **Experiment:** none. Live Tailscale, Aperture, provider, and cost testing requires the separate
  authorized high-stakes Lane named by the paved-road design.
