import { describe, expect, it } from 'vitest';
import { buildPlist, parsePlistEnvironment, SERVICE_LABEL } from './launchd.js';

/**
 * Daemon env in the plist (`service install --allowed-hosts`). The ADR 040 upgrade gate 403s a
 * WebSocket whose Host is neither loopback, boundHost, nor allow-listed, and the only way to set
 * `MUSTERD_ALLOWED_HOSTS` used to be hand-editing the plist. Two invariants carry the whole feature:
 * the existing PATH must survive (the daemon's shellouts need it), and the value must round-trip —
 * `install` reads the installed plist back to preserve an allow-list nobody re-passed.
 */

const base = {
  label: SERVICE_LABEL,
  node: '/opt/homebrew/opt/node@22/bin/node',
  binJs: '/Users/nick/agents/packages/cli/dist/bin.js',
  serveArgs: ['serve', '--web-root', '/Users/nick/.musterd/live/web'],
  workingDir: '/Users/nick/agents',
  stdoutPath: '/Users/nick/.musterd/daemon.log',
  stderrPath: '/Users/nick/.musterd/daemon.err.log',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
};

describe('buildPlist env', () => {
  it('merges env alongside PATH instead of clobbering it', () => {
    const xml = buildPlist({ ...base, env: { MUSTERD_ALLOWED_HOSTS: 'host.ts.net,100.64.0.1' } });
    expect(xml).toContain('<key>PATH</key>');
    expect(xml).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>');
    expect(xml).toContain('<key>MUSTERD_ALLOWED_HOSTS</key>');
    expect(xml).toContain('<string>host.ts.net,100.64.0.1</string>');
    // One dict, not two — launchd takes the last key and would silently drop the first.
    expect(xml.match(/<key>EnvironmentVariables<\/key>/g)).toHaveLength(1);
  });

  it('emits no env keys beyond PATH when none are given (unchanged plist shape)', () => {
    expect(buildPlist(base)).toBe(buildPlist({ ...base, env: {} }));
  });

  it('escapes a value that would otherwise break the XML', () => {
    const xml = buildPlist({ ...base, env: { MUSTERD_ALLOWED_HOSTS: 'a&b<c>"d"' } });
    expect(xml).toContain('<string>a&amp;b&lt;c&gt;&quot;d&quot;</string>');
  });
});

describe('parsePlistEnvironment', () => {
  it('round-trips what buildPlist wrote', () => {
    const xml = buildPlist({ ...base, env: { MUSTERD_ALLOWED_HOSTS: 'a.ts.net,10.0.0.2' } });
    const env = parsePlistEnvironment(xml);
    expect(env?.['MUSTERD_ALLOWED_HOSTS']).toBe('a.ts.net,10.0.0.2');
    expect(env?.['PATH']).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('reads a hand-edited plist (PlistBuddy shape) — that is the state on the real machine', () => {
    // nick's daemon carries a hand-set allow-list today; a re-install must be able to see it.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin</string>
    <key>MUSTERD_ALLOWED_HOSTS</key>
    <string>100.100.246.14,nicks-laptop.tail400343.ts.net</string>
  </dict>
</dict>
</plist>`;
    expect(parsePlistEnvironment(xml)?.['MUSTERD_ALLOWED_HOSTS']).toBe(
      '100.100.246.14,nicks-laptop.tail400343.ts.net',
    );
  });

  it('returns null when there is no env dict, and never confuses another dict for it', () => {
    expect(parsePlistEnvironment('<plist><dict></dict></plist>')).toBeNull();
    // A plist with no EnvironmentVariables but other dict-ish content must not yield a false read.
    expect(parsePlistEnvironment(buildPlist({ ...base, path: '' }))).toBeNull();
  });
});
