import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLiveBuildPlist,
  buildLiveBuildScript,
  LIVE_LABEL,
  LIVE_SYNC_LABEL,
} from './launchd.js';
import {
  ensureWorktree,
  installLive,
  refreshLive,
  statusLive,
  stopLive,
  uninstallLive,
  type LiveCtx,
} from './live.js';
import type { RunResult, Runner } from './manage.js';

// ---- pure: the generated build-publisher script (ADR 132) ----

describe('buildLiveBuildScript', () => {
  const s = buildLiveBuildScript({
    worktree: '/Users/x/agents-live',
    webRoot: '/Users/x/.musterd/live/web',
    nodeDir: '/opt/node/bin',
    gitDir: '/opt/git/bin',
  });
  it('syncs to origin/main, builds protocol then web, and does NOT run a dev server', () => {
    expect(s).toContain('git checkout --quiet --detach origin/main');
    expect(s).toContain('pnpm --filter @musterd/protocol build');
    expect(s).toContain('pnpm --filter @musterd/web build');
    expect(s).not.toContain('pnpm dev'); // no dev server anymore
    expect(s).toContain('WORKTREE="/Users/x/agents-live"');
    expect(s).toContain('WEBROOT="/Users/x/.musterd/live/web"');
  });
  it('atomically publishes the built bundle into the web-root (stage + rename swap)', () => {
    expect(s).toContain('cp -R "$SRC" "$STAGE"'); // stage on the web-root filesystem
    expect(s).toContain('mv "$STAGE" "$WEBROOT"'); // atomic swap into place
    expect(s).toContain('packages/web/dist/client'); // the vite client output
  });
  it('skips the build when already current AND the published tip stamp matches', () => {
    expect(s).toContain('rev-parse HEAD');
    expect(s).toContain('rev-parse origin/main');
    expect(s).toContain('.published-sha');
    expect(s).not.toContain('-f "$WEBROOT/index.html"');
  });
  it('puts node + git + pnpm on PATH (pnpm lives under $HOME/Library/pnpm)', () => {
    expect(s).toContain('/opt/node/bin');
    expect(s).toContain('/opt/git/bin');
    expect(s).toContain('${HOME}/Library/pnpm');
  });
});

describe('buildLiveBuildPlist', () => {
  it('is interval-driven and NOT KeepAlive (it exits after publishing)', () => {
    const p = buildLiveBuildPlist({
      label: LIVE_LABEL,
      scriptPath: '/home/.musterd/live/build.sh',
      workingDir: '/w',
      stdoutPath: '/l/build.log',
      stderrPath: '/l/build.log',
      intervalSeconds: 60,
    });
    expect(p).toContain(`<string>${LIVE_LABEL}</string>`);
    expect(p).toContain('<string>/bin/bash</string>');
    expect(p).toContain('<string>/home/.musterd/live/build.sh</string>');
    expect(p).toMatch(/<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    expect(p).not.toContain('<key>KeepAlive</key>');
  });
});

// ---- orchestration with an injected runner + temp dirs ----

function makeCtx(run: Runner, dir: string): LiveCtx {
  return {
    uid: 501,
    buildLabel: LIVE_LABEL,
    legacySyncLabel: LIVE_SYNC_LABEL,
    worktree: join(dir, 'agents-live'),
    sourceRepo: join(dir, 'agents'),
    webRoot: join(dir, 'live', 'web'),
    buildPlistPath: join(dir, 'LaunchAgents', `${LIVE_LABEL}.plist`),
    buildScriptPath: join(dir, 'live', 'build.sh'),
    buildLogPath: join(dir, 'live', 'build.log'),
    legacySyncPlistPath: join(dir, 'LaunchAgents', `${LIVE_SYNC_LABEL}.plist`),
    legacyServeScriptPath: join(dir, 'live', 'serve.sh'),
    legacySyncScriptPath: join(dir, 'live', 'sync.sh'),
    nodeDir: '/opt/node/bin',
    gitDir: '/opt/homebrew/bin',
    intervalSeconds: 60,
    run,
    sleep: () => {},
  };
}

describe('installLive', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-live-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds the worktree, writes an executable script + plist, and bootstraps the build agent', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    const res = installLive(ctx);

    expect(res.worktree.created).toBe(true);
    expect(res.build.status).toBe(0);

    // worktree added from the source repo, detached at origin/main
    expect(calls).toContainEqual([
      'git',
      '-C',
      ctx.sourceRepo,
      'worktree',
      'add',
      '--detach',
      ctx.worktree,
      'origin/main',
    ]);
    // the single build agent bootstrapped
    expect(calls).toContainEqual(['launchctl', 'bootstrap', 'gui/501', ctx.buildPlistPath]);

    // artifacts on disk, script executable
    expect(readFileSync(ctx.buildScriptPath, 'utf8')).toContain('pnpm --filter @musterd/web build');
    expect(readFileSync(ctx.buildPlistPath, 'utf8')).toContain(LIVE_LABEL);
    expect(statSync(ctx.buildScriptPath).mode & 0o100).toBeTruthy(); // owner-executable
  });

  it('retires the ADR 124 dev-server bundle on install (boots out the old sync agent + files)', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    // Simulate a prior ADR 124 install leaving these artifacts behind.
    mkdirSync(join(dir, 'live'), { recursive: true });
    writeFileSync(ctx.legacyServeScriptPath, '# old serve.sh');
    writeFileSync(ctx.legacySyncScriptPath, '# old sync.sh');
    mkdirSync(join(dir, 'LaunchAgents'), { recursive: true });
    writeFileSync(ctx.legacySyncPlistPath, '<plist/>');

    installLive(ctx);
    expect(calls).toContainEqual(['launchctl', 'bootout', 'gui/501/' + LIVE_SYNC_LABEL]);
    expect(existsSync(ctx.legacyServeScriptPath)).toBe(false);
    expect(existsSync(ctx.legacySyncScriptPath)).toBe(false);
    expect(existsSync(ctx.legacySyncPlistPath)).toBe(false);
  });

  it('skips the worktree add when the worktree already exists (existing .git)', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    mkdirSync(ctx.worktree, { recursive: true });
    writeFileSync(join(ctx.worktree, '.git'), 'gitdir: ...\n');
    const res = ensureWorktree(ctx);
    expect(res.created).toBe(false);
    expect(calls.some((c) => c.includes('worktree'))).toBe(false); // no `git worktree add`
  });
});

