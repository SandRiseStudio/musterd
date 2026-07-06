/**
 * The musterd telemetry SDK (ADR 089): the one OTLP bootstrap every component boots — the server
 * daemon, the MCP adapter, and the CLI — differing only in service name and resource attributes.
 * Extracted from `@musterd/server`'s ADR 015 bootstrap so the three copies can't drift.
 *
 * Posture (unchanged, ADR 015/082): **off by default** — the SDK starts only when the operator
 * points a standard `OTEL_EXPORTER_OTLP_*` env var at an endpoint — and **no phone-home, ever**.
 * When off, `@opentelemetry/api` calls are cheap no-ops and the heavy SDK is never even loaded
 * (dynamic import below).
 */

/** Telemetry is on iff the operator points us at an OTLP endpoint (and hasn't disabled the SDK). */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['OTEL_SDK_DISABLED'] === 'true') return false;
  return Boolean(
    env['OTEL_EXPORTER_OTLP_ENDPOINT'] ||
    env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ||
    env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
  );
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
  /**
   * Flush exporters and stop the SDK. `timeoutMs` bounds the flush — short-lived processes (the
   * CLI) must never hold their exit hostage to a dead collector; telemetry is best-effort.
   */
  shutdown(opts?: { timeoutMs?: number }): Promise<void>;
}

const NOOP_HANDLE: TelemetryHandle = {
  active: false,
  endpoint: undefined,
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
  if (!telemetryEnabled(env)) {
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

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: opts.serviceName,
        ...(opts.attributes ?? {}),
      }),
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
    });
    sdk.start();
    const endpoint =
      env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
      env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ??
      env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'];
    return {
      active: true,
      endpoint,
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
