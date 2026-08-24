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

describe('renderPage — wide content scrolls in its own box', () => {
  const TABLE_MD = '# T\n\n| act | meaning |\n| --- | --- |\n| handoff | pass work |\n';

  it('wraps a table in a scroll region, so a phone scrolls the table and not the page', () => {
    const { html } = renderPage(TABLE_MD);
    expect(html).toContain('<div class="prose__scroll"');
    expect(html.indexOf('<div class="prose__scroll"')).toBeLessThan(html.indexOf('<table>'));
    expect(html).toContain('</table></div>');
  });

  it('makes that region keyboard-reachable, because a scroll box with no focus is a WCAG trap', () => {
    const { html } = renderPage(TABLE_MD);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
  });

  it('leaves the table element itself intact, so it keeps its table semantics', () => {
    const { html } = renderPage(TABLE_MD);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>act</th>');
    expect(html).not.toContain('display:block');
  });

  it('leaves a page with no table untouched', () => {
    const { html } = renderPage('# T\n\nJust a paragraph.');
    expect(html).not.toContain('prose__scroll');
  });
});

describe('renderRoadmap', () => {
  it('emits one section per status, in STATUS_ORDER, each with items', () => {
    const sections = renderRoadmap();
    expect(sections.map((s) => s.status)).toEqual(['shipped', 'near-term', 'reserved', 'out-of-scope']);
    for (const s of sections) expect(s.html).toContain('<li');
  });
});
