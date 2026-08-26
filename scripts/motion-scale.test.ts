import { describe, expect, it } from 'vitest';
import {
  declaredMotionTokens,
  disagreeingTokens,
  offFrameDurations,
  phantomMotionRefs,
  rawMotionLiterals,
  rungsWithoutReducedAnswer,
} from './motion-scale.ts';

describe('declaredMotionTokens', () => {
  it('reads duration and easing custom properties with their line numbers', () => {
    const css = [
      ':root {',
      '  --lc-dur-2: 200ms;',
      '  --lc-ease-out: cubic-bezier(0.16, 1, 0.3, 1);',
      '}',
    ].join('\n');
    expect(declaredMotionTokens(css)).toEqual([
      { token: '--lc-dur-2', value: '200ms', line: 2 },
      { token: '--lc-ease-out', value: 'cubic-bezier(0.16, 1, 0.3, 1)', line: 3 },
    ]);
  });

  it('ignores non-motion custom properties', () => {
    expect(declaredMotionTokens(':root { --lc-r-sm: 6px; --lc-z-rail: 1; }')).toEqual([]);
  });
});

describe('rawMotionLiterals', () => {
  it('flags an inline cubic-bezier in a transition', () => {
    const css = '.a { transition: opacity 200ms cubic-bezier(0.22, 1, 0.36, 1); }';
    expect(rawMotionLiterals(css)).toContainEqual({
      kind: 'raw',
      line: 1,
      detail: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
  });

  it('flags a bare ms literal in a transition', () => {
    expect(rawMotionLiterals('.a { transition: opacity 240ms var(--lc-ease-out); }')).toEqual([
      { kind: 'raw', line: 1, detail: '240ms' },
    ]);
  });

  it('does not flag the :root declarations themselves — that is where values are allowed to live', () => {
    expect(rawMotionLiterals(':root { --lc-dur-2: 200ms; }')).toEqual([]);
  });

  it('does not flag an infinite animation — ambient loops are exempt by rule (spec §5)', () => {
    expect(rawMotionLiterals('.a { animation: drift 2.4s ease-in-out infinite; }')).toEqual([]);
  });

  it('sees a multi-line transition block — the shape Live.css actually uses', () => {
    const css = [
      '.a {',
      '  transition:',
      '    opacity 240ms cubic-bezier(0.22, 1, 0.36, 1),',
      '    transform 380ms var(--lc-ease-out);',
      '}',
    ].join('\n');
    const found = rawMotionLiterals(css);
    expect(found.map((f) => f.detail).sort()).toEqual(
      ['240ms', '380ms', 'cubic-bezier(0.22, 1, 0.36, 1)'].sort(),
    );
  });
});

describe('offFrameDurations', () => {
  it('flags a duration that is not a whole frame at 25fps', () => {
    expect(offFrameDurations(':root { --lc-dur-x: 220ms; }')).toEqual([
      { kind: 'off-frame', line: 1, detail: '--lc-dur-x: 220ms is 5.5 frames at 25fps' },
    ]);
  });

  it('accepts a whole-frame duration', () => {
    expect(offFrameDurations(':root { --lc-dur-2: 200ms; }')).toEqual([]);
  });
});

describe('disagreeingTokens', () => {
  it('flags a CSS mirror that drifted from the TS source', () => {
    const expected = new Map([['--lc-dur-2', '200ms']]);
    expect(disagreeingTokens(':root { --lc-dur-2: 240ms; }', expected)).toEqual([
      { kind: 'disagree', line: 1, detail: '--lc-dur-2: CSS has 240ms, motion.ts has 200ms' },
    ]);
  });

  it('accepts a faithful mirror regardless of whitespace', () => {
    const expected = new Map([['--lc-ease-out', 'cubic-bezier(0.16, 1, 0.3, 1)']]);
    expect(
      disagreeingTokens(':root { --lc-ease-out: cubic-bezier(0.16,1,0.3,1); }', expected),
    ).toEqual([]);
  });
});

describe('phantomMotionRefs', () => {
  const known = new Set(['--lc-dur-1', '--lc-ease-out']);

  it('flags a motion var() that no stylesheet declares — a silently dead transition', () => {
    // The real case: Task 4 deleted --lc-fast, and ApprovalCard.css still pointed at it. A
    // transition whose duration does not resolve simply does not animate, and nothing says so.
    const css = '.a { transition: color var(--lc-fast) var(--lc-ease-out); }';
    expect(phantomMotionRefs(css, known)).toEqual([
      {
        kind: 'phantom',
        line: 1,
        detail: 'var(--lc-fast) is used in a transition but declared nowhere',
      },
    ]);
  });

  it('accepts references to declared tokens', () => {
    expect(
      phantomMotionRefs('.a { transition: color var(--lc-dur-1) var(--lc-ease-out); }', known),
    ).toEqual([]);
  });

  it('ignores non-motion custom properties it knows nothing about', () => {
    expect(
      phantomMotionRefs('.a { transition: color var(--lc-dur-1) var(--x-other); }', known),
    ).toEqual([]);
  });
});

describe('rungsWithoutReducedAnswer', () => {
  it('flags a rung used in a transition that no reduced-motion block answers', () => {
    const css = '.a { transition: opacity var(--lc-dur-2) var(--lc-ease-out); }';
    expect(rungsWithoutReducedAnswer(css)).toEqual(['--lc-dur-2']);
  });

  it('accepts a rung the reduced block neutralises', () => {
    const css = [
      '.a { transition: opacity var(--lc-dur-2) var(--lc-ease-out); }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .a { transition-duration: 0s; }',
      '}',
    ].join('\n');
    expect(rungsWithoutReducedAnswer(css)).toEqual([]);
  });

  it('says nothing about a stylesheet that animates nothing', () => {
    expect(rungsWithoutReducedAnswer('.a { color: red; }')).toEqual([]);
  });

  it('ignores ambient loops — they are exempt from the scale and from this rule', () => {
    expect(
      rungsWithoutReducedAnswer('.a { animation: drift var(--lc-dur-5) linear infinite; }'),
    ).toEqual([]);
  });
});
