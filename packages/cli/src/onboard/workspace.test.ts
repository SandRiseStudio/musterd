import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { provisionWorkspace, setSeatGitIdentity } from './workspace.js';

const made: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('provisionWorkspace', () => {
  it('--here binds the current folder, creates nothing', () => {
    const cwd = tmp('mwd-here-');
    const ws = provisionWorkspace('June', { here: true, cwd });
    expect(ws).toMatchObject({ dir: cwd, kind: 'here', created: false });
  });

  it('--path creates an explicit folder', () => {
    const cwd = tmp('mwd-path-');
    const target = join(cwd, 'nested', 'spot');
    const ws = provisionWorkspace('June', { path: target, cwd });
    expect(ws.kind).toBe('folder');
    expect(ws.created).toBe(true);
    expect(existsSync(ws.dir)).toBe(true);
  });

  it('falls back to a sibling folder outside a git repo', () => {
    const cwd = tmp('mwd-folder-');
    const ws = provisionWorkspace('June', { cwd });
    expect(ws.kind).toBe('folder');
    expect(ws.dir).toBe(join(dirname(cwd), `${basename(cwd)}-June`));
    expect(existsSync(ws.dir)).toBe(true);
  });

  it('creates a git worktree on its own branch inside a repo', () => {
    const repo = tmp('mwd-git-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: repo });

    const ws = provisionWorkspace('June', { cwd: repo });
    made.push(ws.dir); // ensure cleanup even though it's a sibling of repo
    expect(ws.kind).toBe('worktree');
    expect(ws.branch).toBe('agent/June');
    expect(existsSync(join(ws.dir, '.git'))).toBe(true);
    const branches = execFileSync('git', ['branch', '--list', 'agent/June'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(branches).toContain('agent/June');
  });

  it('reuses an existing worktree directory instead of failing', () => {
    const repo = tmp('mwd-git2-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: repo });

    const first = provisionWorkspace('June', { cwd: repo });
    made.push(first.dir);
    const second = provisionWorkspace('June', { cwd: repo });
    expect(second.dir).toBe(first.dir);
    expect(second.created).toBe(false);
  });

  it('sets the seat git identity on the worktree, worktree-scoped (ADR 109)', () => {
    const repo = tmp('mwd-git3-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'human@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Human'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: repo });

    const ws = provisionWorkspace('June', { cwd: repo, team: 'revive' });
    made.push(ws.dir);
    const cfg = (key: string, cwd: string) =>
      execFileSync('git', ['config', key], { cwd, encoding: 'utf8' }).trim();
    expect(cfg('user.name', ws.dir)).toBe('June (musterd seat)');
    expect(cfg('user.email', ws.dir)).toBe('June@revive.musterd');
    // Worktree-scoped, not repo-local: the main tree keeps the human identity.
    expect(cfg('user.name', repo)).toBe('Human');
    expect(cfg('user.email', repo)).toBe('human@example.com');
  });

  it('--path at an existing seat worktree still sets the identity — the grant-recovery path (ADR 109)', () => {
    // `musterd agent <seat> --path <ws>` is the documented repair for an expired grant, so it runs
    // against worktrees that already exist and are already in use. It used to return before writing
    // any identity, which meant the fix for a broken credential silently stripped seat attribution —
    // and left every later commit from that seat authored as the human.
    const repo = tmp('mwd-path-id-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'human@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Human'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: repo });

    const first = provisionWorkspace('June', { cwd: repo, team: 'revive' });
    made.push(first.dir);
    // Simulate a worktree provisioned before ADR 109 (or one whose config was lost).
    execFileSync('git', ['config', '--worktree', '--unset', 'user.name'], { cwd: first.dir });
    execFileSync('git', ['config', '--worktree', '--unset', 'user.email'], { cwd: first.dir });

    const repaired = provisionWorkspace('June', { path: first.dir, cwd: repo, team: 'revive' });
    expect(repaired.dir).toBe(first.dir);
    const cfg = (key: string) =>
      execFileSync('git', ['config', key], { cwd: repaired.dir, encoding: 'utf8' }).trim();
    expect(cfg('user.name')).toBe('June (musterd seat)');
    expect(cfg('user.email')).toBe('June@revive.musterd');
    // Still worktree-scoped — repairing one seat must never rename the human's main tree.
    expect(
      execFileSync('git', ['config', 'user.name'], { cwd: repo, encoding: 'utf8' }).trim(),
    ).toBe('Human');
  });

  it('--here in a seat worktree sets the identity too', () => {
    const repo = tmp('mwd-here-id-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'human@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Human'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: repo });

    const first = provisionWorkspace('June', { cwd: repo, team: 'revive' });
    made.push(first.dir);
    execFileSync('git', ['config', '--worktree', '--unset', 'user.name'], { cwd: first.dir });

    provisionWorkspace('June', { here: true, cwd: first.dir, team: 'revive' });
    expect(
      execFileSync('git', ['config', 'user.name'], { cwd: first.dir, encoding: 'utf8' }).trim(),
    ).toBe('June (musterd seat)');
  });

  it('--path outside a git repo is harmless — attribution never gates provisioning', () => {
    // A plain folder has no worktree config to write; the best-effort identity write must not throw.
    const cwd = tmp('mwd-path-plain-');
    const target = join(cwd, 'spot');
    const ws = provisionWorkspace('June', { path: target, cwd, team: 'revive' });
    expect(ws).toMatchObject({ kind: 'folder', created: true });
    expect(existsSync(ws.dir)).toBe(true);
  });

  it('repairs the seat git identity on reuse (pre-109 worktrees)', () => {
    const repo = tmp('mwd-git4-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: repo });

    const first = provisionWorkspace('June', { cwd: repo });
    made.push(first.dir);
    execFileSync('git', ['config', '--worktree', '--unset', 'user.name'], { cwd: first.dir });
    execFileSync('git', ['config', '--worktree', '--unset', 'user.email'], { cwd: first.dir });
    const second = provisionWorkspace('June', { cwd: repo, team: 'revive' });
    expect(second.created).toBe(false);
    const name = execFileSync('git', ['config', 'user.name'], {
      cwd: second.dir,
      encoding: 'utf8',
    }).trim();
    expect(name).toBe('June (musterd seat)');
  });

  it('setSeatGitIdentity rewrites the team domain on re-bind (ADR 196)', () => {
    // claim/join call this after saveBinding; without it a folder that moves teams keeps
    // seat@oldTeam.musterd and splits one seat across two emails on main.
    const repo = tmp('mwd-rebind-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'human@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Human'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: repo });

    const ws = provisionWorkspace('grokbot', { cwd: repo, team: 'oldteam' });
    made.push(ws.dir);
    const cfg = (key: string) =>
      execFileSync('git', ['config', key], { cwd: ws.dir, encoding: 'utf8' }).trim();
    expect(cfg('user.email')).toBe('grokbot@oldteam.musterd');

    setSeatGitIdentity('grokbot', ws.dir, 'revive');
    expect(cfg('user.name')).toBe('grokbot (musterd seat)');
    expect(cfg('user.email')).toBe('grokbot@revive.musterd');
    // Still worktree-scoped — re-bind must never rename the human's main tree.
    expect(
      execFileSync('git', ['config', 'user.email'], { cwd: repo, encoding: 'utf8' }).trim(),
    ).toBe('human@example.com');
  });
});
