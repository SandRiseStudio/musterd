import { describe, expect, it } from 'vitest';
import {
  inspectApertureConfig,
  parseApertureResponse,
  safeConfigHash,
  type ApertureObservation,
} from './aperture.js';

const exactSource = ['tag:musterd-agent', 'tag:musterd-member-a7f3c2'];

function config(overrides: Record<string, unknown> = {}) {
  return {
    providers: {
      anthropic: {
        baseurl: 'https://api.anthropic.com',
        models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
      },
    },
    grants: [
      {
        src: exactSource,
        app: {
          'tailscale.com/cap/aperture': [
            {
              role: 'agent',
              models: ['claude-sonnet-4-6'],
              quotas: [{ bucket: 'daily:<user>' }],
            },
          ],
        },
      },
    ],
    quotas: {
      'daily:<user>': { capacity: '$10.00', rate: '$5.00/day', on_exceed: 'reject' },
    },
    database: {
      retention: { duration: '0', purge: ['captures', 'tools'], require_export: false },
    },
    ...overrides,
  };
}

function observation(value = config()): ApertureObservation {
  return { host: 'aperture.tailnet.ts.net', hash: '8D14C921AABBCCDD', config: value };
}

function states(value: ApertureObservation = observation()) {
  return Object.fromEntries(inspectApertureConfig(value).map((check) => [check.key, check.state]));
}

