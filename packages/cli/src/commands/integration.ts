import type { IntegrationCheck } from '@musterd/protocol';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { flagStr, type Parsed } from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { inspectApertureConfig, parseApertureResponse } from '../integrations/aperture.js';
import {
  APERTURE_GENERATED_DIR,
  loadGovernedModelsManifest,
  loadGovernedRoster,
  renderAperturePolicy,
  resolveGovernedPolicy,
} from '../integrations/governed-models.js';
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
  cwd?: () => string;
  out?: (text: string) => void;
}

function generatedPaths(rootDir: string) {
  const dir = join(rootDir, APERTURE_GENERATED_DIR);
  return { dir, policy: join(dir, 'policy.hujson'), members: join(dir, 'members.json') };
}

function current(path: string, expected: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8') === expected;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
}

function generateAperture(parsed: Parsed, deps: IntegrationCommandDeps): number {
  if (parsed.positionals.length !== 2 || parsed.positionals[1] !== 'aperture') {
    throw new CliError('musterd integration generate aperture [--write | --check]', 2);
  }
  const write = parsed.flags['write'] === true;
  const check = parsed.flags['check'] === true;
  if (write && check) throw new CliError('--write and --check are mutually exclusive', 2);
  const rootDir = (deps.cwd ?? process.cwd)();
  const manifest = loadGovernedModelsManifest(rootDir);
  if (!manifest) throw new CliError('missing .musterd/governed-models.json', 2);
  const rendered = renderAperturePolicy(
    resolveGovernedPolicy(loadGovernedRoster(rootDir), manifest),
  );
  const paths = generatedPaths(rootDir);
  const isCurrent =
    current(paths.policy, rendered.policy) && current(paths.members, rendered.members);
  if (check) {
    (deps.out ?? ((text) => process.stdout.write(text)))(
      isCurrent
        ? 'Aperture policy is current\n'
        : 'Aperture policy is stale; run musterd integration generate aperture --write\n',
    );
    return isCurrent ? 0 : 1;
  }
  if (write) {
    if (!isCurrent) {
      atomicWrite(paths.policy, rendered.policy);
      atomicWrite(paths.members, rendered.members);
    }
    (deps.out ?? ((text) => process.stdout.write(text)))('Aperture policy is current\n');
    return 0;
  }
  (deps.out ?? ((text) => process.stdout.write(text)))(
    isCurrent
      ? 'Aperture policy is current\n'
      : `--- ${APERTURE_GENERATED_DIR}/policy.hujson\n+++ generated policy.hujson\n${rendered.policy}` +
          `--- ${APERTURE_GENERATED_DIR}/members.json\n+++ generated members.json\n${rendered.members}`,
  );
  return 0;
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
  rootDir: string,
): Promise<IntegrationCheck[]> {
  try {
    const manifest = loadGovernedModelsManifest(rootDir);
    const policy = manifest
      ? resolveGovernedPolicy(loadGovernedRoster(rootDir), manifest)
      : undefined;
    if (policy) {
      const rendered = renderAperturePolicy(policy);
      const paths = generatedPaths(rootDir);
      if (!current(paths.policy, rendered.policy) || !current(paths.members, rendered.members)) {
        return [
          {
            key: 'aperture-managed-policy',
            label: 'managed policy',
            state: 'fail',
            detail: 'generated Aperture policy is missing or stale',
            fix: 'Run musterd integration generate aperture --write before checking Aperture.',
          },
        ];
      }
    }
    const endpoint = new URL('/api/config', base);
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return apertureFailure();
    const body: unknown = await response.json();
    return inspectApertureConfig(parseApertureResponse(base.hostname, body), policy);
  } catch {
    return apertureFailure();
  }
}

export async function integrationCommand(
  parsed: Parsed,
  deps: IntegrationCommandDeps = {},
): Promise<number> {
  if (parsed.positionals[0] === 'generate') return generateAperture(parsed, deps);
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
  const rootDir = (deps.cwd ?? process.cwd)();
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
    selectedApertureUrl
      ? inspectAperture(selectedApertureUrl, fetchImpl, rootDir)
      : Promise.resolve([]),
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
