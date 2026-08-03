import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootoutArgs,
  bootstrapArgs,
  buildPlist,
  kickstartArgs,
  agentFailureNote,
  intervalAgentLabel,
  parseLaunchctlPrint,
  stableNodePath,
  type LaunchctlStatus,
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
    expect(parseLaunchctlPrint(out, true)).toEqual({
      loaded: true,
      pid: 48456,
      state: 'running',
      lastExit: null,
    });
  });

  it('reports not-loaded when print failed', () => {
    expect(parseLaunchctlPrint('', false)).toEqual({
      loaded: false,
      pid: null,
      state: null,
      lastExit: null,
    });
  });

  it('handles a loaded-but-not-running agent (no pid line)', () => {
    expect(parseLaunchctlPrint('\tstate = waiting\n', true)).toEqual({
      loaded: true,
      pid: null,
      state: 'waiting',
      lastExit: null,
    });
  });

  it('reads the last exit code — the only thing separating a dead agent from a healthy one', () => {
    // Real `launchctl print` output from the wake actuator on 2026-07-25, after a Homebrew node
    // upgrade retired the versioned path its plist named. Note `state = spawn scheduled`: launchd
    // keeps a crash-looping agent loaded, so nothing else here says it is broken.
    const out = '\tstate = spawn scheduled\n\truns = 1\n\tlast exit code = 78: EX_CONFIG\n';
    expect(parseLaunchctlPrint(out, true)).toEqual({
      loaded: true,
      pid: null,
      state: 'spawn scheduled',
      lastExit: 78,
    });
  });
});

// Measured 2026-08-03: `service status --auto` printed `✓ daemon auto-refresher: not running` for a
// perfectly healthy refresher — 2775 runs, last exit 0, ticking every 120s, observed live. `not
// running` is launchd's literal `state` for a periodic one-shot BETWEEN ticks, so the raw string is
// accurate and the reading is inverted: nick read it as an outage and asked for an investigation of
// failures that did not exist. A health line whose healthy case says "not running" is a broken
// health line, however true the string is.
describe('intervalAgentLabel (an idle interval agent is healthy, not down)', () => {
  const st = (over: Partial<LaunchctlStatus> = {}): LaunchctlStatus => ({
    loaded: true,
    pid: null,
    state: 'not running',
    lastExit: 0,
    ...over,
  });

  it('reads an idle tick as idle, never as "not running"', () => {
    const label = intervalAgentLabel(st());
    expect(label).toContain('idle');
    expect(label).not.toContain('not running');
  });

  it('says a tick is in flight when one actually is', () => {
    expect(intervalAgentLabel(st({ pid: 4242, state: 'running' }))).toContain('running');
  });

  it('distinguishes never-ticked from ticked-and-idle', () => {
    // `last exit code` is absent until the first run completes — "loaded but nothing has happened
    // yet" is a different fact from "ran and is waiting", and right after `install` it is the
    // expected one.
    expect(intervalAgentLabel(st({ lastExit: null }))).toContain('no tick yet');
  });

  it('does not dress up a real failure as idle', () => {
    // The dead case still has to read as dead — agentFailureNote prints the ✗ detail beneath, but
    // the headline must not say "idle" over a non-zero exit.
    const label = intervalAgentLabel(st({ lastExit: 78 }));
    expect(label).not.toContain('idle');
    expect(label).toContain('not running');
  });

  it('leaves a not-loaded agent to the caller', () => {
    expect(intervalAgentLabel(st({ loaded: false }))).toBeNull();
  });
});

describe('agentFailureNote (a loaded agent that is actually dead)', () => {
  const st = (over: Partial<LaunchctlStatus> = {}): LaunchctlStatus => ({
    loaded: true,
    pid: 123,
    state: 'running',
    lastExit: null,
    ...over,
  });

  it('says nothing about a healthy agent', () => {
    expect(agentFailureNote(st())).toBeNull();
    expect(agentFailureNote(st({ pid: null, state: 'waiting' }))).toBeNull(); // an interval tick between runs
  });

  it('says nothing about an agent that was never loaded', () => {
    expect(agentFailureNote(st({ loaded: false, pid: null }))).toBeNull();
  });

  it('names the upgrade when the plist points at a program that is gone', () => {
    const note = agentFailureNote(st(), false);
    expect(note).toMatch(/no longer exists/);
    expect(note).toMatch(/reinstall/);
  });

  it('calls out EX_CONFIG specifically — it is the shape a stale node path takes', () => {
    const note = agentFailureNote(st({ pid: null, state: 'spawn scheduled', lastExit: 78 }));
    expect(note).toMatch(/EX_CONFIG/);
    expect(note).toMatch(/reinstall/);
  });

  it('still reports a plain non-zero exit it does not recognise', () => {
    expect(agentFailureNote(st({ pid: null, lastExit: 1 }))).toMatch(/last exit code 1/);
  });

  it('does not cry wolf over a running agent whose previous run exited non-zero', () => {
    // A pid means it is up now; the old exit code is history, not a fault.
    expect(agentFailureNote(st({ pid: 999, lastExit: 78 }))).toBeNull();
  });
});

describe('stableNodePath (surviving a Homebrew upgrade)', () => {
  const CELLAR = '/opt/homebrew/Cellar/node@22/22.23.1/bin/node';
  const OPT = '/opt/homebrew/opt/node@22/bin/node';

  it('prefers the formula symlink when it resolves to the same binary', () => {
    // The link follows 22.22 → 22.23, so the plist keeps working across a patch upgrade.
    expect(stableNodePath(CELLAR, (p) => (p === OPT ? CELLAR : p))).toBe(OPT);
  });

  it('keeps the concrete path when the symlink points somewhere else', () => {
    // The safety rail: never silently re-point an agent at a different node. On this machine
    // /opt/homebrew/bin/node is node 26, and swapping ABI under better-sqlite3 is the crashloop the
    // install guard exists to prevent.
    expect(
      stableNodePath(CELLAR, (p) => (p === OPT ? '/opt/homebrew/Cellar/node/26.5.0/bin/node' : p)),
    ).toBe(CELLAR);
  });

  it('keeps the concrete path when there is no symlink at all', () => {
    expect(
      stableNodePath(CELLAR, (p) => {
        if (p === OPT) throw new Error('ENOENT');
        return p;
      }),
    ).toBe(CELLAR);
  });

  it('leaves a non-Homebrew node alone (nvm, system, a container)', () => {
    for (const p of ['/usr/local/bin/node', '/Users/x/.nvm/versions/node/v22.1.0/bin/node']) {
      expect(stableNodePath(p, (q) => q)).toBe(p);
    }
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
    expect(status(ctx)).toEqual({ loaded: true, pid: 7, state: 'running', lastExit: null });
  });

  it('tailFile returns [] when missing and the last N lines otherwise', () => {
    const p = join(dir, 'log.txt');
    expect(tailFile(p, 5)).toEqual([]);
    writeFileSync(p, 'a\nb\nc\nd\n', 'utf8');
    expect(tailFile(p, 2)).toEqual(['c', 'd']);
  });
});
