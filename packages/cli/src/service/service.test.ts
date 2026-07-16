import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootoutArgs,
  bootstrapArgs,
  buildPlist,
  kickstartArgs,
  parseLaunchctlPrint,
  parsePlistProgramArguments,
  printArgs,
  SERVICE_LABEL,
  serviceSupported,
} from './launchd.js';
import {
  install,
  restart,
  start,
  status,
  stop,
  tailFile,
  uninstall,
  type RunResult,
  type Runner,
  type ServiceCtx,
} from './manage.js';

// ---- pure: platform guard ----

describe('serviceSupported', () => {
  it('is implemented on macOS, the named seam elsewhere', () => {
    expect(serviceSupported('darwin')).toBe(true);
    expect(serviceSupported('linux')).toBe(false);
    expect(serviceSupported('win32')).toBe(false);
  });
});

// ---- pure: plist generation ----

describe('buildPlist', () => {
  const plist = buildPlist({
    label: SERVICE_LABEL,
    node: '/opt/homebrew/bin/node',
    binJs: '/Users/nick/agents/packages/cli/dist/bin.js',
    serveArgs: ['serve', '--port', '4849'],
    workingDir: '/Users/nick/agents',
    stdoutPath: '/Users/nick/.musterd/daemon.log',
    stderrPath: '/Users/nick/.musterd/daemon.err.log',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
  });

  it('embeds node + bin + serve args as ProgramArguments in order', () => {
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>');
    expect(plist).toContain('<string>/Users/nick/agents/packages/cli/dist/bin.js</string>');
    expect(plist).toContain('<string>serve</string>');
    expect(plist).toContain('<string>--port</string>');
    const order =
      plist.indexOf('dist/bin.js') < plist.indexOf('<string>serve</string>') &&
      plist.indexOf('/node<') < plist.indexOf('dist/bin.js');
    expect(order).toBe(true);
  });

  it('sets RunAtLoad + KeepAlive (survive session, restart on crash) + a throttle', () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toContain('<key>ThrottleInterval</key>');
  });

  it('carries the label, log paths, and PATH', () => {
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<string>/Users/nick/.musterd/daemon.log</string>');
    expect(plist).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>');
  });

  it('XML-escapes dynamic values so a path with & cannot break the doc', () => {
    const p = buildPlist({
      label: 'x',
      node: '/n',
      binJs: '/a & b/bin.js',
      serveArgs: ['serve'],
      workingDir: '/w',
      stdoutPath: '/o',
      stderrPath: '/e',
      path: '/p',
    });
    expect(p).toContain('/a &amp; b/bin.js');
    expect(p).not.toContain('/a & b/bin.js');
  });
});

describe('parsePlistProgramArguments (read the daemon checkout back from an installed plist)', () => {
  it('round-trips ProgramArguments through the real buildPlist — [node, binJs, serve, …]', () => {
    const plist = buildPlist({
      label: SERVICE_LABEL,
      node: '/opt/homebrew/bin/node',
      binJs: '/Users/nick/agents/packages/cli/dist/bin.js',
      serveArgs: ['serve', '--port', '4849'],
      workingDir: '/Users/nick/agents',
      stdoutPath: '/l',
      stderrPath: '/e',
      path: '/p',
    });
    expect(parsePlistProgramArguments(plist)).toEqual([
      '/opt/homebrew/bin/node',
      '/Users/nick/agents/packages/cli/dist/bin.js',
      'serve',
      '--port',
      '4849',
    ]);
  });

  it('XML-unescapes so a path with & round-trips', () => {
    const plist = buildPlist({
      label: 'x',
      node: '/n',
      binJs: '/a & b/packages/cli/dist/bin.js',
      serveArgs: ['serve'],
      workingDir: '/w',
      stdoutPath: '/o',
      stderrPath: '/e',
      path: '/p',
    });
    expect(parsePlistProgramArguments(plist)?.[1]).toBe('/a & b/packages/cli/dist/bin.js');
  });

  it('returns null for a non-plist / no ProgramArguments', () => {
    expect(parsePlistProgramArguments('not xml')).toBeNull();
    expect(parsePlistProgramArguments('<plist><dict></dict></plist>')).toBeNull();
  });
});

// ---- pure: launchctl argv + status parsing ----

describe('launchctl argv builders', () => {
  it('builds the gui-domain targets for each op', () => {
    expect(bootstrapArgs(501, '/p.plist')).toEqual(['bootstrap', 'gui/501', '/p.plist']);
    expect(bootoutArgs(501, 'lbl')).toEqual(['bootout', 'gui/501/lbl']);
    expect(kickstartArgs(501, 'lbl')).toEqual(['kickstart', '-k', 'gui/501/lbl']);
    expect(printArgs(501, 'lbl')).toEqual(['print', 'gui/501/lbl']);
  });
});

