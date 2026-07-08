import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { provisionWorkspace } from './workspace.js';

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
});
