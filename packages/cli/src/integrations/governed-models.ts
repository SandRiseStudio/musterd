import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  GovernedModelsManifestSchema,
  isMusterdCredential,
  parseRoleFile,
  parseSeatFile,
  parseTeamFile,
  seatNameFromPath,
  seatRoles,
  type GovernedModelsManifest,
  type SeatFile,
} from '@musterd/protocol';

const MANIFEST_PATH = '.musterd/governed-models.json';

export interface GovernedSeat {
  name: string;
  seat: SeatFile;
}

export interface GovernedRoster {
  seats: GovernedSeat[];
  roles: Set<string>;
}

export interface EffectiveMemberPolicy {
  member: string;
  workloadId: string;
  principal: string;
  roles: string[];
  models: string[];
  teamBucket: string;
  memberBucket: string;
  memberQuota: { capacity: string; rate: string };
}

export interface EffectivePolicy {
  teamQuota: { capacity: string; rate: string };
  members: EffectiveMemberPolicy[];
  outOfScope: Array<{ member: string; kind: string; reason: string }>;
}

function fail(message: string): never {
  throw new Error(`invalid governed-model policy: ${message}`);
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, child]) => [key, ...stringValues(child)]);
  return [];
}

function assertSecretFree(value: unknown, label: string): void {
  if (stringValues(value).some(isMusterdCredential)) fail(`${label} resembles a credential`);
}

/** Read only the committed roster inputs needed by generation; the CLI never imports the server. */
export function loadGovernedRoster(rootDir: string): GovernedRoster {
  const musterd = join(rootDir, '.musterd');
  const teamPath = join(musterd, 'team.toml');
  if (!existsSync(teamPath)) fail('missing .musterd/team.toml');
  parseTeamFile(readFileSync(teamPath, 'utf8'));

  const seatsDir = join(musterd, 'seats');
  const seats = existsSync(seatsDir)
    ? readdirSync(seatsDir)
        .filter((file: string) => file.endsWith('.toml'))
        .sort()
        .map((file: string) => ({
          name: seatNameFromPath(file),
          seat: parseSeatFile(readFileSync(join(seatsDir, file), 'utf8'), seatNameFromPath(file)),
        }))
    : [];
  const rolesDir = join(musterd, 'roles');
  const roles = new Set(
    existsSync(rolesDir)
      ? readdirSync(rolesDir)
          .filter((file: string) => file.endsWith('.toml'))
          .sort()
          .map((file: string) => {
            parseRoleFile(readFileSync(join(rolesDir, file), 'utf8'));
            return seatNameFromPath(file);
          })
      : [],
  );
  return { seats, roles };
}

