import type { IntegrationCheck } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { setColorEnabled } from '../render/theme.js';
import { composeIntegrationReport, INTEGRATION_LIMITS, renderIntegrationReport } from './report.js';
import { IntegrationDoctorReportSchema } from '@musterd/protocol';

setColorEnabled(false);

const tailscaleChecks: IntegrationCheck[] = [
  { key: 'tailscale-installed', label: 'tailscale installed', state: 'ok', detail: '1.80.0' },
  {
    key: 'tailnet-up',
    label: 'tailnet up',
    state: 'ok',
    detail: 'daemon.tailnet.ts.net · 100.64.0.10',
  },
  {
    key: 'daemon-secured-bind',
    label: 'daemon secured bind',
    state: 'ok',
    detail: 'loopback behind tailscale serve',
  },
  {
    key: 'tailscale-serve',
    label: 'tailscale serve',
    state: 'ok',
    detail: 'tcp/4849 → 127.0.0.1:4849',
  },
  {
    key: 'daemon-host-gate',
    label: 'daemon Host gate',
    state: 'ok',
    detail: 'daemon.tailnet.ts.net and 100.64.0.10 accepted',
  },
  {
    key: 'daemon-http',
    label: 'daemon HTTP',
    state: 'ok',
    detail: '/health reachable over the tailnet',
  },
  {
    key: 'daemon-websocket',
    label: 'daemon WebSocket',
    state: 'ok',
    detail: '/ws upgrade reachable over the tailnet',
  },
];

const apertureChecks: IntegrationCheck[] = [
  {
    key: 'aperture-config-api',
    label: 'Aperture config API',
    state: 'ok',
    detail: 'aperture.tailnet.ts.net · hash 8d14c921',
  },
  {
    key: 'aperture-retention',
    label: 'body retention',
    state: 'ok',
    detail: 'zero; captures and tools purged',
  },
  { key: 'aperture-providers', label: 'providers', state: 'ok', detail: 'anthropic (2 models)' },
  {
    key: 'aperture-grants',
    label: 'default grants',
    state: 'ok',
    detail: 'exact Member workload identities; no wildcard source',
  },
  {
    key: 'aperture-quotas',
    label: 'quotas',
    state: 'ok',
    detail: 'every model grant has a rejecting, defined bucket',
  },
  {
    key: 'aperture-identities',
    label: 'identity prerequisites',
    state: 'ok',
    detail: 'persistent Member tags are exact and non-admin',
  },
];

function compose(input: Partial<Parameters<typeof composeIntegrationReport>[0]> = {}) {
  return composeIntegrationReport({
    observedAt: 1,
    tailscaleSelected: false,
    tailscaleChecks: [],
    apertureSelected: false,
    apertureChecks: [],
    ...input,
  });
}

describe('integration doctor report composition (ADR 385)', () => {
  it.each([
    ['neither', false, false, 'off', 'off'],
    ['Tailscale only', true, false, 'verified', 'off'],
    ['Aperture only', false, true, 'off', 'ready'],
    ['both', true, true, 'verified', 'ready'],
  ] as const)(
    'composes %s selection independently',
    (_name, tailscaleSelected, apertureSelected, tailscalePosture, aperturePosture) => {
      const report = compose({
        tailscaleSelected,
        tailscaleChecks,
        apertureSelected,
        apertureChecks,
      });
      expect(report.tailscale.posture).toBe(tailscalePosture);
      expect(report.aperture.posture).toBe(aperturePosture);
      expect(report.tailscale.checks).toEqual(tailscaleSelected ? tailscaleChecks : []);
      expect(report.aperture.checks).toEqual(apertureSelected ? apertureChecks : []);
      expect(report.ok).toBe(true);
      expect(IntegrationDoctorReportSchema.parse(report)).toEqual(report);
    },
  );

  it('blocks only a selected section with a failed check while preserving skipped dependants', () => {
    const failed = [
      { ...tailscaleChecks[0]!, state: 'fail' as const, fix: 'Install it.' },
      { ...tailscaleChecks[1]!, state: 'skip' as const },
    ];
    const report = compose({ tailscaleSelected: true, tailscaleChecks: failed });
    expect(report.ok).toBe(false);
    expect(report.tailscale.posture).toBe('blocked');
    expect(report.tailscale.checks[1]?.state).toBe('skip');
    expect(IntegrationDoctorReportSchema.parse(report)).toEqual(report);
  });

  it('uses the two locked non-claims', () => {
    expect(INTEGRATION_LIMITS).toEqual([
      'configuration and reachability evidence only; Aperture enforcement remains off',
      'no device management, sandbox enforcement, or unrelated-harness coverage',
    ]);
  });
});

describe('integration doctor terminal frame (ADR 385)', () => {
  it('matches the locked no-color combined frame exactly', () => {
    const report = compose({
      tailscaleSelected: true,
      tailscaleChecks,
      apertureSelected: true,
      apertureChecks,
    });
    expect(renderIntegrationReport(report)).toBe(`integration doctor

TAILSCALE TRANSPORT — verified
✓ tailscale installed — 1.80.0
✓ tailnet up — daemon.tailnet.ts.net · 100.64.0.10
✓ daemon secured bind — loopback behind tailscale serve
✓ tailscale serve — tcp/4849 → 127.0.0.1:4849
✓ daemon Host gate — daemon.tailnet.ts.net and 100.64.0.10 accepted
✓ daemon HTTP — /health reachable over the tailnet
✓ daemon WebSocket — /ws upgrade reachable over the tailnet

APERTURE MODEL ENFORCEMENT — off (configuration ready)
✓ Aperture config API — aperture.tailnet.ts.net · hash 8d14c921
✓ body retention — zero; captures and tools purged
✓ providers — anthropic (2 models)
✓ default grants — exact Member workload identities; no wildcard source
✓ quotas — every model grant has a rejecting, defined bucket
✓ identity prerequisites — persistent Member tags are exact and non-admin

LIMITS
· configuration and reachability evidence only; Aperture enforcement remains off
· no device management, sandbox enforcement, or unrelated-harness coverage`);
  });

  it('renders failures and skips with their repair without changing the posture rules', () => {
    const report = compose({
      tailscaleSelected: true,
      tailscaleChecks: [
        {
          key: 'tailscale-installed',
          label: 'tailscale installed',
          state: 'fail',
          detail: 'unavailable',
          fix: 'Install Tailscale.',
        },
        { key: 'tailnet-up', label: 'tailnet up', state: 'skip', detail: 'tailscale unavailable' },
      ],
    });
    const rendered = renderIntegrationReport(report);
    expect(rendered).toContain('TAILSCALE TRANSPORT — blocked');
    expect(rendered).toContain('✗ tailscale installed — unavailable');
    expect(rendered).toContain('  → Install Tailscale.');
    expect(rendered).toContain('· tailnet up — tailscale unavailable');
    expect(rendered).toContain('APERTURE MODEL ENFORCEMENT — off');
  });
});
