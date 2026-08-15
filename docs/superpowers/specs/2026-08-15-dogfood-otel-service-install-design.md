# Dogfood OTEL daemon wiring

- **Status:** proposed — awaiting design review
- **Date:** 2026-08-15
- **Author:** gptbot
- **Relates to:** ADR 015, ADR 082, ADR 275

## Goal

Make the dogfood daemon export telemetry to its already-running local OTLP sink after a durable
service installation. The product remains off by default and no endpoint is introduced into the
protocol or shared configuration.

## Boundaries

This changes only the macOS daemon installer. It does not change server telemetry behavior,
protocol schemas, the OTLP sink, autorefresh, the wake host, or any non-dogfood installation.

## Design

### Dedicated installer flag

`musterd service install --otlp-endpoint <url>` writes the supplied URL as
`OTEL_EXPORTER_OTLP_ENDPOINT` in the daemon LaunchAgent's `EnvironmentVariables`. The flag is
accepted only for the daemon service, not `--live`, `--wake`, `--auto`, `--guardian`, or `--sweep`.

The dogfood operator installs with:

```sh
musterd service install --otlp-endpoint http://127.0.0.1:4318
```

The endpoint is a local URL, not a credential. The installer never prints arbitrary inherited
environment variables or the endpoint value in its normal success output.

### Preservation and clearing

The existing installer reads the prior daemon plist and preserves its non-`PATH` environment on a
reinstall. This behavior also preserves a previously configured OTLP endpoint. An explicitly
provided `--otlp-endpoint` replaces the stored endpoint. An empty value (`--otlp-endpoint ''`)
removes it, matching the existing `--allowed-hosts` clear convention.

`PATH` continues to be regenerated from the running CLI and is never preserved from an older
plist.

### Failure behavior

The flag only affects the generated plist. Invalid or unreachable endpoints do not block install:
the daemon's OTel bootstrap already owns exporter startup and failure handling. Launchd/bootstrap
errors retain the existing install failure behavior.

## Test matrix

| Case | Expected result |
| --- | --- |
| No endpoint flag, no prior endpoint | Generated plist has no OTLP endpoint. |
| Endpoint flag | Generated plist has the supplied `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| Prior endpoint, no flag | Reinstall preserves the prior endpoint. |
| Prior endpoint, replacement flag | Reinstall writes the replacement endpoint. |
| Empty endpoint flag | Generated plist removes the endpoint while retaining unrelated daemon env. |
| Other service target | The daemon-only flag is refused rather than silently changing another agent. |

## Risks and safeguards

- This is explicitly a dogfood install action, not a product-default telemetry change; no endpoint
  is baked into source or selected automatically.
- The endpoint remains local operator configuration in the LaunchAgent plist. Secrets must not be
  passed through this flag.
- Tests cover the pure environment-resolution path, so a future installer rewrite cannot drop the
  endpoint silently.
