import { describe, expect, it } from 'vitest';
import type { GovernedModelsManifest } from '@musterd/protocol';
import { renderAperturePolicy, resolveGovernedPolicy } from './governed-models.js';

const manifest: GovernedModelsManifest = {
  version: 1,
  team: {
    models: ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-6'],
    quota: { capacity: '$20', rate: '$10/day' },
    default_tier: 'standard',
  },
  quota_tiers: [
    { id: 'standard', quota: { capacity: '$10', rate: '$5/day' } },
    { id: 'restricted', quota: { capacity: '$5', rate: '$2/day' } },
  ],
  roles: {
    security: {
      models: ['anthropic/claude-sonnet-4-6'],
      quota_tier: 'restricted',
    },
  },
  workloads: { agent: { workload_id: 'a7f3c2' } },
};

describe('Aperture governed-model resolver (ADR 400)', () => {
  it('intersects Role models, selects the stricter tier, and renders stable bytes', () => {
    const policy = resolveGovernedPolicy(
      {
        roles: new Set(['security']),
        seats: [{ name: 'agent', seat: { kind: 'agent', role: 'security' } }],
      },
      manifest,
    );
    expect(policy.members[0]).toMatchObject({
      principal: 'tag:musterd-member-a7f3c2',
      models: ['anthropic/claude-sonnet-4-6'],
      memberQuota: { capacity: '$5', rate: '$2/day' },
    });
    expect(renderAperturePolicy(policy)).toEqual(renderAperturePolicy(policy));
  });

  it.each([
    ['missing mapping', { ...manifest, workloads: {} }],
    ['stale mapping', { ...manifest, workloads: { old: { workload_id: 'a7f3c2' } } }],
    ['widening Role', { ...manifest, roles: { security: { models: ['openai/gpt-5'] } } }],
  ])('fails closed for %s', (_name, value) => {
    expect(() =>
      resolveGovernedPolicy(
        {
          roles: new Set(['security']),
          seats: [{ name: 'agent', seat: { kind: 'agent', role: 'security' } }],
        },
        value,
      ),
    ).toThrow('invalid governed-model policy');
  });
});
