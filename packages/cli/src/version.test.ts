import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cliVersion } from './version.js';

describe('cliVersion (ADR 067)', () => {
  it('returns the @musterd/cli package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(cliVersion()).toBe(pkg.version);
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
