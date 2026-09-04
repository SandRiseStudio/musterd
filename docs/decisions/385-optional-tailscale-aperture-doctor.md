# 385 — Optional Tailscale and Aperture doctor

- Status: proposed — 2026-09-04
- Date: 2026-09-04
- Builds on: [ADR 039](039-cross-network-teams.md), [ADR 040](040-secured-non-loopback-bind.md), and [ADR 325](325-multi-machine-federation.md)
- Lane: `01M1J1F48R76ANNR2FD5TTTYDP`

## Context

The approved Tailscale + Aperture paved-road design separates private Team transport from governed model access. Its first increment is evidence-only: an operator needs to verify transport and an Aperture configuration without musterd taking control of either external system.

Topology B verification is currently manual. It cannot show, in one secret-safe result, whether a daemon is safely served through a tailnet, whether its Host gate permits the actual tailnet path, or whether Aperture has the reference retention, identity, grant, and quota posture.

## Problem

Provide a stable diagnostic surface that makes both integrations explicitly optional, checks the path Members actually use, and reports configuration readiness without implying that musterd manages devices, sandboxes Members, or is actively enforcing Aperture policy.

## Decision

### 1. An explicitly selected, read-only doctor

The CLI will provide `musterd integration doctor [--tailscale] [--aperture <https-url>] [--json]`. Each flag independently opts into its inspection. With neither flag, both integrations render as healthy `off` and the command exits 0. A selected failed or unparseable check exits 1; invalid invocation exits 2. JSON stdout is exactly the version-1 integration doctor report, with no ANSI or commentary.

The report has separate `tailscale` and `aperture` sections. A green selected Tailscale section is `verified`; a green selected Aperture section is `ready`, while its human heading says model enforcement remains `off`. There is no durable `partial` state, no stored verification timestamp, and no activation behavior in this increment. Its JSON `observed_at` is an observation, not drift history.

### 2. Tailscale transport is verified empirically and never mutated

The selected Tailscale inspection runs only `tailscale version`, `tailscale status --json`, and `tailscale serve status --json`. It makes bounded GET and WebSocket-upgrade probes. It never runs `tailscale up`, `tailscale serve`, a daemon write endpoint, or a shell-string command.

It runs on the daemon host and proves the safe local pattern: a loopback daemon behind Tailscale Serve. Its ordered checks are `tailscale-installed`, `tailnet-up`, `daemon-secured-bind`, `tailscale-serve`, `daemon-host-gate`, `daemon-http`, and `daemon-websocket`. The Host gate is tested for both MagicDNS and the device IPv4 address; HTTP and WebSocket are tested over the actual tailnet route. A non-loopback plaintext configured daemon, unsupported remote origin, or IPv6-only configuration fails with manual guidance rather than a guess.

### 3. Aperture configuration is inspected only

For a selected `--aperture` URL, the CLI makes one bounded three-second `GET <url>/api/config` through the caller's existing Tailscale identity. HTTPS is required except for loopback test URLs. There is no bearer-token flag, mutation endpoint, configuration application action, or production dogfood requirement.

The inspector parses the response's HuJSON/JWCC configuration, then reports only a redacted host, an eight-character lowercase hexadecimal configuration hash (or `present`), provider names and model counts, and pass/fail repairs. It checks `aperture-config-api`, `aperture-retention`, `aperture-providers`, `aperture-grants`, `aperture-quotas`, and `aperture-identities`.

Ready requires zero retention for captures and tools, no export requirement, at least one HTTPS provider and model, exact persistent Member workload-tag sources with no wildcard, group, user, or shared-tag-only source, non-admin agent identities, and rejecting defined quota buckets for every model grant. Connector and tool capabilities are not a positive claim. Raw response/config bodies, provider credentials, prompt or response content, Tailscale credentials, musterd credentials, and hook secrets never appear in rendered output, logs, or the JSON report.

### 4. Protocol owns the diagnostic boundary schemas

`@musterd/protocol` owns Zod schemas for every external field read from Tailscale and Aperture and for the stable report. Vendor-owned levels are permissive for forward compatibility, while each field inspectors read is typed. The report itself is strict and checks that a selected failed section cannot claim top-level success.

These are local diagnostic/vendor schemas, not protocol frames. `musterd/0.3` remains unchanged and the server gains no route, storage, federation, authorization, or persistent state.

### 5. JSON5 is the direct CLI parser dependency

The CLI will add `json5@2.2.3` because Aperture's configuration response is HuJSON/JWCC. Unsafe comment stripping, treating HuJSON as JSON, and asking Aperture to mutate or validate a candidate merely to read the current posture are rejected: they are either incorrect or violate the read-only boundary.

## Alternatives considered

- **Treat an unselected integration as a failure.** Rejected: both integrations are optional, and absence is a valid `off` posture.
- **Report Aperture as `required` after its checks pass.** Rejected: readiness proves configuration, not participating harness coverage or active enforcement.
- **Check only policy or plist text for Tailscale.** Rejected: Members need the actual served, Host-gated HTTP and WebSocket path to work.
- **Use an Aperture mutation endpoint for verification.** Rejected: it turns diagnostics into control-plane ownership and requires credentials the doctor does not need.

## Consequences

- Operators get one local evidence surface for any of the four optional combinations; running it makes no external configuration changes.
- Increment 1 can honestly say Tailscale transport is verified or Aperture configuration is ready, but cannot claim device management, sandbox enforcement, unrelated-harness coverage, or Aperture enforcement.
- The protocol package gains dependency-free Zod schemas; the CLI gains the direct `json5` runtime dependency. Later activation, generated configuration, API application, or enforcement needs a new ADR and its own authorization boundary.

## Observability & Evaluation

- **Traces.** The report has a non-secret `observed_at`, stable check keys, selected state, posture, and redacted details only. Failures identify the manual repair without retaining an upstream body.
- **Eval.** Dataset: hermetic protocol and CLI fixtures plus injected subprocess, fetch, and upgrade fakes. Baseline: manual Topology B and Aperture verification has no machine-readable result and can accidentally disclose configuration. After: all four selection combinations, failure ladders, wrong vendor shapes, retention/grant/quota/identity drift, and response-redaction cases are asserted.
- **Experiment.** Before a later activation increment, collect only secret-free doctor results in an authorized dogfood environment. The prediction is that a selected failure names one concrete manual repair and a non-selected integration is always `off`, never a false warning. A report that exposes a credential-like value or describes Aperture as enforced falsifies this increment.
