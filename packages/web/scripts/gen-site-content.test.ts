import { describe, expect, it } from 'vitest';
import { parsePostFilename, renderPage, renderRoadmap } from './gen-site-content';

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

describe('renderRoadmap', () => {
  it('emits one section per status, in STATUS_ORDER, each with items', () => {
    const sections = renderRoadmap();
    expect(sections.map((s) => s.status)).toEqual(['shipped', 'near-term', 'reserved', 'out-of-scope']);
    for (const s of sections) expect(s.html).toContain('<li');
  });
});
