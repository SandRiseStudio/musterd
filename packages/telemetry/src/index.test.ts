import { afterEach, describe, expect, it } from 'vitest';
import { resetTelemetryForTests, startTelemetry, telemetryEnabled } from './index.js';

describe('telemetryEnabled (off by default, ADR 015 posture)', () => {
  it('is off with no OTEL env', () => {
    expect(telemetryEnabled({})).toBe(false);
  });
  it('is on when any standard OTLP endpoint is present', () => {
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBe(true);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://x' })).toBe(true);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://x' })).toBe(true);
  });
  it('stays off when the SDK is explicitly disabled, even with an endpoint', () => {
    expect(
      telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x', OTEL_SDK_DISABLED: 'true' }),
    ).toBe(false);
  });
});

describe('startTelemetry', () => {
  afterEach(() => resetTelemetryForTests());

  it('returns an inactive no-op handle when telemetry is off', async () => {
    const handle = await startTelemetry({ serviceName: 'musterd-test', env: {} });
    expect(handle.active).toBe(false);
    expect(handle.endpoint).toBeUndefined();
    await handle.shutdown(); // must be a harmless no-op
  });

  it('is idempotent per process — the first caller wins', async () => {
    const a = startTelemetry({ serviceName: 'musterd-test', env: {} });
    const b = startTelemetry({ serviceName: 'other', env: {} });
    expect(a).toBe(b);
  });

  it('starts a real SDK when enabled, and shutdown honors its hard cap on a dead collector', async () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' }; // nothing listens there
    const handle = await startTelemetry({ serviceName: 'musterd-test', env });
    expect(handle.active).toBe(true);
    expect(handle.endpoint).toBe('http://127.0.0.1:1');
    const t0 = Date.now();
    await handle.shutdown({ timeoutMs: 500 });
    // Bounded: the flush against a dead endpoint must not hold the exit past the cap (+ slack).
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
