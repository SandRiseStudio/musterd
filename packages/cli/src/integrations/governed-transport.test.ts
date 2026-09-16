import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GovernedTransportManifest } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { loadGovernedTransportManifest, renderTailscaleTransport } from './governed-transport.js';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'musterd-transport-'));
  mkdirSync(join(root, '.musterd', 'seats'), { recursive: true });
  mkdirSync(join(root, '.musterd', 'roles'));
  writeFileSync(join(root, '.musterd', 'team.toml'), 'slug = "test"\n');
  writeFileSync(join(root, '.musterd', 'seats', 'ada.toml'), 'kind = "agent"\n');
  writeFileSync(join(root, '.musterd', 'seats', 'nick.toml'), 'kind = "human"\n');
  writeFileSync(
    join(root, '.musterd', 'governed-models.json'),
    JSON.stringify({
      version: 1,
      team: {
        models: ['anthropic/claude-sonnet-4-6'],
        quota: { capacity: '$20', rate: '$10/day' },
        default_tier: 'standard',
      },
      quota_tiers: [{ id: 'standard', quota: { capacity: '$10', rate: '$5/day' } }],
      roles: {},
      workloads: { ada: { workload_id: 'a7f3c2' } },
    }),
  );
  return root;
}

describe('Tailscale governed-transport renderer (ADR 402)', () => {
  const manifest: GovernedTransportManifest = {
    version: 1,
    aperture_tag: 'tag:aperture',
    tag_owners: ['group:operators'],
    nodes: [{ node_key: 'studio-a', members: ['ada'] }],
  };

  it('renders exact ACLs and a complete lexical Member mapping', () => {
    const rendered = renderTailscaleTransport(workspace(), manifest);
    expect(JSON.parse(rendered.policy)).toEqual({
      tagOwners: {
        'tag:musterd-agent': ['group:operators'],
        'tag:musterd-member-a7f3c2': ['group:operators'],
      },
      acls: [
        {
          action: 'accept',
          src: ['tag:musterd-member-a7f3c2'],
          dst: ['tag:aperture:443'],
        },
      ],
    });
    expect(JSON.parse(rendered.workloads)).toEqual({
      version: 1,
      members: [
        {
          member: 'ada',
          kind: 'agent',
          scope: 'in_scope',
          workload_id: 'a7f3c2',
          tag: 'tag:musterd-member-a7f3c2',
          node_keys: ['studio-a'],
        },
        { member: 'nick', kind: 'human', scope: 'out_of_scope', reason: 'human_member' },
      ],
    });
  });

  it('is stable when manifest collections are reordered', () => {
    const root = workspace();
    const forward = renderTailscaleTransport(root, {
      ...manifest,
      tag_owners: ['group:z', 'group:a'],
      nodes: [
        { node_key: 'studio-b', members: ['ada'] },
        { node_key: 'studio-a', members: ['ada'] },
      ],
    });
    const reverse = renderTailscaleTransport(root, {
      ...manifest,
      tag_owners: ['group:a', 'group:z'],
      nodes: [
        { node_key: 'studio-a', members: ['ada'] },
        { node_key: 'studio-b', members: ['ada'] },
      ],
    });
    expect(forward).toEqual(reverse);
  });

  it('loads legitimate Member and node names containing credential-related English words', () => {
    const root = workspace();
    writeFileSync(
      join(root, '.musterd', 'governed-transport.json'),
      JSON.stringify({
        ...manifest,
        nodes: [{ node_key: 'tokenizer-box-01', members: ['secretary'] }],
      }),
    );
    expect(loadGovernedTransportManifest(root)).toMatchObject({
      nodes: [{ node_key: 'tokenizer-box-01', members: ['secretary'] }],
    });
  });

  it.each([
    [
      'a missing transport mapping',
      { ...manifest, nodes: [{ node_key: 'studio-a', members: ['other'] }] },
    ],
    [
      'a stale or non-agent mapping',
      { ...manifest, nodes: [{ node_key: 'studio-a', members: ['nick'] }] },
    ],
  ])('fails closed for %s', (_name, value) => {
    expect(() => renderTailscaleTransport(workspace(), value)).toThrow(
      'invalid governed-transport policy',
    );
  });
});
