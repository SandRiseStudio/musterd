import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_ID,
  SITE_INSTALL_COMMAND,
  SITE_ONE_LINER,
  SITE_ORIGIN,
  SITE_TAGLINE,
  SITE_TITLE,
  absoluteUrl,
  breadcrumbNode,
  itemListNode,
  organizationNode,
  pageHead,
  pageMeta,
  pageTitle,
  softwareApplicationNode,
  webSiteNode,
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

describe('pageMeta share metadata', () => {
  const meta = pageMeta({ title: 'Concepts', description: 'The vocabulary.', path: '/docs/concepts' });
  const find = (key: string) =>
    meta.find((m) => 'property' in m && m.property === key) ??
    meta.find((m) => 'name' in m && m.name === key);

  it('states the indexing directives rather than inheriting them', () => {
    // index/follow is the default; the image and snippet caps are not, and a share card this wide
    // renders as a thumbnail without max-image-preview:large.
    expect(find('robots')).toEqual({
      name: 'robots',
      content: 'index, follow, max-image-preview:large, max-snippet:-1',
    });
  });

  it('names the site and locale, and the twitter pair that does not fall back to og:*', () => {
    expect(find('og:site_name')).toEqual({ property: 'og:site_name', content: 'musterd' });
    expect(find('og:locale')).toEqual({ property: 'og:locale', content: 'en_US' });
    expect(find('twitter:title')).toEqual({ name: 'twitter:title', content: 'Concepts — musterd' });
    expect(find('twitter:description')).toEqual({
      name: 'twitter:description',
      content: 'The vocabulary.',
    });
  });

  it('is a website unless the page says otherwise', () => {
    expect(find('og:type')).toEqual({ property: 'og:type', content: 'website' });
    const post = pageMeta({ title: 'Post', description: 'A post.', path: '/blog/p', ogType: 'article' });
    expect(post.find((m) => 'property' in m && m.property === 'og:type')).toEqual({
      property: 'og:type',
      content: 'article',
    });
  });

  it('emits no ld+json entry when a page passes no graph', () => {
    expect(meta.some((m) => 'script:ld+json' in m)).toBe(false);
  });
});

/*
 * Measured on production 2026-09-01: NO page on musterd.io carried <link rel="canonical">, while
 * every page carried og:url. The meta half had a helper and the link half did not. These assert
 * the pair that replaced them, so the two cannot come apart again.
 */
describe('pageHead', () => {
  const head = pageHead({
    title: 'Concepts',
    description: 'The vocabulary.',
    path: '/docs/concepts',
    graph: [{ '@type': 'TechArticle' }],
  });

  it('always carries the page canonical link', () => {
    expect(head.links[0]).toEqual({
      rel: 'canonical',
      href: 'https://musterd.io/docs/concepts',
    });
  });

  it('appends a page own links rather than letting them replace the canonical', () => {
    const withPreconnect = pageHead({
      title: 'musterd',
      description: 'Home.',
      path: '/',
      links: [{ rel: 'preconnect', href: 'https://player.twitch.tv' }],
    });
    expect(withPreconnect.links).toEqual([
      { rel: 'canonical', href: 'https://musterd.io/' },
      { rel: 'preconnect', href: 'https://player.twitch.tv' },
    ]);
  });

  it('renders the graph as one ld+json script entry', () => {
    const ld = head.meta.find((m) => 'script:ld+json' in m) as
      | { 'script:ld+json': { '@context': string; '@graph': unknown[] } }
      | undefined;
    expect(ld?.['script:ld+json']['@context']).toBe('https://schema.org');
    expect(ld?.['script:ld+json']['@graph']).toEqual([{ '@type': 'TechArticle' }]);
  });
});

describe('structured data nodes', () => {
  it('musterd is the publisher and SandRise Studio is only its parent', () => {
    const org = organizationNode();
    expect(org.name).toBe('musterd');
    // docs/wiki/positioning.md: the studio is the maker, never the product brand. Naming it as the
    // Organization here would hand every answer engine the wrong brand for the product.
    expect(org.parentOrganization).toEqual({
      '@type': 'Organization',
      name: 'SandRise Studio',
      url: 'https://github.com/SandRiseStudio',
    });
  });

  it('the app node states it is free and how to install it', () => {
    const app = softwareApplicationNode();
    expect(app.applicationCategory).toBe('DeveloperApplication');
    expect(app.offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'USD' });
    expect(app.disambiguatingDescription).toContain(SITE_INSTALL_COMMAND);
    expect(app.publisher).toEqual({ '@id': GRAPH_ID.organization });
  });

  it('the site-wide nodes are addressable, so pages reference instead of restating', () => {
    expect(organizationNode()['@id']).toBe(GRAPH_ID.organization);
    expect(webSiteNode()['@id']).toBe(GRAPH_ID.website);
    expect(softwareApplicationNode()['@id']).toBe(GRAPH_ID.software);
    expect(webSiteNode().publisher).toEqual({ '@id': GRAPH_ID.organization });
    expect(GRAPH_ID.organization.startsWith(SITE_ORIGIN)).toBe(true);
  });

  it('declares no Person and no FAQPage', () => {
    // musterd is a product, not a portfolio piece, and the site has no question-and-answer copy —
    // a fabricated FAQPage is a structured-data violation, not a shortcut to a richer result.
    const json = JSON.stringify([organizationNode(), webSiteNode(), softwareApplicationNode()]);
    expect(json).not.toContain('"Person"');
    expect(json).not.toContain('FAQPage');
  });

  it('breadcrumbs start at home and number from one', () => {
    expect(breadcrumbNode([{ name: 'Docs', path: '/docs' }])).toEqual({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'musterd', item: 'https://musterd.io/' },
        { '@type': 'ListItem', position: 2, name: 'Docs', item: 'https://musterd.io/docs' },
      ],
    });
  });

  it('item lists carry a url only where there is one to give', () => {
    expect(itemListNode([{ name: 'Shipped' }, { name: 'Concepts', path: '/docs/concepts' }])).toEqual({
      '@type': 'ItemList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Shipped' },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'Concepts',
          url: 'https://musterd.io/docs/concepts',
        },
      ],
    });
  });

  it('the graph description is brand copy, not a second one-liner', () => {
    expect(webSiteNode().description).toBe(SITE_ONE_LINER);
    expect(organizationNode().description).toBe(SITE_TAGLINE);
    expect(SITE_TITLE).toBe('musterd');
  });
});
