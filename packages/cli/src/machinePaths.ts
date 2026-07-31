import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve a machine-wide musterd path (`~/.musterd/<file>`), honouring an env
 * override. Under vitest the override is required (ADR 190): without it the
 * suite can silently write the operator's real config / host registry / shim
 * dir. The global setup in `tests/setup/isolate-machine-state.ts` pins the
 * overrides; clearing them without a replacement is the mistake this throws on.
 */
export function machineStatePath(envKey: string, file: string): string {
  const override = process.env[envKey];
  if (override) return override;
  if (process.env['VITEST']) {
    throw new Error(
      `${envKey} must be set when VITEST is set (ADR 190). ` +
        `Clearing the override without replacing it lets the suite write ~/.musterd/${file}.`,
    );
  }
  return join(homedir(), '.musterd', file);
}