export function loadGovernedModelsManifest(rootDir: string): GovernedModelsManifest | null {
  const path = join(rootDir, MANIFEST_PATH);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${MANIFEST_PATH} is not valid JSON`);
  }
  assertSecretFree(raw, MANIFEST_PATH);
  return GovernedModelsManifestSchema.parse(raw);
}

export function resolveGovernedPolicy(
  roster: GovernedRoster,
  manifest: GovernedModelsManifest,
): EffectivePolicy {
  assertSecretFree(manifest, MANIFEST_PATH);
  const tiers = new Map(manifest.quota_tiers.map((tier, index) => [tier.id, { ...tier, index }]));
  const defaultTier = tiers.get(manifest.team.default_tier);
  if (!defaultTier) fail('default quota tier is unknown');
  const teamModels = new Set(manifest.team.models);
  for (const role of Object.keys(manifest.roles)) {
    if (!roster.roles.has(role)) fail(`policy references unknown Role ${role}`);
  }
  const mapped = new Set(Object.keys(manifest.workloads));
  const members: EffectiveMemberPolicy[] = [];
  const outOfScope: EffectivePolicy['outOfScope'] = [];

  for (const { name, seat } of [...roster.seats].sort((a, b) => a.name.localeCompare(b.name))) {
    if (seat.kind !== 'agent') {
      if (mapped.has(name)) fail(`human or service Member ${name} cannot have a workload mapping`);
      outOfScope.push({ member: name, kind: seat.kind, reason: `${seat.kind}_member` });
      continue;
    }
    if (seat.account_status) {
      if (mapped.has(name)) fail(`inactive Member ${name} cannot have a workload mapping`);
      outOfScope.push({ member: name, kind: seat.kind, reason: seat.account_status });
      continue;
    }
    const mapping = manifest.workloads[name];
    if (!mapping) fail(`active agent Member ${name} needs one workload mapping`);
    mapped.delete(name);
    const heldRoles = seatRoles(seat).filter(Boolean).sort();
    let models = new Set(teamModels);
    let tier = defaultTier;
    for (const role of heldRoles) {
      if (!roster.roles.has(role)) fail(`Member ${name} references unknown Role ${role}`);
      const rule = manifest.roles[role];
      if (!rule) continue;
      if (rule.models) {
        if (rule.models.some((model) => !teamModels.has(model)))
          fail(`Role ${role} widens the Team model ceiling`);
        models = new Set([...models].filter((model) => rule.models?.includes(model)));
      }
      if (rule.quota_tier) {
        const selected = tiers.get(rule.quota_tier);
        if (!selected) fail(`Role ${role} references unknown quota tier ${rule.quota_tier}`);
        if (selected.index < defaultTier.index) fail(`Role ${role} widens the default quota tier`);
        if (selected.index > tier.index) tier = selected;
      }
    }
    if (models.size === 0) fail(`Member ${name} has no effective models after Role narrowing`);
    const workloadId = mapping.workload_id;
    members.push({
      member: name,
      workloadId,
      principal: `tag:musterd-member-${workloadId}`,
      roles: heldRoles,
      models: [...models].sort(),
      teamBucket: 'musterd-team',
      memberBucket: `musterd-member-${workloadId}`,
      memberQuota: tier.quota,
    });
  }
  if (mapped.size > 0) fail(`stale workload mapping(s): ${[...mapped].sort().join(', ')}`);
  return { teamQuota: manifest.team.quota, members, outOfScope };
}

/** Stable Aperture-only artifact renderer. Its returned strings contain no runtime data. */
export function renderAperturePolicy(policy: EffectivePolicy): { policy: string; members: string } {
  const grants = policy.members.map((member) => ({
    src: [member.principal],
    app: {
      'tailscale.com/cap/aperture': member.models.map((model) => ({
        role: 'user',
        models: [model],
        quotas: [{ bucket: member.teamBucket }, { bucket: member.memberBucket }],
      })),
    },
  }));
  const quotas: Record<string, { capacity: string; rate: string; on_exceed: 'reject' }> = {
    'musterd-team': { ...policy.teamQuota, on_exceed: 'reject' },
  };
  for (const member of policy.members) {
    quotas[member.memberBucket] = { ...member.memberQuota, on_exceed: 'reject' };
  }
  const rendered = {
    grants,
    quotas,
    database: { retention: { duration: '0', purge: ['captures', 'tools'], require_export: false } },
  };
  const members = [
    ...policy.members.map((member) => ({
      member: member.member,
      kind: 'agent',
      scope: 'in_scope',
      workload_id: member.workloadId,
      principal: member.principal,
      roles: member.roles,
      models: member.models,
      quota_buckets: [member.teamBucket, member.memberBucket],
    })),
    ...policy.outOfScope.map((member) => ({
      member: member.member,
      kind: member.kind,
      scope: 'out_of_scope',
      reason: member.reason,
    })),
  ].sort((a, b) => a.member.localeCompare(b.member));
  const policyText = `${JSON.stringify(rendered, null, 2)}\n`;
  const membersText = `${JSON.stringify({ version: 1, members }, null, 2)}\n`;
  assertSecretFree(
    { policy: JSON.parse(policyText), members: JSON.parse(membersText) },
    'generated output',
  );
  if (/[?*]|\badmin\b/.test(policyText)) fail('generated output is broad or administrative');
  return { policy: policyText, members: membersText };
}

export const APERTURE_GENERATED_DIR = '.musterd/generated/aperture';
