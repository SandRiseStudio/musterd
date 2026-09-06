import type { IntegrationCheck } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { inspectApertureConfig, parseApertureResponse } from '../integrations/aperture.js';
import { composeIntegrationReport, renderIntegrationReport } from '../integrations/report.js';
import {
  inspectTailscaleTransport,
  probeUpgradeHost,
  type UpgradeVerdict,
} from '../integrations/tailscale.js';
import { realExec, type Exec } from '../process.js';

export interface IntegrationCommandDeps {
  exec?: Exec;
  fetch?: typeof globalThis.fetch;
  probeUpgrade?: (
    origin: { hostname: string; port: number },
    host: string,
    timeoutMs?: number,
  ) => Promise<UpgradeVerdict>;
  server?: string;
  now?: () => number;
  out?: (text: string) => void;
}

const APERTURE_KEYS = [
  ['aperture-config-api', 'Aperture config API'],
  ['aperture-retention', 'body retention'],
  ['aperture-providers', 'providers'],
  ['aperture-grants', 'default grants'],
  ['aperture-quotas', 'quotas'],
  ['aperture-identities', 'identity prerequisites'],
] as const;

function apertureFailure(): IntegrationCheck[] {
  return APERTURE_KEYS.map(([key, label], index) =>
    index === 0
      ? {
          key,
          label,
          state: 'fail',
          detail: 'configuration could not be read or parsed',
          fix: 'Verify the Aperture URL, reachability, and GET /api/config response shape.',
        }
      : { key, label, state: 'skip', detail: 'Aperture configuration is unavailable' },
  );
}

function apertureUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError('--aperture wants an HTTPS URL (HTTP is allowed only for loopback)', 2);
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CliError('--aperture wants an HTTPS URL (HTTP is allowed only for loopback)', 2);
  }
  return url;
}

async function inspectAperture(
  base: URL,
  fetchImpl: typeof globalThis.fetch,
): Promise<IntegrationCheck[]> {
  try {
    const endpoint = new URL('/api/config', base);
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return apertureFailure();
    const body: unknown = await response.json();
    return inspectApertureConfig(parseApertureResponse(base.hostname, body));
  } catch {
    return apertureFailure();
  }
}

export async function integrationCommand(
  parsed: Parsed,
  deps: IntegrationCommandDeps = {},
): Promise<number> {
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'doctor') {
    throw new CliError(
      'musterd integration doctor [--tailscale] [--aperture <https-url>] [--json]',
      2,
    );
  }

  const tailscaleSelected = parsed.flags['tailscale'] === true;
  const apertureFlag = parsed.flags['aperture'];
  if (apertureFlag === true) {
    throw new CliError('--aperture requires an HTTPS URL', 2);
  }
  const apertureSelected = typeof apertureFlag === 'string';
  const selectedApertureUrl = apertureSelected ? apertureUrl(apertureFlag) : null;
  const server = deps.server ?? flagStr(parsed.flags, 'server') ?? loadConfig().server;
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  const [tailscaleChecks, apertureChecks] = await Promise.all([
    tailscaleSelected
      ? inspectTailscaleTransport({
          exec: deps.exec ?? realExec,
          server,
          fetch: fetchImpl,
          probeUpgrade: deps.probeUpgrade ?? probeUpgradeHost,
        })
      : Promise.resolve([]),
    selectedApertureUrl ? inspectAperture(selectedApertureUrl, fetchImpl) : Promise.resolve([]),
  ]);

  const report = composeIntegrationReport({
    observedAt: (deps.now ?? Date.now)(),
    tailscaleSelected,
    tailscaleChecks,
    apertureSelected,
    apertureChecks,
  });
  const rendered =
    parsed.flags['json'] === true ? JSON.stringify(report) : renderIntegrationReport(report);
  (deps.out ?? ((text) => process.stdout.write(text)))(`${rendered}\n`);
  return report.ok ? 0 : 1;
}
