import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The musterd telemetry SDK (ADR 089): the one OTLP bootstrap every component boots — the server
 * daemon, the MCP adapter, and the CLI — differing only in service name and resource attributes.
 * Extracted from `@musterd/server`'s ADR 015 bootstrap so the three copies can't drift.
 *
 * Posture (unchanged, ADR 015/082): **off by default** — the SDK starts only when the operator
 * points a standard `OTEL_EXPORTER_OTLP_*` env var at an endpoint — and **no phone-home, ever**.
 * When off, `@opentelemetry/api` calls are cheap no-ops and the heavy SDK is never even loaded
 * (dynamic import below).
 *
 * ADR 445 R3 widens WHERE the operator's pointer may live, not WHO decides: when no `OTEL_*`
 * endpoint env is set, the machine config (`~/.musterd/config.json`, `telemetry.otlp_endpoint`,
 * written by `musterd service install --otlp-endpoint`) is consulted. The MCP adapter and the CLI
 * are launched by the harness and the user's shell, whose env the daemon's plist never reaches —
 * measured 2026-09-24: 0 adapter/CLI spans in the dogfood sink beside 3,667 daemon spans. The
 * registration env itself stays exactly the launch marker (ADR 286 §1); the file is the seam.
 */

/** Where the OTLP endpoint came from — `env` is the standard OTel way, `config` the ADR 445 file. */
export type EndpointSource = 'env' | 'config';

export interface ResolvedEndpoint {
  /**
   * The single generic endpoint, when one is known. `undefined` with `source: 'env'` means only a
   * signal-specific `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` is set — the SDK reads those itself.
   */
  endpoint: string | undefined;
  source: EndpointSource;
}

/** The machine config path, as the CLI resolves it (`MUSTERD_CONFIG` override, else `~/.musterd`). */
function machineConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const override = env['MUSTERD_CONFIG'];
  if (override) return override;
  // ADR 190: under vitest the override is mandatory — never touch the operator's real config from a
  // test. The CLI throws here; a telemetry probe just stays off.
  if (env['VITEST']) return undefined;
  return join(homedir(), '.musterd', 'config.json');
}

/** `telemetry.otlp_endpoint` from the machine config, or undefined for any reason at all. */
function endpointFromConfig(env: NodeJS.ProcessEnv): string | undefined {
  const path = machineConfigPath(env);
  if (!path) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const telemetry = (parsed as { telemetry?: unknown }).telemetry;
    if (typeof telemetry !== 'object' || telemetry === null) return undefined;
    const endpoint = (telemetry as { otlp_endpoint?: unknown }).otlp_endpoint;
    if (typeof endpoint !== 'string') return undefined;
    const trimmed = endpoint.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the OTLP endpoint the operator pointed us at, in the order that keeps the standard OTel
 * env authoritative: `OTEL_SDK_DISABLED=true` → off; any `OTEL_EXPORTER_OTLP_*` endpoint env → env;
 * else the machine config's `telemetry.otlp_endpoint` → config; else off (`undefined`).
 */
export function resolveOtlpEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEndpoint | undefined {
  if (env['OTEL_SDK_DISABLED'] === 'true') return undefined;
  const generic = env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (generic) return { endpoint: generic, source: 'env' };
  if (env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] || env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']) {
    return { endpoint: undefined, source: 'env' };
  }
  const fromConfig = endpointFromConfig(env);
  return fromConfig ? { endpoint: fromConfig, source: 'config' } : undefined;
}

/** Telemetry is on iff the operator pointed us at an OTLP endpoint (and hasn't disabled the SDK). */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveOtlpEndpoint(env) !== undefined;
}

export interface TelemetryOptions {
  /** OTel `service.name` — `musterd-server`, `musterd-mcp`, or `musterd-cli`. */
  serviceName: string;
  /**
   * Extra resource attributes stamped on everything this process emits — e.g. the adapter's seat
   * identity (`musterd.team`, `musterd.member.id` normalized per issue #107, `musterd.member` raw).
   */
  attributes?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}

export interface TelemetryHandle {
  /** Whether an SDK actually started (false = telemetry off, everything is a no-op). */
  readonly active: boolean;
  /** The OTLP endpoint in effect, for the caller's own startup log line. */
  readonly endpoint: string | undefined;
  /** Where that endpoint came from (ADR 445 R3); undefined when off. */
  readonly source: EndpointSource | undefined;
  /**
   * Flush exporters and stop the SDK. `timeoutMs` bounds the flush — short-lived processes (the
   * CLI) must never hold their exit hostage to a dead collector; telemetry is best-effort.
   */
  shutdown(opts?: { timeoutMs?: number }): Promise<void>;
}

const NOOP_HANDLE: TelemetryHandle = {
  active: false,
  endpoint: undefined,
  source: undefined,
  shutdown: async () => {},
};

let started: Promise<TelemetryHandle> | null = null;

/**
 * Start the OTel NodeSDK if enabled, returning a handle with a bounded shutdown/flush. No-op +
 * instant resolve when disabled. Idempotent per process (the first caller's options win — a
 * process has one service identity, which is why `serve` must not boot the CLI's SDK, ADR 089).
 */
export function startTelemetry(opts: TelemetryOptions): Promise<TelemetryHandle> {
  if (started) return started;
  const env = opts.env ?? process.env;
  const resolved = resolveOtlpEndpoint(env);
  if (!resolved) {
    started = Promise.resolve(NOOP_HANDLE);
    return started;
  }
  started = (async () => {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');

    // From env, the exporters read the standard variables themselves (generic + per-signal). From
    // the config file there is no env to read, so the per-signal URLs are passed explicitly — the
    // same `<endpoint>/v1/<signal>` the OTel spec derives from a generic endpoint.
    const explicit =
      resolved.source === 'config' && resolved.endpoint
        ? { base: resolved.endpoint.replace(/\/+$/, '') }
        : undefined;
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: opts.serviceName,
        ...(opts.attributes ?? {}),
      }),
      traceExporter: new OTLPTraceExporter(explicit ? { url: `${explicit.base}/v1/traces` } : {}),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(explicit ? { url: `${explicit.base}/v1/metrics` } : {}),
      }),
    });
    sdk.start();
    const endpoint =
      resolved.endpoint ??
      env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ??
      env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'];
    return {
      active: true,
      endpoint,
      source: resolved.source,
      shutdown: async ({ timeoutMs }: { timeoutMs?: number } = {}) => {
        const flush = sdk.shutdown();
        if (timeoutMs === undefined) return flush;
        let timer: NodeJS.Timeout | undefined;
        const cap = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        });
        await Promise.race([flush.catch(() => {}), cap]).finally(() => clearTimeout(timer));
      },
    };
  })();
  return started;
}

/** Reset the start guard. Tests only — lets a suite register a fresh in-memory provider. */
export function resetTelemetryForTests(): void {
  started = null;
}
