import { describe, expect, it } from 'vitest';
import {
  PACKAGE_DIRS,
  assertPublishable,
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

  it('parseReleaseArgs has NO default version — a published number is never a default', () => {
    // It used to default to '0.3.0', frozen in source. That number went stale the moment 0.3.0
    // shipped, and a default here is wrong in principle regardless: the version is the one
    // irreversible decision in a release, so it has to be typed by whoever is making it.
    expect(parseReleaseArgs([]).version).toBeUndefined();
    expect(parseReleaseArgs(['--dry-run']).version).toBeUndefined();
  });

  it('parseReleaseArgs flags', () => {
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

  describe('assertPublishable — the offline guard on which number gets burned', () => {
    it('accepts a genuine bump', () => {
      expect(() => assertPublishable('0.4.2', '0.4.1')).not.toThrow();
      expect(() => assertPublishable('0.5.0', '0.4.1')).not.toThrow();
      expect(() => assertPublishable('1.0.0', '0.9.9')).not.toThrow();
    });

    it('refuses re-publishing the version already in package.json', () => {
      // The "forgot to bump" mistake. npm would reject it too, but only AFTER the earlier packages
      // in the lockstep order have already published — leaving a half-released version.
      expect(() => assertPublishable('0.4.1', '0.4.1')).toThrow(/already/i);
    });

    it('refuses going backwards, which npm would happily accept', () => {
      // This one the registry does NOT protect against: 0.3.2 is unpublished, so npm takes it and
      // `latest` moves BACKWARDS onto older code. Offline check or nothing.
      expect(() => assertPublishable('0.3.2', '0.4.1')).toThrow(/lower/i);
    });

    it('compares numerically, not as strings', () => {
      // '0.10.0' < '0.9.0' lexically. A string compare here would block a legitimate release.
      expect(() => assertPublishable('0.10.0', '0.9.0')).not.toThrow();
      expect(() => assertPublishable('0.9.0', '0.10.0')).toThrow(/lower/i);
    });

    it('lets a prerelease through rather than guessing at its ordering', () => {
      // Full semver precedence is a rabbit hole this guard does not need to enter; the core-number
      // comparison is what catches the mistakes we actually make.
      expect(() => assertPublishable('0.5.0-rc.1', '0.4.1')).not.toThrow();
    });
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
