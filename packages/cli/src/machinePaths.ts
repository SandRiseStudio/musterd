import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Resolve a machine-wide musterd path (`~/.musterd/<file>`), honouring an env
 * override. Under vitest the override is required (ADR 190): without it the
 * suite can silently write the operator's real config / host registry / shim
 * dir. The global setup in `tests/setup/isolate-machine-state.ts` pins the
 * overrides; clearing them without a replacement is the mistake this throws on.
 */
export function machineStatePath(
  envKey: string,
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[envKey];
  if (override) return override;
  if (env['VITEST']) {
    throw new Error(
      `${envKey} must be set when VITEST is set (ADR 190). ` +
        `Clearing the override without replacing it lets the suite write ~/.musterd/${file}.`,
    );
  }
  return join(homedir(), '.musterd', file);
}

/** The machine config file path with the env injected — the seam-friendly form of `configPath()`. */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return machineStatePath('MUSTERD_CONFIG', 'config.json', env);
}

/**
 * The machine-local root for multi-harness reconciliation state (ADR 282): the directory holding
 * the config file, so `MUSTERD_CONFIG` isolates tests and two users on different machines (or one
 * machine, different homes) naturally receive independent ledgers, journals, and locks.
 */
export function machineConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(resolveConfigPath(env));
}
