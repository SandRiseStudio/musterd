import { describe, expect, it } from 'vitest';
import {
  declaredMotionTokens,
  disagreeingTokens,
  durationMs,
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

  // ryder's REQUIRED 1 on #1079: LITERAL matched only `\d+ms`, so a duration written in SECONDS
  // was invisible and three real violations passed a green gate on main — including
  // `all 0.18s` (180ms = 4.5 frames), which is precisely rule 3's defect class.
  it('flags a duration written in seconds — the unit is not the point, the number is', () => {
    expect(rawMotionLiterals('.a { transition: all 0.18s ease; }')).toEqual([
      { kind: 'raw', line: 1, detail: '0.18s' },
    ]);
  });

  it('flags a whole-second duration', () => {
    expect(rawMotionLiterals('.a { transition: width 1s linear; }')).toEqual([
      { kind: 'raw', line: 1, detail: '1s' },
    ]);
  });

  it('still exempts an ambient loop written in seconds', () => {
    expect(rawMotionLiterals('.a { animation: drift 2.4s ease-in-out infinite; }')).toEqual([]);
  });

  // stanley's finding: the `infinite` exemption applied to the WHOLE declaration, so a
  // comma-separated shorthand mixing an ambient loop with a finite animation smuggled the finite
  // one past the gate.
  it('exempts only the infinite animation in a comma-separated shorthand, not its finite sibling', () => {
    const css = '.a { animation: sheen 3s linear infinite, card-in 200ms ease; }';
    expect(rawMotionLiterals(css)).toEqual([{ kind: 'raw', line: 1, detail: '200ms' }]);
  });

  // ryder's non-blocking (a): longhands never opened a declaration, so the standing falsifier's
  // promise ("a reintroduced bare 240ms fails CI") was false for `transition-duration: 240ms`.
  it('sees duration longhands, which never used to open a declaration', () => {
    expect(rawMotionLiterals('.a { transition-duration: 240ms; }')).toEqual([
      { kind: 'raw', line: 1, detail: '240ms' },
    ]);
    expect(rawMotionLiterals('.a { animation-duration: 3.6s; }')).toEqual([
      { kind: 'raw', line: 1, detail: '3.6s' },
    ]);
  });

  // A delay is not a duration: it shifts WHEN motion starts, so the whole-frame rule does not
  // apply to it. This is ryder's REQUIRED 2 encoded as a test so the distinction cannot rot.
  it('never flags a delay — a delay is not motion', () => {
    expect(rawMotionLiterals('.a { transition-delay: calc(90ms + var(--i, 0) * 50ms); }')).toEqual(
      [],
    );
    expect(rawMotionLiterals('.a { animation-delay: calc(min(var(--i, 0), 8) * 45ms); }')).toEqual(
      [],
    );
  });

  // ryder's non-blocking (c): the declaration used to close on the first `;` on its opening line.
  it('assembles a transition whose OPENING line already carries a semicolon', () => {
    // The declaration used to close on the first `;` seen on the opening line — which here is the
    // `color: red;` *before* `transition:`, so every continuation line was dropped.
    const css = ['.a { color: red; transition:', '    opacity 240ms ease;', '}'].join('\n');
    expect(rawMotionLiterals(css)).toEqual([{ kind: 'raw', line: 2, detail: '240ms' }]);
  });

  // ryder's non-blocking (a) on #1082, both rounds. Round one: the allowlist matched value +
  // filename, so `1s` was exempt ANYWHERE in ApprovalCard.css. Round two: it matched the site as a
  // bare substring of `property:segment`, so `max-width` inherited `width`'s exemption — and the
  // test below ("elsewhere in the same file") changed selector AND property at once, so it passed
  // identically whether the binding was by site or by property. It could not tell them apart, which
  // is the same defect as a falsifier written in the class the code already handles.
  //
  // Each case below varies exactly ONE coordinate from the exempt declaration.
  describe('the §5 allowlist binds to the declaration that earned it', () => {
    const exempt = '.bar { transition: width 1s linear; }';

    it('exempts the entry at its own site', () => {
      expect(rawMotionLiterals(exempt, 'ApprovalCard.css')).toEqual([]);
    });

    it('vary the FILE only — not exempt', () => {
      expect(rawMotionLiterals(exempt, 'Live.css')).toEqual([
        { kind: 'raw', line: 1, detail: '1s' },
      ]);
    });

    it('vary the ANIMATED PROPERTY only — not exempt', () => {
      expect(
        rawMotionLiterals('.bar { transition: opacity 1s linear; }', 'ApprovalCard.css'),
      ).toEqual([{ kind: 'raw', line: 1, detail: '1s' }]);
    });

    it('vary the CSS PROPERTY only — not exempt', () => {
      expect(rawMotionLiterals('.bar { animation: width 1s linear; }', 'ApprovalCard.css')).toEqual(
        [{ kind: 'raw', line: 1, detail: '1s' }],
      );
    });

    it('vary the SELECTOR only — still exempt, because the entry names a declaration not a rule', () => {
      expect(
        rawMotionLiterals('.somewhere-else { transition: width 1s linear; }', 'ApprovalCard.css'),
      ).toEqual([]);
    });

    // A bare `includes()` let one property inherit another's exemption.
    it('does NOT let max-width inherit width’s exemption', () => {
      expect(
        rawMotionLiterals('.bar { transition: max-width 1s linear; }', 'ApprovalCard.css'),
      ).toEqual([{ kind: 'raw', line: 1, detail: '1s' }]);
    });
  });
});

