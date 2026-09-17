import { describe, expect, it } from 'vitest';
import {
  ApertureConfigResponseSchema,
  ApertureConfigSchema,
  GovernedModelsManifestSchema,
  GovernedTransportManifestSchema,
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
      src: ['tag:musterd-member-a7f3c2'],
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
    expect(
      TailscaleStatusSchema.safeParse({ Self: { DNSName: 1, TailscaleIPs: [], Online: true } })
        .success,
    ).toBe(false);
    expect(
      TailscaleStatusSchema.safeParse({
        Self: { DNSName: 'x', TailscaleIPs: '100.64.0.1', Online: true },
      }).success,
    ).toBe(false);
    expect(
      TailscaleStatusSchema.safeParse({ Self: { DNSName: 'x', TailscaleIPs: [], Online: 'yes' } })
        .success,
    ).toBe(false);
    expect(
      TailscaleServeStatusSchema.safeParse({ TCP: { '4849': { TCPForward: 4849 } } }).success,
    ).toBe(false);
    expect(ApertureConfigResponseSchema.safeParse({ config: 1, hash: 'abc' }).success).toBe(false);
    expect(
      ApertureConfigSchema.safeParse({
        ...apertureConfig,
        providers: { anthropic: { baseurl: 1, models: [] } },
      }).success,
    ).toBe(false);
    expect(
      ApertureConfigSchema.safeParse({ ...apertureConfig, grants: [{ src: '*', app: {} }] })
        .success,
    ).toBe(false);
    expect(
      ApertureConfigSchema.safeParse({
        ...apertureConfig,
        quotas: { budget: { capacity: 1, rate: '$1/day', on_exceed: 'reject' } },
      }).success,
    ).toBe(false);
    expect(
      ApertureConfigSchema.safeParse({
        ...apertureConfig,
        database: { retention: { duration: 0, purge: [], require_export: false } },
      }).success,
    ).toBe(false);
  });

  it('accepts an Aperture API wrapper and its parsed HuJSON configuration without modeling secrets', () => {
    expect(
      ApertureConfigResponseSchema.parse({
        config: JSON.stringify(apertureConfig),
        hash: '8d14c921aabbccdd',
        ignored: true,
      }),
    ).toMatchObject({
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
    tailscale: {
      integration: 'tailscale',
      selected: true,
      posture: 'verified',
      checks: [
        { key: 'tailscale-installed', label: 'tailscale installed', state: 'ok', detail: '1.80.0' },
      ],
    },
    aperture: { integration: 'aperture', selected: false, posture: 'off', checks: [] },
    limits: [
      'configuration and reachability evidence only; Aperture enforcement remains off',
      'no device management, sandbox enforcement, or unrelated-harness coverage',
    ],
  };

  it('rejects extra report keys and a success claim that hides a selected failure', () => {
    expect(IntegrationDoctorReportSchema.safeParse({ ...report, secret: 'nope' }).success).toBe(
      false,
    );
    expect(
      IntegrationDoctorReportSchema.safeParse({
        ...report,
        tailscale: {
          ...report.tailscale,
          checks: [{ key: 'tailnet-up', label: 'tailnet up', state: 'fail' }],
        },
      }).success,
    ).toBe(false);
  });

  it('round-trips a report containing no credential-like or body fields', () => {
    const parsed = IntegrationDoctorReportSchema.parse(report);
    const json = JSON.stringify(parsed);
    for (const forbidden of [
      'api_key',
      'authorization',
      'prompt',
      'response',
      'mskey_',
      'msgr_',
      'msla_',
    ]) {
      expect(json).not.toContain(forbidden);
    }
    expect(parsed).toEqual(report);
  });
});

describe('GovernedModelsManifestSchema (ADR 400)', () => {
  const manifest = {
    version: 1,
    team: {
      models: ['anthropic/claude-sonnet-4-6'],
      quota: { capacity: '$20', rate: '$10/day' },
      default_tier: 'standard',
    },
    quota_tiers: [
      { id: 'standard', quota: { capacity: '$10', rate: '$5/day' } },
      { id: 'restricted', quota: { capacity: '$5', rate: '$2/day' } },
    ],
    roles: { security: { models: ['anthropic/claude-sonnet-4-6'], quota_tier: 'restricted' } },
    workloads: { bigbody: { workload_id: 'a7f3c2' } },
  };

  it('accepts exact provider/model intent and a strictly narrowing quota ladder', () => {
    expect(GovernedModelsManifestSchema.parse(manifest)).toMatchObject(manifest);
  });

  it('rejects launch credentials in model manifests', () => {
    expect(
      GovernedModelsManifestSchema.safeParse({
        ...manifest,
        roles: { msla_bad: {} },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['floating model', { ...manifest, team: { ...manifest.team, models: ['anthropic/latest'] } }],
    ['bare model', { ...manifest, team: { ...manifest.team, models: ['claude'] } }],
    ['broad model', { ...manifest, team: { ...manifest.team, models: ['anthropic/*'] } }],
    [
      'non-monotonic tier',
      {
        ...manifest,
        quota_tiers: [
          { id: 'standard', quota: { capacity: '$10', rate: '$5/day' } },
          { id: 'restricted', quota: { capacity: '$11', rate: '$2/day' } },
        ],
      },
    ],
    [
      'duplicate workload',
      {
        ...manifest,
        workloads: { one: { workload_id: 'a7f3c2' }, two: { workload_id: 'a7f3c2' } },
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(GovernedModelsManifestSchema.safeParse(value).success).toBe(false);
  });
});

describe('GovernedTransportManifestSchema (ADR 402)', () => {
  const manifest = {
    version: 1,
    aperture_tag: 'tag:aperture',
    tag_owners: ['group:musterd-operators'],
    nodes: [{ node_key: 'studio-a', members: ['ada'] }],
  };

  it('accepts exact tags, explicit owners, and opaque transport node keys', () => {
    expect(GovernedTransportManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('allows ordinary values that merely contain credential-related English words', () => {
    const ordinary = {
      ...manifest,
      nodes: [{ node_key: 'tokenizer-box-01', members: ['secretary'] }],
    };
    expect(GovernedTransportManifestSchema.parse(ordinary)).toEqual(ordinary);
  });

  it.each([
    ['a wildcard aperture tag', { ...manifest, aperture_tag: 'tag:*' }],
    ['a wildcard tag owner', { ...manifest, tag_owners: ['group:*'] }],
    ['an automatic broad tag owner', { ...manifest, tag_owners: ['autogroup:admin'] }],
    ['a duplicate node key', { ...manifest, nodes: [...manifest.nodes, ...manifest.nodes] }],
    [
      'a duplicated Member on one node',
      { ...manifest, nodes: [{ node_key: 'studio-a', members: ['ada', 'ada'] }] },
    ],
    ['a musterd credential', { ...manifest, nodes: [{ node_key: 'mskey_abc', members: ['ada'] }] }],
  ])('rejects %s', (_name, value) => {
    expect(GovernedTransportManifestSchema.safeParse(value).success).toBe(false);
  });
});
