import {
  ApertureConfigResponseSchema,
  ApertureConfigSchema,
  type ApertureConfig,
  type IntegrationCheck,
} from '@musterd/protocol';
import JSON5 from 'json5';
import type { EffectivePolicy } from './governed-models.js';

export interface ApertureObservation {
  host: string;
  hash: string;
  config: ApertureConfig;
}

const LABELS = {
  'aperture-config-api': 'Aperture config API',
  'aperture-retention': 'body retention',
  'aperture-providers': 'providers',
  'aperture-grants': 'default grants',
  'aperture-quotas': 'quotas',
  'aperture-identities': 'identity prerequisites',
  'aperture-managed-policy': 'managed policy',
} as const;

function ok(key: keyof typeof LABELS, detail: string): IntegrationCheck {
  return { key, label: LABELS[key], state: 'ok', detail };
}

function fail(key: keyof typeof LABELS, detail: string, fix: string): IntegrationCheck {
  return { key, label: LABELS[key], state: 'fail', detail, fix };
}

export function safeConfigHash(hash: string): string {
  return /^[0-9a-f]{8,}$/i.test(hash) ? hash.slice(0, 8).toLowerCase() : 'present';
}

export function parseApertureResponse(host: string, body: unknown): ApertureObservation {
  try {
    const response = ApertureConfigResponseSchema.parse(body);
    const config = ApertureConfigSchema.parse(JSON5.parse(response.config));
    return { host, hash: response.hash, config };
  } catch {
    throw new Error('Aperture configuration response is invalid');
  }
}

function modelCapabilities(config: ApertureConfig) {
  return (config.grants ?? []).flatMap((grant) =>
    (grant.app['tailscale.com/cap/aperture'] ?? []).filter((capability) =>
      typeof capability.models === 'string'
        ? capability.models.length > 0
        : (capability.models?.length ?? 0) > 0,
    ),
  );
}

function isPositiveDollars(value: string): boolean {
  const match = /^\$(\d+(?:\.\d+)?)(?:\/[^\s]+)?$/.exec(value);
  return match !== null && Number(match[1]) > 0;
}

function hasExactMemberIdentity(src: string[]): boolean {
  return src.length === 1 && /^tag:musterd-member-[a-z0-9]+$/.test(src[0] ?? '');
}

function hasStandardUserRole(capabilities: Array<{ role?: string | undefined }>): boolean {
  const roles = capabilities.flatMap((capability) =>
    capability.role === undefined ? [] : [capability.role],
  );
  return roles.length > 0 && roles.every((role) => role === 'user');
}

function managedPolicyCheck(config: ApertureConfig, policy: EffectivePolicy): IntegrationCheck {
  for (const member of policy.members) {
    for (const model of member.models) {
      const provider = model.slice(0, model.indexOf('/'));
      if (!config.providers?.[provider]?.models.includes(model)) {
        return fail(
          'aperture-managed-policy',
          `provider catalog lacks managed model for ${member.member}`,
          'Add every exact generated provider/model identifier to the operator-owned provider catalog.',
        );
      }
    }
  }
  const grants = config.grants ?? [];
  const expected = new Map(policy.members.map((member) => [member.principal, member]));
  for (const [principal, member] of expected) {
    const matches = grants.filter((grant) => grant.src.length === 1 && grant.src[0] === principal);
    if (matches.length !== 1) {
      return fail(
        'aperture-managed-policy',
        `managed grant drift for ${member.member}`,
        'Run musterd integration generate aperture --write, then merge the exact managed grant.',
      );
    }
    const capabilities = matches[0]?.app['tailscale.com/cap/aperture'] ?? [];
    const models = capabilities
      .flatMap((cap) => (Array.isArray(cap.models) ? cap.models : cap.models ? [cap.models] : []))
      .sort();
    const buckets = capabilities
      .flatMap((cap) => cap.quotas?.map((quota) => quota.bucket) ?? [])
      .sort();
    if (
      JSON.stringify(models) !== JSON.stringify(member.models) ||
      JSON.stringify(buckets) !== JSON.stringify([member.memberBucket, member.teamBucket].sort()) ||
      capabilities.some((cap) => cap.role !== 'user')
    ) {
      return fail(
        'aperture-managed-policy',
        `managed grant drift for ${member.member}`,
        'Merge the generated exact models, user role, and both quota buckets.',
      );
    }
  }
  const quotas = config.quotas ?? {};
  for (const member of policy.members) {
    const quota = quotas[member.memberBucket];
    if (
      quota?.capacity !== member.memberQuota.capacity ||
      quota.rate !== member.memberQuota.rate ||
      quota.on_exceed !== 'reject'
    ) {
      return fail(
        'aperture-managed-policy',
        `managed quota drift for ${member.member}`,
        'Merge the generated rejecting per-Member quota bucket.',
      );
    }
  }
  const team = quotas['musterd-team'];
  if (
    team?.capacity !== policy.teamQuota.capacity ||
    team.rate !== policy.teamQuota.rate ||
    team.on_exceed !== 'reject'
  ) {
    return fail(
      'aperture-managed-policy',
      'managed Team quota drift',
      'Merge the generated rejecting Team quota bucket.',
    );
  }
  return ok('aperture-managed-policy', `${policy.members.length} exact Member grants match`);
}