describe('uninstallLive / stopLive / refreshLive / statusLive', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-live-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('uninstall boots out the agent (+ legacy), removes the plist, and clears the published bundle', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    installLive(ctx);
    // Simulate a published bundle in the web-root.
    mkdirSync(ctx.webRoot, { recursive: true });
    writeFileSync(join(ctx.webRoot, 'index.html'), '<!doctype html>');

    const res = uninstallLive(ctx);
    expect(res.removedPlists).toBe(1);
    expect(existsSync(ctx.buildPlistPath)).toBe(false);
    expect(existsSync(ctx.webRoot)).toBe(false); // published bundle cleared → daemon 404s /live
    expect(calls).toContainEqual(['launchctl', 'bootout', 'gui/501/' + LIVE_LABEL]);
    expect(calls).toContainEqual(['launchctl', 'bootout', 'gui/501/' + LIVE_SYNC_LABEL]); // legacy too
  });

  it('refresh clears the published stamp then kickstarts (forces a rebuild + publish now)', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    mkdirSync(ctx.webRoot, { recursive: true });
    writeFileSync(join(ctx.webRoot, '.published-sha'), 'deadbeef\n');
    refreshLive(ctx);
    expect(existsSync(join(ctx.webRoot, '.published-sha'))).toBe(false);
    expect(calls).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/' + LIVE_LABEL]);
  });

  it('status reports the build agent from launchctl print', () => {
    const run: Runner = (_cmd, args): RunResult => {
      const target = args[args.length - 1];
      if (target === 'gui/501/' + LIVE_LABEL)
        return { status: 0, stdout: 'state = running\npid = 4242', stderr: '' };
      return { status: 1, stdout: '', stderr: 'not loaded' };
    };
    const ctx = makeCtx(run, dir);
    const st = statusLive(ctx);
    expect(st.build.loaded).toBe(true);
    expect(st.build.pid).toBe(4242);
  });

  it('stop boots out the agent without touching artifacts', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    installLive(ctx);
    stopLive(ctx);
    expect(existsSync(ctx.buildPlistPath)).toBe(true); // stop leaves the plist
    expect(calls).toContainEqual(['launchctl', 'bootout', 'gui/501/' + LIVE_LABEL]);
  });
});
