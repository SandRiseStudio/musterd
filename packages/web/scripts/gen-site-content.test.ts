import { describe, expect, it } from 'vitest';
import { excerpt, parsePostFilename, renderPage, renderRoadmap } from './gen-site-content';

describe('parsePostFilename', () => {
  it('extracts date and slug', () =>
    expect(parsePostFilename('2026-08-21-launch.md')).toEqual({ date: '2026-08-21', slug: 'launch' }));
  it('rejects undated files', () => expect(parsePostFilename('notes.md')).toBeNull());
});

describe('renderPage', () => {
  it('lifts the first heading out as the title', () => {
    const { title, html } = renderPage('# Hello\n\nBody **bold**.');
    expect(title).toBe('Hello');
    expect(html).not.toContain('<h1>');
    expect(html).toContain('<strong>bold</strong>');
  });
  it('throws on a page with no heading', () => expect(() => renderPage('no heading')).toThrow());
});

describe('excerpt', () => {
  it('takes the first paragraph as plain text, for the page description', () => {
    expect(excerpt('<p>A <strong>coordination</strong> layer.</p><p>Second.</p>')).toBe(
      'A coordination layer.',
    );
  });

  it('skips HTML comments — the [SLOANE] markers must never become a description', () => {
    expect(excerpt('<!-- [SLOANE] rewrite -->\n<p>Real copy.</p>')).toBe('Real copy.');
  });

  it('truncates on a word boundary so a crawler gets a whole clause', () => {
    const long = '<p>' + 'word '.repeat(60).trim() + '</p>';
    const got = excerpt(long);
    expect(got.length).toBeLessThanOrEqual(160);
    expect(got.endsWith('…')).toBe(true);
    expect(got).not.toMatch(/\s…$/);
  });

  it('decodes the entities marked-up text carries', () => {
    expect(excerpt('<p>agents &amp; humans &mdash; together</p>')).toBe('agents & humans — together');
  });
});

describe('renderRoadmap', () => {
  it('emits one section per status, in STATUS_ORDER, each with items', () => {
    const sections = renderRoadmap();
    expect(sections.map((s) => s.status)).toEqual(['shipped', 'near-term', 'reserved', 'out-of-scope']);
    for (const s of sections) expect(s.html).toContain('<li');
  });
});
