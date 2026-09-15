import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_TIMEOUT_MS } from '../vitest.shared.ts';

/**
 * The gate that makes this repo's test-runner settings mean the same thing everywhere.
 *
 * `pnpm -r test` runs each package's own `vitest run` against its own config, inheriting NOTHING
 * from the root. So the root's tuned `testTimeout` applied to `pnpm test` and to nothing else, and
 * five of five package configs sat at vitest's 5s default — the ceiling the root config's own
 * comment documents as miscalibrated for this suite. Measured 2026-08-19: a 6s test failed with
 * "Test timed out in 5000ms" under `packages/cli`'s config and passed under the root's.
 *
 * Discovering that by hand is the failure mode. This asserts it instead: every config that exists
 * must carry the shared value. Adding a new package with its own config and forgetting the import
 * fails here, at the moment it is added.
 */
describe('vitest config parity', () => {
  /** Discovered, never listed — a hand-maintained list is the same drift one level up. */
  const configs = (): string[] => {
    const found = ['vitest.config.ts'];
    const pkgs = join(process.cwd(), 'packages');
    for (const name of readdirSync(pkgs)) {
      const rel = join('packages', name, 'vitest.config.ts');
      if (existsSync(join(process.cwd(), rel))) found.push(rel);
    }
    return found;
  };

  it('finds every config, so this gate cannot pass by discovering none', () => {
    // The root plus one per package that ships tests. A drop here means discovery broke, and a
    // silently-empty sweep would make every assertion below vacuously true.
    expect(configs().length).toBeGreaterThanOrEqual(6);
  });

  it.each(configs())('%s uses the shared testTimeout', async (rel) => {
    const mod = (await import(join(process.cwd(), rel))) as {
      default: { test?: { testTimeout?: number } };
    };
    expect(mod.default.test?.testTimeout).toBe(TEST_TIMEOUT_MS);
  });
});
