import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SITE_ONE_LINER,
  SITE_ORIGIN,
  SITE_TAGLINE,
  SITE_TITLE,
  absoluteUrl,
  pageMeta,
  pageTitle,
} from './siteMeta';

const brandMd = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/design/brand.md'),
  'utf8',
);

describe('siteMeta', () => {
  it('title is the lowercase product name', () => {
    expect(SITE_TITLE).toBe('musterd');
  });

  it('tagline and one-liner are brand.md §1 verbatim', () => {
    expect(brandMd).toContain(`_"${SITE_TAGLINE}"_`);
    expect(brandMd).toContain(`_"${SITE_ONE_LINER}"_`);
  });

  it('absoluteUrl prefixes the public origin', () => {
    expect(SITE_ORIGIN).toBe('https://musterd.io');
    expect(absoluteUrl('/assets/social-card.png')).toBe(
      'https://musterd.io/assets/social-card.png',
    );
    expect(absoluteUrl('https://musterd.io/already')).toBe('https://musterd.io/already');
  });
});

describe('pageTitle', () => {
  it('suffixes the product name', () => {
    expect(pageTitle('Concepts')).toBe('Concepts — musterd');
  });

  it('does not stutter when the title already names the product', () => {
    // Live on 2026-08-21: the launch post rendered
    // "musterd: muster your agents and humans into persistent teams — musterd".
    expect(pageTitle('musterd: muster your agents and humans into persistent teams')).toBe(
      'musterd: muster your agents and humans into persistent teams',
    );
  });
});

describe('pageMeta', () => {
  const meta = pageMeta({ title: 'Concepts', description: 'The vocabulary.', path: '/docs/concepts' });
  const find = (key: string) =>
    meta.find((m) => 'property' in m && m.property === key) ??
    meta.find((m) => 'name' in m && m.name === key);

  it('carries the page own title, description and canonical url', () => {
    expect(meta.find((m) => 'title' in m)).toEqual({ title: 'Concepts — musterd' });
    expect(find('description')).toEqual({ name: 'description', content: 'The vocabulary.' });
    expect(find('og:title')).toEqual({ property: 'og:title', content: 'Concepts — musterd' });
    expect(find('og:description')).toEqual({
      property: 'og:description',
      content: 'The vocabulary.',
    });
  });

  it('og:url is the PAGE, never the origin — a shared link must not advertise the homepage', () => {
    expect(find('og:url')).toEqual({
      property: 'og:url',
      content: 'https://musterd.io/docs/concepts',
    });
  });
});