export function inspectApertureConfig(
  observation: ApertureObservation,
  policy?: EffectivePolicy,
): IntegrationCheck[] {
  const config =
    policy === undefined
      ? observation.config
      : {
          ...observation.config,
          // In managed mode, unrelated operator grants are intentionally not musterd evidence.
          grants: (observation.config.grants ?? []).filter(
            (grant) =>
              grant.src.length === 1 &&
              policy.members.some((member) => member.principal === grant.src[0]),
          ),
        };
  const checks: IntegrationCheck[] = [
    ok('aperture-config-api', `${observation.host} · hash ${safeConfigHash(observation.hash)}`),
  ];

  const retention = config.database?.retention;
  checks.push(
    retention?.duration === '0' &&
      retention.require_export === false &&
      retention.purge?.includes('captures') === true &&
      retention.purge.includes('tools')
      ? ok('aperture-retention', 'zero; captures and tools purged')
      : fail(
          'aperture-retention',
          'prompt or tool retention is not proven zero',
          'Set duration to 0, purge captures and tools, and disable require_export.',
        ),
  );

  const providers = Object.entries(config.providers ?? {});
  const providersReady =
    providers.length > 0 &&
    providers.every(([name, provider]) => {
      if (name.length === 0 || provider.models.length === 0) return false;
      try {
        return new URL(provider.baseurl).protocol === 'https:';
      } catch {
        return false;
      }
    });
  checks.push(
    providersReady
      ? ok(
          'aperture-providers',
          providers
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, provider]) => `${name} (${provider.models.length} models)`)
            .join(', '),
        )
      : fail(
          'aperture-providers',
          'a non-empty HTTPS provider and model list are required',
          'Configure at least one HTTPS provider with one or more models.',
        ),
  );

  const capabilities = modelCapabilities(config);
  checks.push(
    capabilities.length > 0
      ? ok('aperture-grants', 'exact Member workload identities; no wildcard source')
      : fail(
          'aperture-grants',
          'no model capability is granted',
          'Add an exact Member workload grant with at least one model capability.',
        ),
  );

  const quotas = config.quotas ?? {};
  const quotasReady =
    capabilities.length > 0 &&
    capabilities.every(
      (capability) =>
        (capability.quotas?.length ?? 0) > 0 &&
        capability.quotas?.every(({ bucket }) => {
          const quota = quotas[bucket];
          return (
            quota !== undefined &&
            isPositiveDollars(quota.capacity) &&
            isPositiveDollars(quota.rate) &&
            quota.rate.includes('/') &&
            quota.on_exceed === 'reject'
          );
        }),
    );
  checks.push(
    quotasReady
      ? ok('aperture-quotas', 'every model grant has a rejecting, defined bucket')
      : fail(
          'aperture-quotas',
          'a model grant lacks a positive rejecting dollar quota',
          'Reference a defined bucket with positive dollar capacity/rate and on_exceed set to reject.',
        ),
  );

  const identitiesReady =
    (config.grants?.length ?? 0) > 0 &&
    config.grants?.every((grant) => {
      const capabilities = grant.app['tailscale.com/cap/aperture'] ?? [];
      return hasExactMemberIdentity(grant.src) && hasStandardUserRole(capabilities);
    });
  checks.push(
    identitiesReady
      ? ok('aperture-identities', 'one exact Member tag; standard user role')
      : fail(
          'aperture-identities',
          'grant source is broad or its role is not standard user',
          'Use one lowercase opaque tag:musterd-member-<id> source and role user.',
        ),
  );

  if (policy) checks.push(managedPolicyCheck(config, policy));
  return checks;
}
