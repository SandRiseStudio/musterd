import { describe, expect, it } from 'vitest';
import { setColorEnabled, theme } from './theme.js';
import {
  defList,
  defRow,
  hint,
  padEndVisible,
  success,
  sym,
  termWidth,
  visibleLen,
  wrapText,
} from './ui.js';

// Color is pinned OFF via NO_COLOR in vitest.config, so every assertion here is on visible text.

describe('termWidth', () => {
  it('falls back to 80 when stdout has no columns (non-TTY / piped / test)', () => {
    // Under `pool: 'forks'` process.stdout.columns is undefined.
    expect(process.stdout.columns).toBeUndefined();
    expect(termWidth()).toBe(80);
  });

  it('clamps to the [40, max] range', () => {
    const orig = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    try {
      Object.defineProperty(process.stdout, 'columns', { value: 500, configurable: true });
      expect(termWidth(100)).toBe(100);
      Object.defineProperty(process.stdout, 'columns', { value: 10, configurable: true });
      expect(termWidth()).toBe(40);
      Object.defineProperty(process.stdout, 'columns', { value: 72, configurable: true });
      expect(termWidth()).toBe(72);
    } finally {
      if (orig) Object.defineProperty(process.stdout, 'columns', orig);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });
});

describe('visibleLen / padEndVisible', () => {
  it('counts characters ignoring ANSI escapes', () => {
    // Force a colorized string regardless of the NO_COLOR default, to prove the strip works.
    const colored = '\x1b[33mhi\x1b[39m';
    expect(visibleLen(colored)).toBe(2);
    expect(visibleLen('plain')).toBe(5);
  });

  it('pads to the target visible width with ≥1 trailing space', () => {
    expect(padEndVisible('ab', 5)).toBe('ab   ');
    // Already at/over width still gets one trailing space.
    expect(padEndVisible('abcde', 5)).toBe('abcde ');
    // Padding is by visible length, so a colored term aligns like its plain form.
    const colored = '\x1b[33mab\x1b[39m';
    expect(visibleLen(padEndVisible(colored, 5))).toBe(5);
  });
});

describe('wrapText', () => {
  it('greedy-wraps and never loses words', () => {
    const lines = wrapText('one two three four', 8);
    expect(lines.every((l) => l.length <= 8)).toBe(true);
    expect(lines.join(' ')).toBe('one two three four');
  });

  it('returns [""] for empty input', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });
});

describe('defList alignment', () => {
  it('starts every description at one shared column regardless of term width', () => {
    const out = defList([
      { term: 'a', desc: 'short one' },
      { term: 'longername', desc: 'another' },
    ]);
    const lines = out.split('\n');
    // Column where the description begins = index of its first non-space char, and it must match.
    const descCol = (line: string) => line.length - line.trimStart().length;
    // Find where 'short one' and 'another' start.
    const col0 = lines[0]!.indexOf('short one');
    const col1 = lines[1]!.indexOf('another');
    expect(col0).toBe(col1);
    expect(col0).toBeGreaterThan('longername'.length); // padded past the widest term
    expect(descCol).toBeTruthy();
  });

  it('wraps long descriptions with a hanging indent to the same column', () => {
    const long = 'word '.repeat(40).trim();
    const out = defRow({ term: 'cmd', desc: long }, 8, { width: 40 });
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // Continuation lines are indented to the gap column.
    expect(lines[1]!.startsWith(' '.repeat(8))).toBe(true);
  });
});

describe('success', () => {
  it('prints a ✓ and an optional next hint', () => {
    expect(success('sent')).toBe(`${sym.ok} sent`);
    const withNext = success('lane opened', { next: 'musterd lanes --mine' });
    expect(withNext).toContain(`${sym.ok} lane opened`);
    expect(withNext).toContain('next: musterd lanes --mine');
  });
});

describe('hint', () => {
  it('prefixes with the arrow glyph', () => {
    expect(hint('do this')).toBe(`${sym.arrow} do this`);
  });
});

describe('setColorEnabled(false)', () => {
  it('makes theme roles emit no ANSI (opt-in; does not fight the global NO_COLOR)', () => {
    setColorEnabled(false);
    expect(theme.accent('x')).toBe('x');
    expect(theme.memberName('lin', 'human')).toBe('lin');
  });
});
