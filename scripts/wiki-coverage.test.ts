import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  coverageFailures,
  extractClaims,
  measureCoverage,
  stripDatedParen,
} from './wiki-coverage.ts';

const dirs: string[] = [];
function fixture(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-coverage-test-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(pages)) writeFileSync(join(dir, name), body);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* The corpus is every non-fenced line carrying BOTH a date and a falsifier — the lines whose
 * authors followed README rule 2, i.e. the wiki's self-labeled claim population. */
describe('extractClaims', () => {
  it('finds a dated falsify body line, with file, 1-indexed line, and heading:false', () => {
    const dir = fixture({
      'a.md': '# A\n\nSummary.\n\nThe relay drops frames (2026-08-01; falsify: tail it).\n',
    });
    expect(extractClaims(dir)).toEqual([
      {
        file: 'a.md',
        line: 5,
        text: 'The relay drops frames (2026-08-01; falsify: tail it).',
        heading: false,
      },
    ]);
  });

  it('marks a claim living in a heading line as heading:true', () => {
    const dir = fixture({
      'a.md':
        '# A\n\nSummary.\n\n## The tail buffers silently (2026-08-06; falsify: pipe it)\n\nBody.\n',
    });
    const claims = extractClaims(dir);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ line: 5, heading: true });
  });

  it('skips fenced lines, undated falsify lines, dated non-falsify lines, and INDEX.md', () => {
    const dir = fixture({
      'a.md':
        '# A\n\nSummary.\n\n```\nfenced (2026-08-01; falsify: nope)\n```\n\nno date here (falsify: nope).\n\ndated but no falsifier (2026-08-01).\n',
      'INDEX.md': 'indexed (2026-08-01; falsify: nope)\n',
    });
    expect(extractClaims(dir)).toEqual([]);
  });
});

describe('stripDatedParen', () => {
  it('removes a dated parenthetical, falsifier and all', () => {
    expect(stripDatedParen('The relay drops frames (2026-08-01; falsify: tail it).')).toBe(
      'The relay drops frames .',
    );
  });

  it('handles nested parens inside the dated group', () => {
    expect(stripDatedParen('x (2026-08-01; falsify: run f(y) twice) y')).toBe('x  y');
  });

  it('truncates to end of line when the dated paren never closes', () => {
    expect(stripDatedParen('x (2026-08-01; falsify: never closed')).toBe('x ');
  });

  it('leaves undated parentheticals alone', () => {
    expect(stripDatedParen('the flag (see ADR 12) is read')).toBe('the flag (see ADR 12) is read');
  });
});

describe('measureCoverage', () => {
  const claim = (text: string, heading = false) => ({ file: 'a.md', line: 5, text, heading });

  it('counts a body defect claim in an enforced shape as covered', () => {
    const c = claim('The daemon never fires (2026-08-01; falsify: watch it).');
    const cov = measureCoverage([c], { [c.text]: 'defect' });
    expect(cov).toMatchObject({ defects: 1, covered: 1, shapeMisses: [], headingMisses: [] });
  });

  it('counts a body defect claim in an unknown shape as a shape miss', () => {
    const c = claim('The queue quietly starves its consumer (2026-08-01; falsify: feed it).');
    const cov = measureCoverage([c], { [c.text]: 'defect' });
    expect(cov.covered).toBe(0);
    expect(cov.shapeMisses).toEqual([c]);
  });

  it('counts a heading defect claim as a heading miss even when the shape is enforced', () => {
    const c = claim('## The daemon never fires (2026-08-01; falsify: watch it)', true);
    const cov = measureCoverage([c], { [c.text]: 'defect' });
    expect(cov.covered).toBe(0);
    expect(cov.headingMisses).toEqual([c]);
  });

  it('gives no credit for defect vocabulary that lives only in the falsifier text', () => {
    const c = claim('The flag is stale (2026-08-01; falsify: check it never fires).');
    const cov = measureCoverage([c], { [c.text]: 'defect' });
    expect(cov.covered).toBe(0);
    expect(cov.shapeMisses).toEqual([c]);
  });

  it("excludes 'other'-labeled lines from the denominator entirely", () => {
    const c = claim('Measured settle time is 22s (2026-08-01; falsify: rerun the sweep).');
    const cov = measureCoverage([c], { [c.text]: 'other' });
    expect(cov).toMatchObject({ defects: 0, covered: 0, shapeMisses: [], headingMisses: [] });
  });

  it('reports unlabeled claims and stale labels', () => {
    const c = claim('The relay drops frames (2026-08-01; falsify: tail it).');
    const cov = measureCoverage([c], { 'gone claim (2026-01-01; falsify: x).': 'defect' });
    expect(cov.unlabeled).toEqual([c]);
    expect(cov.staleLabels).toEqual(['gone claim (2026-01-01; falsify: x).']);
  });
});

describe('coverageFailures', () => {
  it('fails an unlabeled claim naming file, line, and the labels file', () => {
    const dir = fixture({
      'a.md': '# A\n\nSummary.\n\nThe relay drops frames (2026-08-01; falsify: tail it).\n',
    });
    const failures = coverageFailures(dir, {});
    expect(failures.join('\n')).toMatch(/a\.md:5.*wiki-claim-labels\.json/);
  });

  it('fails a stale label so the labels file cannot accumulate junk', () => {
    const dir = fixture({ 'a.md': '# A\n\nSummary.\n' });
    const failures = coverageFailures(dir, { 'gone (2026-01-01; falsify: x).': 'defect' });
    expect(failures.join('\n')).toMatch(/stale label/);
  });

  it('is silent when every claim is labeled and no label is stale', () => {
    const dir = fixture({
      'a.md': '# A\n\nSummary.\n\nThe daemon never fires (2026-08-01; falsify: watch it).\n',
    });
    expect(
      coverageFailures(dir, {
        'The daemon never fires (2026-08-01; falsify: watch it).': 'defect',
      }),
    ).toEqual([]);
  });
});