describe('offFrameDurations', () => {
  it('flags a duration that is not a whole frame at 25fps', () => {
    expect(offFrameDurations(':root { --lc-dur-x: 220ms; }')).toEqual([
      {
        kind: 'off-frame',
        line: 1,
        detail:
          // 5.5 frames sits exactly between two boundaries; Math.round takes the upper one.
          '--lc-dur-x: 220ms is 5.5 frames at 25fps (off by 20ms — nearest whole frame is 240ms)',
      },
    ]);
  });

  it('never rounds the fraction away — a near-miss must not read as a whole frame count', () => {
    const [finding] = offFrameDurations(':root { --lc-dur-x: 281ms; }');
    expect(finding?.detail).toContain('7.03 frames');
    expect(finding?.detail).not.toMatch(/\bis 7 frames\b/);
  });

  it('accepts a whole-frame duration', () => {
    expect(offFrameDurations(':root { --lc-dur-2: 200ms; }')).toEqual([]);
  });

  // ryder's REQUIRED 1 on #1082. Rule 3 parsed /^(\d+)ms$/ and skipped everything else, so a rung
  // declared in seconds was never counted in frames — and no other rule covered it (rule 2 doesn't
  // scan :root, rule 1 only knows tokens already in motion.ts). This is his exact falsifier.
  it('counts frames in a rung declared in SECONDS — the whole rule was ms-only', () => {
    const [finding] = offFrameDurations(':root { --lc-dur-6: 0.18s; }');
    expect(finding?.kind).toBe('off-frame');
    expect(finding?.detail).toContain('4.5 frames');
  });

  it.each([
    ['0.2s', 5],
    ['.28s', 7],
    ['0.6s', 15],
  ])('accepts %s — a whole %i frames spelled in seconds', (value) => {
    expect(offFrameDurations(`:root { --lc-dur-x: ${value}; }`)).toEqual([]);
  });

  // 0.18 * 1000 is 180.00000000000003 in IEEE754. A gate reporting "180.00000000000003ms is
  // 4.500000000000001 frames" has found the right defect and made itself impossible to trust.
  it('reports a seconds value without float noise, and in ms whatever unit it was written in', () => {
    const [finding] = offFrameDurations(':root { --lc-dur-6: 0.18s; }');
    expect(finding?.detail).toBe(
      '--lc-dur-6: 180ms is 4.5 frames at 25fps (off by 20ms — nearest whole frame is 200ms)',
    );
  });

  it('ignores an easing token — beziers are rule 1’s business, not rule 3’s', () => {
    expect(offFrameDurations(':root { --lc-ease-out: cubic-bezier(0.16, 1, 0.3, 1); }')).toEqual(
      [],
    );
  });

  // ryder's SECOND REQUIRED on #1082. The rule `continue`d on anything it could not parse, so the
  // parser's blind spots became the gate's blind spots SILENTLY. At 9e0ddf90 each of these left
  // tokens:check green, and every one of them is 4.5 frames — a new rung at rule 3's own defect
  // class, which is the exact sentence the previous round was supposed to have retired.
  describe('fails CLOSED — an unreadable rung is a finding, not a skip', () => {
    // The case fix is real: CSS units are case-insensitive, so these are genuinely 180ms.
    it.each(['0.18S', '180MS', '0.18s'])('%s is read as 180ms and flagged off-frame', (value) => {
      const [finding] = offFrameDurations(`:root { --lc-dur-6: ${value}; }`);
      expect(finding?.kind).toBe('off-frame');
      expect(finding?.detail).toContain('4.5 frames');
    });

    // These are NOT parsed, on purpose. Widening the regex is the move that failed twice; the
    // third failure would be a form neither of us listed. Reported instead of read.
    it.each(['+0.18s', '1.8e-1s', 'var(--lc-dur-2)', 'calc(200ms * 0.9)', '200'])(
      '%s is reported as unreadable rather than skipped',
      (value) => {
        const [finding] = offFrameDurations(`:root { --lc-dur-6: ${value}; }`);
        expect(finding?.kind).toBe('unreadable');
        expect(finding?.detail).toContain(value);
      },
    );

    it('stays quiet about an unreadable EASING value — only rungs carry frame counts', () => {
      expect(offFrameDurations(':root { --lc-ease-x: var(--something); }')).toEqual([]);
    });

    // The general property, stated without reference to any listed form: whatever a rung holds,
    // the gate either counts its frames or says it could not. It never does neither.
    it.each(['200ms', '0.2s', '0.18s', '+0.18s', '1.8e-1s', 'nonsense', ''])(
      'a rung holding %s is either counted or reported — never silently passed over',
      (value) => {
        const css = `:root { --lc-dur-6: ${value}; }`;
        const readable = durationMs(value) !== null;
        const findings = offFrameDurations(css);
        if (readable) {
          expect(findings.every((f) => f.kind === 'off-frame')).toBe(true);
        } else {
          expect(findings.map((f) => f.kind)).toEqual(['unreadable']);
        }
      },
    );
  });
});

describe('durationMs', () => {
  it.each([
    ['200ms', 200],
    ['0.18s', 180],
    ['.28s', 280],
    ['1s', 1000],
    ['0s', 0],
  ])('parses %s to %i ms', (value, ms) => {
    expect(durationMs(value)).toBe(ms);
  });

  it('matches the unit case-insensitively, because CSS units are', () => {
    expect(durationMs('0.18S')).toBe(180);
    expect(durationMs('180MS')).toBe(180);
    expect(durationMs('180Ms')).toBe(180);
  });

  it.each([
    'cubic-bezier(0.16, 1, 0.3, 1)',
    'ease',
    '200',
    '200px',
    'var(--lc-dur-2)',
    '',
    // Valid CSS number forms, deliberately NOT accepted — offFrameDurations reports what it
    // cannot read, so the class closes by construction instead of by growing this pattern.
    '+0.18s',
    '-0.18s',
    '1.8e-1s',
    'calc(200ms * 0.9)',
  ])('returns null for %s', (value) => {
    expect(durationMs(value)).toBeNull();
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
