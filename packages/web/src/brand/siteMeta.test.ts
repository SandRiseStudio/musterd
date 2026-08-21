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