describe('parseLaunchctlPrint', () => {
  it('extracts pid + state when loaded', () => {
    const out = '\tstate = running\n\tpid = 48456\n\tprogram = /node\n';
    expect(parseLaunchctlPrint(out, true)).toEqual({ loaded: true, pid: 48456, state: 'running' });
  });

  it('reports not-loaded when print failed', () => {
    expect(parseLaunchctlPrint('', false)).toEqual({ loaded: false, pid: null, state: null });
  });

  it('handles a loaded-but-not-running agent (no pid line)', () => {
    expect(parseLaunchctlPrint('\tstate = waiting\n', true)).toEqual({
      loaded: true,
      pid: null,
      state: 'waiting',
    });
  });
});

// ---- orchestration with a fake runner + temp plist (no real launchctl / ~/Library) ----

describe('lifecycle ops', () => {
  let dir: string;
  let calls: { cmd: string; args: string[] }[];

  function ctxWith(runner: Runner): ServiceCtx {
    return {
      uid: 501,
      label: SERVICE_LABEL,
      plistPath: join(dir, 'agent.plist'),
      node: '/opt/homebrew/bin/node',
      binJs: '/repo/packages/cli/dist/bin.js',
      serveArgs: ['serve'],
      workingDir: '/repo',
      stdoutPath: join(dir, 'daemon.log'),
      stderrPath: join(dir, 'daemon.err.log'),
      path: '/usr/bin:/bin',
      run: runner,
      sleep: () => {}, // don't actually wait during the bootstrap retry
    };
  }

  const recording =
    (result: RunResult = { status: 0, stdout: '', stderr: '' }): Runner =>
    (cmd, args) => {
      calls.push({ cmd, args });
      return result;
    };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-svc-'));
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('install writes the plist then bootout(ignored)+bootstrap', () => {
    const ctx = ctxWith(recording());
    const res = install(ctx);
    expect(res.ok).toBe(true);
    expect(existsSync(ctx.plistPath)).toBe(true);
    expect(readFileSync(ctx.plistPath, 'utf8')).toContain(SERVICE_LABEL);
    expect(calls.map((c) => c.args[0])).toEqual(['bootout', 'bootstrap']);
  });

  it('install reports not-ok when bootstrap fails', () => {
    let n = 0;
    const ctx = ctxWith((cmd, args) => {
      calls.push({ cmd, args });
      // bootout ok, bootstrap fails
      return { status: n++ === 0 ? 0 : 1, stdout: '', stderr: 'boom' };
    });
    expect(install(ctx).ok).toBe(false);
  });

  it('uninstall boots out and removes the plist (idempotent when absent)', () => {
    const ctx = ctxWith(recording());
    writeFileSync(ctx.plistPath, 'x', 'utf8');
    expect(uninstall(ctx).removed).toBe(true);
    expect(existsSync(ctx.plistPath)).toBe(false);
    // absent now → removed:false, no throw
    expect(uninstall(ctx).removed).toBe(false);
  });

  it('start=bootstrap, stop=bootout', () => {
    const ctx = ctxWith(recording());
    start(ctx);
    stop(ctx);
    expect(calls.map((c) => c.args[0])).toEqual(['bootstrap', 'bootout']);
  });

  it('restart kickstarts in place, falling back to bootstrap when not loaded', () => {
    // kickstart fails (not loaded) → bootstrap
    let first = true;
    const ctx = ctxWith((cmd, args) => {
      calls.push({ cmd, args });
      const status = first ? 1 : 0;
      first = false;
      return { status, stdout: '', stderr: '' };
    });
    restart(ctx);
    expect(calls.map((c) => c.args[0])).toEqual(['kickstart', 'bootstrap']);
  });

  it('status parses the runner output', () => {
    const ctx = ctxWith(() => ({
      status: 0,
      stdout: '\tpid = 7\n\tstate = running\n',
      stderr: '',
    }));
    expect(status(ctx)).toEqual({ loaded: true, pid: 7, state: 'running' });
  });

  it('tailFile returns [] when missing and the last N lines otherwise', () => {
    const p = join(dir, 'log.txt');
    expect(tailFile(p, 5)).toEqual([]);
    writeFileSync(p, 'a\nb\nc\nd\n', 'utf8');
    expect(tailFile(p, 2)).toEqual(['c', 'd']);
  });
});
