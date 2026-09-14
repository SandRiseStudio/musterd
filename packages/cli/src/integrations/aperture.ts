import {
  ApertureConfigResponseSchema,
  ApertureConfigSchema,
  type ApertureConfig,
  type IntegrationCheck,
} from '@musterd/protocol';
import JSON5 from 'json5';

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

export function inspectApertureConfig(observation: ApertureObservation): IntegrationCheck[] {
  const { config } = observation;
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

  return checks;
}
