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
  buildLiveServePlist,
  buildLiveServeScript,
  buildLiveSyncPlist,
  buildLiveSyncScript,
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

// ---- pure: generated scripts ----

describe('buildLiveServeScript', () => {
  const s = buildLiveServeScript({
    worktree: '/Users/x/agents-live',
    port: 5173,
    nodeDir: '/opt/node/bin',
    gitDir: '/opt/homebrew/bin',
    uid: 501,
    serverLabel: LIVE_LABEL,
  });
  it('syncs to origin/main, builds protocol, and execs vite on the port', () => {
    expect(s).toContain('git checkout --quiet --detach origin/main');
    expect(s).toContain('pnpm --filter @musterd/protocol build');
    expect(s).toContain('exec pnpm dev --port 5173');
    expect(s).toContain('WORKTREE="/Users/x/agents-live"');
    expect(s).toContain('cd "$WORKTREE/packages/web"');
  });
  it('puts node + pnpm on PATH (pnpm lives under $HOME/Library/pnpm)', () => {
    expect(s).toContain('/opt/node/bin');
    expect(s).toContain('${HOME}/Library/pnpm');
  });
});

describe('buildLiveSyncScript', () => {
  const s = buildLiveSyncScript({
    worktree: '/Users/x/agents-live',
    port: 5173,
    nodeDir: '/opt/node/bin',
    gitDir: '/opt/git/bin',
    uid: 501,
    serverLabel: LIVE_LABEL,
  });
  it('is a no-op when HEAD already equals origin/main, else kickstarts the server', () => {
    expect(s).toContain('rev-parse HEAD');
    expect(s).toContain('rev-parse origin/main');
    expect(s).toContain(`kickstart -k gui/501/${LIVE_LABEL}`);
  });
});

describe('buildLive*Plist', () => {
  it('server plist is KeepAlive and runs its script via bash', () => {
    const p = buildLiveServePlist({
      label: LIVE_LABEL,
      scriptPath: '/home/.musterd/live/serve.sh',
      workingDir: '/w',
      stdoutPath: '/l/viewer.log',
      stderrPath: '/l/viewer.log',
    });
    expect(p).toContain(`<string>${LIVE_LABEL}</string>`);
    expect(p).toContain('<string>/bin/bash</string>');
    expect(p).toContain('<string>/home/.musterd/live/serve.sh</string>');
    expect(p).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(p).not.toContain('StartInterval');
  });
  it('tracker plist is interval-driven and NOT KeepAlive', () => {
    const p = buildLiveSyncPlist({
      label: LIVE_SYNC_LABEL,
      scriptPath: '/home/.musterd/live/sync.sh',
      workingDir: '/w',
      stdoutPath: '/l/sync.log',
      stderrPath: '/l/sync.log',
      intervalSeconds: 60,
    });
    expect(p).toMatch(/<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    expect(p).not.toContain('<key>KeepAlive</key>');
  });
});

// ---- orchestration with an injected runner + temp dirs ----

function makeCtx(run: Runner, dir: string): LiveCtx {
  return {
    uid: 501,
    serverLabel: LIVE_LABEL,
    syncLabel: LIVE_SYNC_LABEL,
    worktree: join(dir, 'agents-live'),
    sourceRepo: join(dir, 'agents'),
    serverPlistPath: join(dir, 'LaunchAgents', `${LIVE_LABEL}.plist`),
    syncPlistPath: join(dir, 'LaunchAgents', `${LIVE_SYNC_LABEL}.plist`),
    serveScriptPath: join(dir, 'live', 'serve.sh'),
    syncScriptPath: join(dir, 'live', 'sync.sh'),
    serverLogPath: join(dir, 'live', 'viewer.log'),
    syncLogPath: join(dir, 'live', 'sync.log'),
    port: 5173,
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

  it('adds the worktree, writes executable scripts + both plists, and bootstraps both agents', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    const res = installLive(ctx);

    expect(res.worktree.created).toBe(true);
    expect(res.server.status).toBe(0);
    expect(res.sync.status).toBe(0);

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
    // both agents bootstrapped
    expect(calls).toContainEqual(['launchctl', 'bootstrap', 'gui/501', ctx.serverPlistPath]);
    expect(calls).toContainEqual(['launchctl', 'bootstrap', 'gui/501', ctx.syncPlistPath]);

    // artifacts on disk, scripts executable
    expect(readFileSync(ctx.serveScriptPath, 'utf8')).toContain('exec pnpm dev --port 5173');
    expect(readFileSync(ctx.serverPlistPath, 'utf8')).toContain(LIVE_LABEL);
    expect(readFileSync(ctx.syncPlistPath, 'utf8')).toContain(LIVE_SYNC_LABEL);
    expect(statSync(ctx.serveScriptPath).mode & 0o100).toBeTruthy(); // owner-executable
  });

  it('skips the worktree add when the worktree already exists (existing .git)', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    // Simulate an already-present worktree: a `.git` file inside ctx.worktree.
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

  it('uninstall boots out both agents and removes the two plists', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    installLive(ctx);
    const res = uninstallLive(ctx);
    expect(res.removedPlists).toBe(2);
    expect(existsSync(ctx.serverPlistPath)).toBe(false);
    expect(existsSync(ctx.syncPlistPath)).toBe(false);
    expect(calls).toContainEqual(['launchctl', 'bootout', 'gui/501/' + LIVE_LABEL]);
    expect(calls).toContainEqual(['launchctl', 'bootout', 'gui/501/' + LIVE_SYNC_LABEL]);
  });

  it('refresh kickstarts the server agent', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    refreshLive(ctx);
    expect(calls).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/' + LIVE_LABEL]);
  });

  it('status reports both agents from launchctl print', () => {
    const run: Runner = (_cmd, args): RunResult => {
      const target = args[args.length - 1];
      if (target === 'gui/501/' + LIVE_LABEL)
        return { status: 0, stdout: 'state = running\npid = 4242', stderr: '' };
      return { status: 1, stdout: '', stderr: 'not loaded' }; // sync not loaded
    };
    const ctx = makeCtx(run, dir);
    const st = statusLive(ctx);
    expect(st.server.loaded).toBe(true);
    expect(st.server.pid).toBe(4242);
    expect(st.sync.loaded).toBe(false);
  });

  it('stop boots out both without touching artifacts', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx = makeCtx(run, dir);
    installLive(ctx);
    stopLive(ctx);
    expect(existsSync(ctx.serverPlistPath)).toBe(true); // stop leaves the plist
    expect(calls).toContainEqual(['launchctl', 'bootout', 'gui/501/' + LIVE_LABEL]);
  });
});
