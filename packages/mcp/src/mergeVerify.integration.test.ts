/*
 * verifyMerge against a real repo. `origin` is a local bare repo, so `git fetch origin main`
 * exercises the real fetch path with no network.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { verifyMerge } from './mergeVerify.js';

const root = mkdtempSync(join(tmpdir(), 'mergeverify-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function setup() {
  const upstream = join(root, 'upstream.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', upstream]);
  const work = join(root, 'work');
  execFileSync('git', ['clone', upstream, work]);
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'a.txt'), 'one');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'landed');
  git(work, 'push', 'origin', 'main');
  const landed = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-b', 'feature');
  writeFileSync(join(work, 'b.txt'), 'two');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'unlanded');
  const unlanded = git(work, 'rev-parse', 'HEAD');
  return { work, landed, unlanded };
}

describe('verifyMerge against a real repo', () => {
  const { work, landed, unlanded } = setup();

  it('landed commit → ancestor', async () => {
    expect(await verifyMerge({ sha: landed, cwd: work })).toBe('ancestor');
  });

  it('committed but never merged → not_ancestor', async () => {
    expect(await verifyMerge({ sha: unlanded, cwd: work })).toBe('not_ancestor');
  });

  it('sha from some other repo → unknown_object', async () => {
    expect(await verifyMerge({ sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', cwd: work })).toBe(
      'unknown_object',
    );
  });
});
