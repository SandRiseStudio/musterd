import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GovernedTransportManifestSchema, type GovernedTransportManifest } from '@musterd/protocol';
import {
  loadGovernedModelsManifest,
  loadGovernedRoster,
  resolveGovernedPolicy,
} from './governed-models.js';

const PATH = '.musterd/governed-transport.json';
export const TAILSCALE_GENERATED_DIR = '.musterd/generated/tailscale';

export function loadGovernedTransportManifest(root: string): GovernedTransportManifest | null {
  const path = join(root, PATH);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return GovernedTransportManifestSchema.parse(JSON.parse(text));
}

export function renderTailscaleTransport(
  root: string,
  manifest: GovernedTransportManifest,
): { policy: string; workloads: string } {
  const models = loadGovernedModelsManifest(root);
  if (!models)
    throw new Error('invalid governed-transport policy: missing .musterd/governed-models.json');
  const policy = resolveGovernedPolicy(loadGovernedRoster(root), models);
  const memberNodes = new Map<string, string[]>();
  for (const node of manifest.nodes) {
    for (const member of node.members)
      memberNodes.set(member, [...(memberNodes.get(member) ?? []), node.node_key]);
  }
  for (const member of policy.members)
    if (!memberNodes.get(member.member)?.length)
      throw new Error(
        `invalid governed-transport policy: Member ${member.member} needs a transport node`,
      );
  for (const member of memberNodes.keys())
    if (!policy.members.some((entry) => entry.member === member))
      throw new Error(`invalid governed-transport policy: stale or non-agent Member ${member}`);
  const tags = policy.members.map((member) => member.principal).sort();
  const result = {
    tagOwners: Object.fromEntries(
      ['tag:musterd-agent', ...tags].map((tag) => [tag, [...manifest.tag_owners].sort()]),
    ),
    acls: tags.map((src) => ({
      action: 'accept',
      src: [src],
      dst: [`${manifest.aperture_tag}:443`],
    })),
  };
  const workloads = {
    version: 1,
    members: [
      ...policy.members.map((member) => ({
        member: member.member,
        kind: 'agent',
        scope: 'in_scope',
        workload_id: member.workloadId,
        tag: member.principal,
        node_keys: [...(memberNodes.get(member.member) ?? [])].sort(),
      })),
      ...policy.outOfScope.map((member) => ({
        member: member.member,
        kind: member.kind,
        scope: 'out_of_scope',
        reason: member.reason,
      })),
    ].sort((a, b) => a.member.localeCompare(b.member)),
  };
  const output = {
    policy: `${JSON.stringify(result, null, 2)}\n`,
    workloads: `${JSON.stringify(workloads, null, 2)}\n`,
  };
  return output;
}
