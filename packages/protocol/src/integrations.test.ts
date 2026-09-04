import { describe, expect, it } from 'vitest';
import {
  ApertureConfigResponseSchema,
  ApertureConfigSchema,
  IntegrationDoctorReportSchema,
  TailscaleServeStatusSchema,
  TailscaleStatusSchema,
} from './integrations.js';

const apertureConfig = {
  providers: {
    anthropic: { baseurl: 'https://api.anthropic.com', models: ['claude-sonnet-4-6'] },
  },
  grants: [
    {
      src: ['tag:musterd-agent', 'tag:musterd-member-a7f3c2'],
      app: {
        'tailscale.com/cap/aperture': [
          { models: ['claude-sonnet-4-6'], quotas: [{ bucket: 'daily:<user>' }] },
        ],
      },
    },
  ],
  quotas: { 'daily:<user>': { capacity: '$10.00', rate: '$5.00/day', on_exceed: 'reject' } },
  database: { retention: { duration: '0', purge: ['captures', 'tools'], require_export: false } },
};

describe('integration vendor schemas (ADR 385)', () => {
  it('accepts the Tailscale status and Serve fields the transport inspector reads', () => {
    expect(
      TailscaleStatusSchema.parse({
        Self: {
          DNSName: 'daemon.tailnet.ts.net.',
          TailscaleIPs: ['100.64.0.10'],
          Online: true,
        },
      }),
    ).toEqual({
      Self: { DNSName: 'daemon.tailnet.ts.net.', TailscaleIPs: ['100.64.0.10'], Online: true },
    });
    expect(
      TailscaleServeStatusSchema.parse({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }),
    ).toEqual({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } });
  });

  it('rejects wrong types at every vendor field the inspectors read', () => {
    expect(TailscaleStatusSchema.safeParse({ Self: { DNSName: 1, TailscaleIPs: [], Online: true } }).success).toBe(false);
    expect(TailscaleStatusSchema.safeParse({ Self: { DNSName: 'x', TailscaleIPs: '100.64.0.1', Online: true } }).success).toBe(false);
    expect(TailscaleStatusSchema.safeParse({ Self: { DNSName: 'x', TailscaleIPs: [], Online: 'yes' } }).success).toBe(false);
    expect(TailscaleServeStatusSchema.safeParse({ TCP: { '4849': { TCPForward: 4849 } } }).success).toBe(false);
    expect(ApertureConfigResponseSchema.safeParse({ config: 1, hash: 'abc' }).success).toBe(false);
    expect(ApertureConfigSchema.safeParse({ ...apertureConfig, providers: { anthropic: { baseurl: 1, models: [] } } }).success).toBe(false);
    expect(ApertureConfigSchema.safeParse({ ...apertureConfig, grants: [{ src: '*', app: {} }] }).success).toBe(false);
    expect(ApertureConfigSchema.safeParse({ ...apertureConfig, quotas: { budget: { capacity: 1, rate: '$1/day', on_exceed: 'reject' } } }).success).toBe(false);
    expect(ApertureConfigSchema.safeParse({ ...apertureConfig, database: { retention: { duration: 0, purge: [], require_export: false } } }).success).toBe(false);
  });

  it('accepts an Aperture API wrapper and its parsed HuJSON configuration without modeling secrets', () => {
    expect(ApertureConfigResponseSchema.parse({ config: JSON.stringify(apertureConfig), hash: '8d14c921aabbccdd', ignored: true })).toMatchObject({
      config: JSON.stringify(apertureConfig),
      hash: '8d14c921aabbccdd',
    });
    expect(ApertureConfigSchema.parse(apertureConfig)).toMatchObject({
      providers: { anthropic: { models: ['claude-sonnet-4-6'] } },
      database: { retention: { duration: '0' } },
    });
  });
});

describe('IntegrationDoctorReportSchema', () => {
  const report = {
    version: 1,
    ok: true,
    observed_at: 1,
    tailscale: { integration: 'tailscale', selected: true, posture: 'verified', checks: [{ key: 'tailscale-installed', label: 'tailscale installed', state: 'ok', detail: '1.80.0' }] },
    aperture: { integration: 'aperture', selected: false, posture: 'off', checks: [] },
    limits: [
      'configuration and reachability evidence only; Aperture enforcement remains off',
      'no device management, sandbox enforcement, or unrelated-harness coverage',
    ],
  };

  it('rejects extra report keys and a success claim that hides a selected failure', () => {
    expect(IntegrationDoctorReportSchema.safeParse({ ...report, secret: 'nope' }).success).toBe(false);
    expect(IntegrationDoctorReportSchema.safeParse({ ...report, tailscale: { ...report.tailscale, checks: [{ key: 'tailnet-up', label: 'tailnet up', state: 'fail' }] } }).success).toBe(false);
  });

  it('round-trips a report containing no credential-like or body fields', () => {
    const parsed = IntegrationDoctorReportSchema.parse(report);
    const json = JSON.stringify(parsed);
    for (const forbidden of ['api_key', 'authorization', 'prompt', 'response', 'mskey_', 'msgr_']) {
      expect(json).not.toContain(forbidden);
    }
    expect(parsed).toEqual(report);
  });
});