describe('Aperture response parsing (ADR 385)', () => {
  it('parses the API wrapper and HuJSON through the protocol schemas', () => {
    const parsed = parseApertureResponse('aperture.tailnet.ts.net', {
      hash: '8D14C921AABBCCDD',
      config: `{
        // Aperture emits HuJSON/JWCC rather than strict JSON.
        providers: { anthropic: { baseurl: 'https://api.anthropic.com', models: ['claude-sonnet-4-6'], }, },
        grants: [{ src: ['tag:musterd-agent', 'tag:musterd-member-a7f3c2'], app: {
          'tailscale.com/cap/aperture': [{ models: ['claude-sonnet-4-6'], quotas: [{ bucket: 'daily:<user>' }] }],
        }, }],
        quotas: { 'daily:<user>': { capacity: '$10', rate: '$5/day', on_exceed: 'reject' }, },
        database: { retention: { duration: '0', purge: ['captures', 'tools'], require_export: false } },
      }`,
    });

    expect(parsed.host).toBe('aperture.tailnet.ts.net');
    expect(parsed.config.providers?.anthropic?.models).toEqual(['claude-sonnet-4-6']);
  });

  it('rejects malformed wrappers, malformed HuJSON, and wrong vendor fields without echoing bodies', () => {
    const secret = 'api_key=do-not-echo';
    for (const body of [
      secret,
      { hash: 'abc', config: `{ broken: ${secret}` },
      {
        hash: 'abc',
        config: JSON.stringify({ providers: { anthropic: { baseurl: 7, models: [] } } }),
      },
    ]) {
      expect(() => parseApertureResponse('aperture.tailnet.ts.net', body)).toThrow(
        'Aperture configuration response is invalid',
      );
      try {
        parseApertureResponse('aperture.tailnet.ts.net', body);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  it('redacts configuration hashes to eight lowercase hexadecimal characters or present', () => {
    expect(safeConfigHash('8D14C921AABBCCDD')).toBe('8d14c921');
    expect(safeConfigHash('not-an-upstream-hash')).toBe('present');
    expect(safeConfigHash('')).toBe('present');
  });
});

describe('Aperture posture analysis (ADR 385)', () => {
  it('returns the six stable checks for the exact ready posture', () => {
    const checks = inspectApertureConfig(observation());
    expect(checks.map((check) => check.key)).toEqual([
      'aperture-config-api',
      'aperture-retention',
      'aperture-providers',
      'aperture-grants',
      'aperture-quotas',
      'aperture-identities',
    ]);
    expect(checks.every((check) => check.state === 'ok')).toBe(true);
    expect(checks.map((check) => check.detail)).toEqual([
      'aperture.tailnet.ts.net · hash 8d14c921',
      'zero; captures and tools purged',
      'anthropic (2 models)',
      'exact Member workload identities; no wildcard source',
      'every model grant has a rejecting, defined bucket',
      'persistent Member tags are exact and non-admin',
    ]);
    expect(JSON.stringify(checks)).not.toContain('AABBCCDD');
  });

  it.each([
    ['duration', { duration: '1h', purge: ['captures', 'tools'], require_export: false }],
    ['captures purge', { duration: '0', purge: ['tools'], require_export: false }],
    ['tools purge', { duration: '0', purge: ['captures'], require_export: false }],
    ['export requirement', { duration: '0', purge: ['captures', 'tools'], require_export: true }],
  ])('fails retention when %s drifts', (_name, retention) => {
    expect(states(observation(config({ database: { retention } })))['aperture-retention']).toBe(
      'fail',
    );
  });

  it.each([
    ['no providers', {}],
    [
      'plaintext provider',
      { anthropic: { baseurl: 'http://api.anthropic.com', models: ['claude'] } },
    ],
    ['empty base URL', { anthropic: { baseurl: '', models: ['claude'] } }],
    ['no models', { anthropic: { baseurl: 'https://api.anthropic.com', models: [] } }],
  ])('fails provider posture for %s', (_name, providers) => {
    expect(states(observation(config({ providers })))['aperture-providers']).toBe('fail');
  });

  it.each([
    ['wildcard', ['*']],
    ['wildcard Member tag', ['tag:musterd-agent', 'tag:musterd-member-*']],
    ['group source', ['group:engineering', ...exactSource]],
    ['user source', ['user:operator@example.test', ...exactSource]],
    ['shared tag only', ['tag:musterd-agent']],
    ['mixed broad and exact', ['*', ...exactSource]],
    ['unsorted exact tags', [...exactSource].reverse()],
    ['uppercase Member id', ['tag:musterd-agent', 'tag:musterd-member-A7F3C2']],
  ])('rejects %s identity sources', (_name, src) => {
    const grants = [{ ...config().grants[0], src }];
    expect(states(observation(config({ grants })))['aperture-identities']).toBe('fail');
  });

  it('rejects an admin agent identity', () => {
    const grants = [
      {
        src: exactSource,
        app: {
          'tailscale.com/cap/aperture': [
            { role: 'admin', models: ['claude'], quotas: [{ bucket: 'daily:<user>' }] },
          ],
        },
      },
    ];
    expect(states(observation(config({ grants })))['aperture-identities']).toBe('fail');
  });

  it('requires at least one model capability but ignores connector-only capabilities', () => {
    const grants = [
      {
        src: exactSource,
        app: {
          'tailscale.com/cap/aperture': [{ role: 'agent', quotas: [{ bucket: 'daily:<user>' }] }],
        },
      },
    ];
    expect(states(observation(config({ grants })))['aperture-grants']).toBe('fail');
  });

  it.each([
    ['no quota reference', { quotas: [] }, config().quotas],
    ['unknown bucket', { quotas: [{ bucket: 'missing' }] }, config().quotas],
    [
      'zero capacity',
      { quotas: [{ bucket: 'daily:<user>' }] },
      { 'daily:<user>': { capacity: '$0', rate: '$5/day', on_exceed: 'reject' } },
    ],
    [
      'non-dollar capacity',
      { quotas: [{ bucket: 'daily:<user>' }] },
      { 'daily:<user>': { capacity: '10', rate: '$5/day', on_exceed: 'reject' } },
    ],
    [
      'zero rate',
      { quotas: [{ bucket: 'daily:<user>' }] },
      { 'daily:<user>': { capacity: '$10', rate: '$0/day', on_exceed: 'reject' } },
    ],
    [
      'non-dollar rate',
      { quotas: [{ bucket: 'daily:<user>' }] },
      { 'daily:<user>': { capacity: '$10', rate: '5/day', on_exceed: 'reject' } },
    ],
    [
      'non-rejecting bucket',
      { quotas: [{ bucket: 'daily:<user>' }] },
      { 'daily:<user>': { capacity: '$10', rate: '$5/day', on_exceed: 'allow' } },
    ],
  ])('fails model quota posture for %s', (_name, capability, quotas) => {
    const grants = [
      {
        src: exactSource,
        app: {
          'tailscale.com/cap/aperture': [{ role: 'agent', models: ['claude'], ...capability }],
        },
      },
    ];
    expect(states(observation(config({ grants, quotas })))['aperture-quotas']).toBe('fail');
  });
});
