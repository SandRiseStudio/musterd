import { describe, expect, it } from 'vitest';
import {
  PACKAGE_DIRS,
  PUBLISH_ORDER,
  bumpPackageJson,
  nextStepsAfterPublish,
  parseReleaseArgs,
} from '../scripts/release/helpers.ts';

describe('release helpers (ADR 156)', () => {
  it('publishes in protocol → telemetry → server → mcp → cli order', () => {
    expect([...PUBLISH_ORDER]).toEqual([
      '@musterd/protocol',
      '@musterd/telemetry',
      '@musterd/server',
      '@musterd/mcp',
      '@musterd/cli',
    ]);
    for (const name of PUBLISH_ORDER) {
      expect(PACKAGE_DIRS[name]).toBeTruthy();
    }
  });

  it('parseReleaseArgs defaults and flags', () => {
    expect(parseReleaseArgs([])).toEqual({
      dryRun: false,
      allowDirty: false,
      version: '0.3.0',
    });
    expect(parseReleaseArgs(['--dry-run', '--allow-dirty', '--version', '0.3.1'])).toEqual({
      dryRun: true,
      allowDirty: true,
      version: '0.3.1',
    });
    expect(parseReleaseArgs(['--version=1.0.0']).version).toBe('1.0.0');
  });

  it('rejects bad version and unknown args', () => {
    expect(() => parseReleaseArgs(['--version', 'v0.3'])).toThrow(/invalid/);
    expect(() => parseReleaseArgs(['--nope'])).toThrow(/unknown/);
  });

  it('bumpPackageJson rewrites version only', () => {
    const next = bumpPackageJson(
      JSON.stringify({ name: '@musterd/cli', version: '0.2.0', private: false }, null, 2),
      '0.3.0',
    );
    expect(JSON.parse(next)).toMatchObject({ name: '@musterd/cli', version: '0.3.0' });
  });

  it('nextStepsAfterPublish mentions tag and brew', () => {
    const steps = nextStepsAfterPublish('0.3.0').join('\n');
    expect(steps).toContain('v0.3.0');
    expect(steps).toContain('bump-brew-formula');
    expect(steps).toContain('SandRiseStudio/musterd');
  });
});
