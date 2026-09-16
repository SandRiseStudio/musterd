# 405 — The governed-transport credential guard is prefix-specific

- Status: proposed
- Date: 2026-09-15

## Context

ADR 402 introduced the committed governed-transport manifest as a secret-free input to a
deterministic policy renderer. Its first implementation guarded this by applying a broad
case-insensitive substring expression to the raw manifest and rendered artifacts. In addition to
the Musterd credential prefixes, that expression matched ordinary words such as `token` and
`secret`.

## Problem

The guard rejects valid configuration solely because an opaque Member or node key contains an
ordinary English substring. A Member named `secretary` and a node key named `tokenizer-box-01` both
fail with an accusation that the source resembles a credential, despite containing no credential.
That is a false positive in a safety control and prevents a valid least-privilege policy from being
generated.

## Decision

The governed-transport manifest rejects only a value that begins with a concrete Musterd
credential prefix: `mskey_`, `msgr_`, `mscr_`, `msac_`, or `msls_` (case-insensitive). It applies
this rule to the parsed manifest's user-provided values, not to raw JSON text or serialized output.

The renderer produces its policy only from the validated manifest, governed workload identities,
and fixed structural literals. It does not repeat a separate substring scan over its serialized
output. Schema validation remains the boundary that prevents a Musterd credential from entering
the transport configuration.

## Consequences

- Legitimate opaque values containing words such as `secretary`, `tokenizer`, `passwordless`, or
  `api-key` can participate in a transport policy.
- A literal Musterd credential remains refused before rendering or file writes.
- This is a narrower protection than heuristic secret classification. It is deliberately precise:
  the transport manifest has no field that accepts arbitrary third-party credential material, and
  its strict schema refuses unrecognized fields. A new field that could carry a credential needs
  its own explicit validation rule and ADR.

## Observability & Evaluation

**Traces** — validation reports that a manifest contains a Musterd credential without echoing its
value. The renderer continues to write no source manifest or generated content to diagnostics.

**Eval** — protocol tests accept `secretary` and `tokenizer-box-01`, while rejecting `mskey_…`.
The renderer test reads a committed manifest using both ordinary values. The baseline was the
reported false positive: both names failed before this decision.

**Experiment** — run `musterd integration generate tailscale --check` with the valid fixture and
with each Musterd credential prefix at the start of a manifest value. The former must reach the
normal stale/current result; every credential fixture must fail before a generated artifact is
written.
