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
 * authors followed README rule 2, i.e. the wiki's self-labeled claim population. Each carries its
 * own label in a trailing `<!-- claim: … -->` marker (ADR-less convention, lane 01M2H121AA): the
 * label travels with the line, so re-wording a claim can no longer orphan it. */
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
        label: null,
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

  it('reads the label off a trailing marker and strips it from the claim text', () => {
    const dir = fixture({
      'a.md':
        '# A\n\nSummary.\n\nThe relay drops frames (2026-08-01; falsify: tail it). <!-- claim: defect -->\n',
    });
    expect(extractClaims(dir)[0]).toMatchObject({
      text: 'The relay drops frames (2026-08-01; falsify: tail it).',
      label: 'defect',
    });
  });

  it('reads a marker on a heading claim too', () => {
    const dir = fixture({
      'a.md':
        '# A\n\nSummary.\n\n## The tail buffers silently (2026-08-06; falsify: pipe it) <!-- claim: other -->\n\nBody.\n',
    });
    expect(extractClaims(dir)[0]).toMatchObject({
      text: '## The tail buffers silently (2026-08-06; falsify: pipe it)',
      heading: true,
      label: 'other',
    });
  });

  /* The regression that would silently move the coverage number: the marker must not be visible to
   * DEFECT_RE or to stripDatedParen, or a labeled line could score differently from the same line
   * unlabeled. */
  it('scores a marked line exactly as the same line unmarked', () => {
    const body = 'The daemon never fires (2026-08-01; falsify: watch it).';
    const marked = fixture({ 'a.md': `# A\n\nSummary.\n\n${body} <!-- claim: defect -->\n` });
    const bare = fixture({ 'a.md': `# A\n\nSummary.\n\n${body}\n` });
    const markedClaim = extractClaims(marked)[0]!;
    const bareClaim = extractClaims(bare)[0]!;
    expect(markedClaim.text).toBe(bareClaim.text);
    expect(measureCoverage([markedClaim])).toMatchObject({ defects: 1, covered: 1 });
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
  const claim = (text: string, label: 'defect' | 'other' | null, heading = false) => ({
    file: 'a.md',
    line: 5,
    text,
    heading,
    label,
  });

  it('counts a body defect claim in an enforced shape as covered', () => {
    const c = claim('The daemon never fires (2026-08-01; falsify: watch it).', 'defect');
    expect(measureCoverage([c])).toMatchObject({
      defects: 1,
      covered: 1,
      shapeMisses: [],
      headingMisses: [],
    });
  });

  it('counts a body defect claim in an unknown shape as a shape miss', () => {
    const c = claim(
      'The queue quietly starves its consumer (2026-08-01; falsify: feed it).',
      'defect',
    );
    const cov = measureCoverage([c]);
    expect(cov.covered).toBe(0);
    expect(cov.shapeMisses).toEqual([c]);
  });

  it('counts a heading defect claim as a heading miss even when the shape is enforced', () => {
    const c = claim('## The daemon never fires (2026-08-01; falsify: watch it)', 'defect', true);
    const cov = measureCoverage([c]);
    expect(cov.covered).toBe(0);
    expect(cov.headingMisses).toEqual([c]);
  });

  it('gives no credit for defect vocabulary that lives only in the falsifier text', () => {
    const c = claim('The flag is stale (2026-08-01; falsify: check it never fires).', 'defect');
    const cov = measureCoverage([c]);
    expect(cov.covered).toBe(0);
    expect(cov.shapeMisses).toEqual([c]);
  });

  it("excludes 'other'-labeled lines from the denominator entirely", () => {
    const c = claim('Measured settle time is 22s (2026-08-01; falsify: rerun the sweep).', 'other');
    expect(measureCoverage([c])).toMatchObject({
      defects: 0,
      covered: 0,
      shapeMisses: [],
      headingMisses: [],
    });
  });

  it('reports an unmarked claim as unlabeled', () => {
    const c = claim('The relay drops frames (2026-08-01; falsify: tail it).', null);
    expect(measureCoverage([c]).unlabeled).toEqual([c]);
  });
});

describe('coverageFailures', () => {
  it('fails an unmarked claim naming file, line, and the marker to add', () => {
    const dir = fixture({
      'a.md': '# A\n\nSummary.\n\nThe relay drops frames (2026-08-01; falsify: tail it).\n',
    });
    expect(coverageFailures(dir).join('\n')).toMatch(/a\.md:5.*<!-- claim: defect -->/);
  });

  /* The replacement for the stale-label gate: a marker on a line that is not a corpus line is junk
   * the same way an orphaned JSON key was, and nothing else would ever look at it. */
  it('fails a marker on a line that is not a claim line', () => {
    const dir = fixture({ 'a.md': '# A\n\nOrdinary prose. <!-- claim: defect -->\n' });
    expect(coverageFailures(dir).join('\n')).toMatch(/a\.md:3.*not a claim line/);
  });

  it('fails a marker whose label is neither defect nor other', () => {
    const dir = fixture({
      'a.md':
        '# A\n\nThe relay drops frames (2026-08-01; falsify: tail it). <!-- claim: maybe -->\n',
    });
    expect(coverageFailures(dir).join('\n')).toMatch(/a\.md:3.*unknown claim label "maybe"/);
  });

  it('ignores a marker inside a fence, which is documentation of the convention', () => {
    const dir = fixture({
      'a.md': '# A\n\n```\nSome claim (2026-08-01; falsify: x). <!-- claim: defect -->\n```\n',
    });
    expect(coverageFailures(dir)).toEqual([]);
  });

  it('is silent when every claim carries a marker', () => {
    const dir = fixture({
      'a.md':
        '# A\n\nSummary.\n\nThe daemon never fires (2026-08-01; falsify: watch it). <!-- claim: defect -->\n',
    });
    expect(coverageFailures(dir)).toEqual([]);
  });
});
