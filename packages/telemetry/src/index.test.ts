import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resetTelemetryForTests,
  resolveOtlpEndpoint,
  startTelemetry,
  telemetryEnabled,
} from './index.js';

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

/** A throwaway machine config dir; `MUSTERD_CONFIG` points at its config.json (ADR 190 isolation). */
function tempConfig(contents: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-telemetry-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('resolveOtlpEndpoint — machine-config fallback (ADR 445 R3)', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('reads telemetry.otlp_endpoint from the machine config when no OTEL env is set', () => {
    const cfg = tempConfig({ telemetry: { otlp_endpoint: 'http://127.0.0.1:4318' } });
    cleanups.push(cfg.cleanup);
    expect(resolveOtlpEndpoint({ MUSTERD_CONFIG: cfg.path, VITEST: '1' })).toEqual({
      endpoint: 'http://127.0.0.1:4318',
      source: 'config',
    });
    expect(telemetryEnabled({ MUSTERD_CONFIG: cfg.path, VITEST: '1' })).toBe(true);
  });

  it('an explicit OTEL env wins over the file', () => {
    const cfg = tempConfig({ telemetry: { otlp_endpoint: 'http://from-file' } });
    cleanups.push(cfg.cleanup);
    expect(
      resolveOtlpEndpoint({
        MUSTERD_CONFIG: cfg.path,
        VITEST: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://from-env',
      }),
    ).toEqual({ endpoint: 'http://from-env', source: 'env' });
  });

  it('a signal-specific OTEL env counts as env, with no single endpoint to name', () => {
    expect(
      resolveOtlpEndpoint({ VITEST: '1', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t' }),
    ).toEqual({ endpoint: undefined, source: 'env' });
  });

  it('OTEL_SDK_DISABLED=true wins over both', () => {
    const cfg = tempConfig({ telemetry: { otlp_endpoint: 'http://from-file' } });
    cleanups.push(cfg.cleanup);
    expect(
      resolveOtlpEndpoint({ MUSTERD_CONFIG: cfg.path, VITEST: '1', OTEL_SDK_DISABLED: 'true' }),
    ).toBeUndefined();
    expect(
      resolveOtlpEndpoint({
        VITEST: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x',
        OTEL_SDK_DISABLED: 'true',
      }),
    ).toBeUndefined();
  });

  it('is off when the file is absent, unparseable, or has no telemetry key', () => {
    expect(resolveOtlpEndpoint({ MUSTERD_CONFIG: '/nonexistent/config.json', VITEST: '1' })).toBe(
      undefined,
    );
    const bad = tempConfig('{not json');
    cleanups.push(bad.cleanup);
    expect(resolveOtlpEndpoint({ MUSTERD_CONFIG: bad.path, VITEST: '1' })).toBeUndefined();
    const none = tempConfig({ server: 'http://localhost:4849' });
    cleanups.push(none.cleanup);
    expect(resolveOtlpEndpoint({ MUSTERD_CONFIG: none.path, VITEST: '1' })).toBeUndefined();
    const blank = tempConfig({ telemetry: { otlp_endpoint: '   ' } });
    cleanups.push(blank.cleanup);
    expect(resolveOtlpEndpoint({ MUSTERD_CONFIG: blank.path, VITEST: '1' })).toBeUndefined();
  });

  it('never reads the operator’s real ~/.musterd/config.json under vitest (ADR 190)', () => {
    // No MUSTERD_CONFIG override + VITEST set ⇒ the file path is not consulted at all.
    expect(resolveOtlpEndpoint({ VITEST: '1' })).toBeUndefined();
  });
});

describe('startTelemetry', () => {
  afterEach(() => resetTelemetryForTests());

  it('returns an inactive no-op handle when telemetry is off', async () => {
    const handle = await startTelemetry({ serviceName: 'musterd-test', env: { VITEST: '1' } });
    expect(handle.active).toBe(false);
    expect(handle.endpoint).toBeUndefined();
    await handle.shutdown(); // must be a harmless no-op
  });

  it('is idempotent per process — the first caller wins', async () => {
    const a = startTelemetry({ serviceName: 'musterd-test', env: { VITEST: '1' } });
    const b = startTelemetry({ serviceName: 'other', env: { VITEST: '1' } });
    expect(a).toBe(b);
  });

  it('starts a real SDK when enabled, and shutdown honors its hard cap on a dead collector', async () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' }; // nothing listens there
    const handle = await startTelemetry({ serviceName: 'musterd-test', env });
    expect(handle.active).toBe(true);
    expect(handle.endpoint).toBe('http://127.0.0.1:1');
    expect(handle.source).toBe('env');
    const t0 = Date.now();
    await handle.shutdown({ timeoutMs: 500 });
    // Bounded: the flush against a dead endpoint must not hold the exit past the cap (+ slack).
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('starts from the machine config alone, and says so on the handle', async () => {
    const cfg = tempConfig({ telemetry: { otlp_endpoint: 'http://127.0.0.1:1' } });
    try {
      const handle = await startTelemetry({
        serviceName: 'musterd-test',
        env: { MUSTERD_CONFIG: cfg.path, VITEST: '1' },
      });
      expect(handle.active).toBe(true);
      expect(handle.endpoint).toBe('http://127.0.0.1:1');
      expect(handle.source).toBe('config');
      await handle.shutdown({ timeoutMs: 500 });
    } finally {
      cfg.cleanup();
    }
  });
});
