import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT, repoProject, resolveProject } from './project.js';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('resolveProject', () => {
  let root: string;
  let repo: string;
  let worktreeA: string;
  let worktreeB: string;
  let plain: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-project-'));
    repo = join(root, 'acme');
    mkdirSync(repo);
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 'test@musterd.test'], repo);
    git(['config', 'user.name', 'test'], repo);
    writeFileSync(join(repo, 'README.md'), '# acme\n');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'init'], repo);
    // Exactly the shape `provisionWorkspace` creates: sibling worktrees named <repo>-<seat>.
    worktreeA = join(root, 'acme-ada');
    worktreeB = join(root, 'acme-bo');
    git(['worktree', 'add', '-q', '-b', 'agent/ada', worktreeA, 'HEAD'], repo);
    git(['worktree', 'add', '-q', '-b', 'agent/bo', worktreeB, 'HEAD'], repo);
    plain = join(root, 'not-a-repo');
    mkdirSync(plain);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('derives the repo name at the top of the main work tree', () => {
    expect(repoProject(repo)).toBe('acme');
  });

  it('derives the same name from a subdirectory', () => {
    const sub = join(repo, 'packages', 'server');
    mkdirSync(sub, { recursive: true });
    expect(repoProject(sub)).toBe('acme');
  });

  /**
   * The load-bearing case, and the reason this does not use `--show-toplevel`: musterd gives every
   * seat its own worktree, so a per-worktree name would fragment one repo into N projects and turn
   * surface-overlap off for the whole team — silently, because the checks are warn-only.
   */
  it('agrees across sibling worktrees of one repo', () => {
    expect(repoProject(worktreeA)).toBe('acme');
    expect(repoProject(worktreeB)).toBe('acme');
    expect(repoProject(worktreeA)).toBe(repoProject(repo));
  });

  it('falls back to the default outside a work tree', () => {
    expect(repoProject(plain)).toBeNull();
    expect(resolveProject({ cwd: plain, env: {} })).toBe(DEFAULT_PROJECT);
  });

  it('prefers an explicit project over everything', () => {
    expect(resolveProject({ explicit: 'chosen', env: { MUSTERD_PROJECT: 'env' }, cwd: repo })).toBe(
      'chosen',
    );
  });

  it('prefers MUSTERD_PROJECT over the derived repo identity', () => {
    expect(resolveProject({ env: { MUSTERD_PROJECT: 'env' }, cwd: repo })).toBe('env');
  });

  it('treats a blank explicit/env value as undeclared', () => {
    expect(resolveProject({ explicit: '   ', env: { MUSTERD_PROJECT: '  ' }, cwd: repo })).toBe(
      'acme',
    );
  });

  it('sanitizes whitespace and caps length', () => {
    expect(resolveProject({ explicit: ' two words ', env: {} })).toBe('two-words');
    expect(resolveProject({ explicit: 'x'.repeat(200), env: {} })).toHaveLength(80);
  });
});
