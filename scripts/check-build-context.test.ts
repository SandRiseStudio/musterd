import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isExcluded, parseDockerignore, patternMatches } from './build-context.ts';
import {
  copiesWholeContext,
  HAZARD_PATHS,
  KNOWN_WHOLE_CONTEXT,
  REQUIRED_PATHS,
  ruleA,
  ruleAOverBroad,
} from './check-build-context.ts';

/*
 * Tests for the build-context gate.
 *
 * Same discipline as check-watches.test.ts: the point is to prove every rule can actually FAIL. A
 * gate that cannot fail is worse than no gate, because it reads as protection (ADR 294's `absence`
 * class) — and this gate guards a credential, so a false green is the expensive direction.
 *
 * The matcher gets its own tests first, because every rule is only as true as it is. It reproduces
 * Docker's semantics, and the three that matter are the ones a hand-rolled glob usually gets wrong:
 * parent-directory matching, last-match-wins, and `*` not crossing a `/`.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const realPatterns = parseDockerignore(readFileSync(join(repoRoot, '.dockerignore'), 'utf8'));

describe('the matcher reproduces Docker, not a glob library', () => {
  it('excludes a file because its PARENT directory matches', () => {
    const p = parseDockerignore('.musterd/');
    expect(isExcluded(p, '.musterd/binding.json')).toBe(true);
    expect(isExcluded(p, '.musterd/pending/01ABC.json')).toBe(true);
    // The falsifier: a sibling with the same prefix is NOT under that directory.
    expect(isExcluded(p, '.musterd-notes/binding.json')).toBe(false);
  });

  it('lets the LAST matching pattern win, in both directions', () => {
    const excludeThenAllow = parseDockerignore('.musterd/\n!.musterd/keep.txt');
    expect(isExcluded(excludeThenAllow, '.musterd/keep.txt')).toBe(false);
    expect(isExcluded(excludeThenAllow, '.musterd/binding.json')).toBe(true);

    // Order matters — the same two lines reversed give the opposite answer.
    const allowThenExclude = parseDockerignore('!.musterd/keep.txt\n.musterd/');
    expect(isExcluded(allowThenExclude, '.musterd/keep.txt')).toBe(true);
  });

  it('does not let `*` cross a slash, but lets `**` do it', () => {
    expect(patternMatches(parseDockerignore('*.json')[0]!, 'a/b.json')).toBe(false);
    expect(patternMatches(parseDockerignore('**/*.json')[0]!, 'a/b.json')).toBe(true);
    expect(patternMatches(parseDockerignore('**/.musterd')[0]!, 'packages/cli/.musterd')).toBe(
      true,
    );
    // `**` also matches zero segments.
    expect(patternMatches(parseDockerignore('**/.musterd')[0]!, '.musterd')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    expect(parseDockerignore('# a comment\n\n   \n.musterd/')).toHaveLength(1);
  });
});

describe('rule A — hazard paths must be excluded', () => {
  it('passes against the repo’s real .dockerignore', () => {
    expect(ruleA(realPatterns)).toEqual([]);
  });

  it('FAILS when .dockerignore does not mention seat state', () => {
    const weak = parseDockerignore('node_modules\n.git\n**/dist\ncoverage\n*.log');
    expect(ruleA(weak)).toEqual([...HAZARD_PATHS]);
  });

  it('FAILS when .dockerignore is weakened to a per-file list', () => {
    // The shape someone reaches for when mirroring .gitignore entry by entry: it covers the
    // binding at the root and misses the same file one package deep, and misses whatever the
    // harness writes next.
    const perFile = parseDockerignore('.musterd/binding.json\n.musterd/continuity.json');
    const leaked = ruleA(perFile);
    expect(leaked).toContain('packages/cli/.musterd/binding.json');
    expect(leaked).toContain('.musterd/pending/01ABC.json');
    expect(leaked).not.toContain('.musterd/binding.json');
  });

  it('FAILS when a negation re-admits the binding', () => {
    const reopened = parseDockerignore('.musterd/\n.claude/\n.codex/\n!**/binding.json');
    expect(ruleA(reopened)).toContain('.musterd/binding.json');
  });
});

describe('rule A’s falsifier — the image must still get what it needs', () => {
  it('passes against the repo’s real .dockerignore', () => {
    expect(ruleAOverBroad(realPatterns)).toEqual([]);
  });

  it('FAILS on an over-broad .dockerignore that would empty the context', () => {
    expect(ruleAOverBroad(parseDockerignore('**'))).toEqual([...REQUIRED_PATHS]);
  });

  it('FAILS on a plausible over-reach, not just an absurd one', () => {
    // Excluding all of `packages/**/src` would still build "something" and pass rule A.
    const overReach = parseDockerignore('.musterd/\n**/src');
    expect(ruleAOverBroad(overReach)).toContain('packages/cli/src/bin.ts');
  });
});

describe('rule B — whole-context Dockerfiles are recognised', () => {
  it('recognises the forms that copy everything', () => {
    expect(copiesWholeContext('FROM node\nCOPY . .')).toBe(true);
    expect(copiesWholeContext('FROM node\nCOPY . /app')).toBe(true);
    expect(copiesWholeContext('FROM node\nCOPY --chown=seat:seat . /app')).toBe(true);
    expect(copiesWholeContext('FROM node\nADD . .')).toBe(true);
    expect(copiesWholeContext('FROM node\ncopy . .')).toBe(true);
    expect(copiesWholeContext('FROM node\n  COPY . .  ')).toBe(true);
  });

  it('does NOT flag a Dockerfile that copies only named subtrees', () => {
    expect(copiesWholeContext('FROM node\nCOPY package.json .\nCOPY packages ./packages')).toBe(
      false,
    );
    expect(copiesWholeContext('FROM node\nRUN echo "COPY . ."')).toBe(false);
  });

  it('every known whole-context Dockerfile really does copy its whole context', () => {
    // Keeps the list honest in the other direction: if one of these stops copying everything, the
    // gate should be told, not left asserting something that is no longer true.
    for (const rel of KNOWN_WHOLE_CONTEXT) {
      expect(copiesWholeContext(readFileSync(join(repoRoot, rel), 'utf8')), rel).toBe(true);
    }
  });
});
