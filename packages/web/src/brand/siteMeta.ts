/**
 * Stranger-facing site identity for musterd.io (and any share card).
 *
 * Copy is brand.md §1 — tagline + one-liner. The retired "musterd — roadmap" title was the
 * page this package used to be; the public origin is the product, not the roadmap.
 */
export const SITE_ORIGIN = 'https://musterd.io';
export const SITE_TITLE = 'musterd';
export const SITE_TAGLINE = 'Muster your agents and humans into persistent teams.';
export const SITE_ONE_LINER =
  'Named, persistent teams of agents and humans — across any harness, framework, model, or surface — with a shared communication protocol.';

/**
 * What a share card leads with. NOT the same job as SITE_ONE_LINER, which is brand.md §1 verbatim
 * (pinned by siteMeta.test.ts) and answers "what category is this" — the right answer in a brand
 * doc and the wrong one to open with, because it describes the shape of the thing rather than what
 * it does for you. The hero stopped leading with it on 2026-08-21 (#989) for exactly that reason,
 * and until this constant existed the landing page's og:description still did — so the page and
 * its own share card disagreed about the opening claim, with the card winning, since it is what a
 * stranger meets first in Slack or on social.
 */
export const SITE_SHARE_DESCRIPTION =
  'Your agents and humans share one roster — names, inboxes and history that outlast the session, and messages that say what they are for.';

/** What the social card actually renders, for readers who get the alt text instead of the image. */
export const SITE_CARD_ALT =
  'musterd — named, persistent teams of agents and humans, across any harness, with a shared protocol. Humans are members, not approvers.';

/**
 * The document title for a page: its own name, suffixed with the product — unless the name
 * already carries it. The launch post shipped as "musterd: … — musterd" on 2026-08-21 because the
 * suffix was unconditional.
 */
export function pageTitle(title: string): string {
  return title.toLowerCase().includes(SITE_TITLE) ? title : `${title} — ${SITE_TITLE}`;
}

export interface PageMeta {
  title: string;
  description: string;
  /** Route path, leading slash, no origin — becomes the page's canonical og:url. */
  path: string;
  /** `article` for a blog post; everything else on this site is a `website`. */
  ogType?: 'website' | 'article';
  /** Structured-data nodes for this page, wrapped as one `@graph`. */
  graph?: JsonLdNode[];
  /**
   * Extra <link> tags this page needs. They are APPENDED to the canonical rather than replacing
   * the list, so a route that wants a preconnect cannot drop its own canonical to get one.
   */
  links?: Record<string, string>[];
}

/**
 * Per-page head metadata. Every public route MUST use this rather than inheriting the root's:
 * measured on production 2026-08-21, every page reported og:title "musterd" and og:url
 * "https://musterd.io", so a shared link to any page advertised itself as the homepage.
 *
 * Prefer `pageHead` — the canonical link lives there, and a route that reaches past it for the
 * meta array alone ships a page with no canonical, which is the gap this pair closed.
 */
export function pageMeta({ title, description, path, ogType, graph }: PageMeta) {
  const full = pageTitle(title);
  return [
    { title: full },
    { name: 'description', content: description },
    // Stated rather than inherited. The default is already index/follow, but the image and snippet
    // caps are NOT: without them an answer engine truncates a quotation at ~160 characters and
    // renders a thumbnail, which is the wrong shape for a product whose share card is a wide card.
    { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1' },
    { property: 'og:title', content: full },
    { property: 'og:description', content: description },
    { property: 'og:url', content: absoluteUrl(path) },
    { property: 'og:type', content: ogType ?? 'website' },
    { property: 'og:site_name', content: SITE_TITLE },
    { property: 'og:locale', content: 'en_US' },
    // Twitter falls back to og:* only when the twitter:* pair is absent entirely; naming both
    // keeps the card readable in the clients that do not implement that fallback.
    { name: 'twitter:title', content: full },
    { name: 'twitter:description', content: description },
    // TanStack renders this entry as <script type="application/ld+json"> (headContentUtils).
    ...(graph ? [{ 'script:ld+json': jsonLd(graph) }] : []),
  ];
}

/**
 * A page's whole head: its meta AND its canonical link.
 *
 * They are one function because they failed as two. `<link rel="canonical">` was absent from every
 * page on 2026-09-01 while og:url was set on all of them — the meta half had a helper and the link
 * half did not, so nobody remembered the link. A route now cannot state one without the other.
 */
export function pageHead(meta: PageMeta) {
  return {
    meta: pageMeta(meta),
    links: [{ rel: 'canonical', href: absoluteUrl(meta.path) }, ...(meta.links ?? [])],
  };
}

/** Crawlers refuse relative og:image. Vite `?url` imports are path-only. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${SITE_ORIGIN}${p}`;
}

/**
 * Search and answer engines get nothing from prose alone. Measured on production 2026-09-01, the
 * site emitted title/description/og:title/og:description/og:url and NOTHING else: no canonical, no
 * `robots` directive, no structured data — so there was no machine-readable entity for musterd
 * anywhere on the origin, and an answer engine had to infer the product from paragraphs.
 *
 * The graph is small on purpose and every node is one the site can defend:
 *   - Organization is musterd, with SandRise Studio as `parentOrganization` — the studio is the
 *     maker and never the product brand (docs/wiki/positioning.md, brand architecture).
 *   - No Person node: musterd is a product, not a portfolio piece.
 *   - No FAQPage until the site has real question-and-answer copy. A fabricated one is a
 *     structured-data violation, not a shortcut.
 */
export type JsonLdNode = Record<string, unknown>;

/**
 * Stable graph identifiers. The three site-wide nodes are declared once, on the landing page, and
 * every other route's graph points at them by `@id` — so a doc page carries its own TechArticle
 * and a reference, not a second copy of the product's identity that can drift from the first.
 */
export const GRAPH_ID = {
  organization: `${SITE_ORIGIN}/#organization`,
  website: `${SITE_ORIGIN}/#website`,
  software: `${SITE_ORIGIN}/#software`,
} as const;

/** The install line the landing page and llms.txt both lead with. */
export const SITE_INSTALL_COMMAND = 'brew tap SandRiseStudio/musterd && brew install musterd';

/** musterd the publisher. SandRise Studio sits above it, and is never named as the product. */
export function organizationNode(): JsonLdNode {
  return {
    '@type': 'Organization',
    '@id': GRAPH_ID.organization,
    name: SITE_TITLE,
    url: SITE_ORIGIN,
    description: SITE_TAGLINE,
    parentOrganization: {
      '@type': 'Organization',
      name: 'SandRise Studio',
      url: 'https://github.com/SandRiseStudio',
    },
  };
}

export function webSiteNode(): JsonLdNode {
  return {
    '@type': 'WebSite',
    '@id': GRAPH_ID.website,
    url: SITE_ORIGIN,
    name: SITE_TITLE,
    description: SITE_ONE_LINER,
    inLanguage: 'en',
    publisher: { '@id': GRAPH_ID.organization },
  };
}

export function softwareApplicationNode(): JsonLdNode {
  return {
    '@type': 'SoftwareApplication',
    '@id': GRAPH_ID.software,
    name: SITE_TITLE,
    url: SITE_ORIGIN,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    description: SITE_ONE_LINER,
    // schema.org has no "install command" property, and inventing one is worse than omitting it.
    // disambiguatingDescription is the honest home for the line a reader would actually type.
    disambiguatingDescription: `Install with: ${SITE_INSTALL_COMMAND}`,
    installUrl: `${SITE_ORIGIN}/docs/getting-started`,
    softwareHelp: { '@type': 'WebPage', url: `${SITE_ORIGIN}/docs` },
    // Free, and no account — the offer states it rather than leaving a reader to hunt for pricing.
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@id': GRAPH_ID.organization },
  };
}

/** Home is implicit on every trail; callers pass the steps below it. */
export function breadcrumbNode(trail: { name: string; path: string }[]): JsonLdNode {
  const steps = [{ name: SITE_TITLE, path: '/' }, ...trail];
  return {
    '@type': 'BreadcrumbList',
    itemListElement: steps.map((step, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: step.name,
      item: absoluteUrl(step.path),
    })),
  };
}

/** A page's list of links, as an ItemList — used by /docs, /blog and /roadmap. */
export function itemListNode(items: { name: string; path?: string }[]): JsonLdNode {
  return {
    '@type': 'ItemList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      ...(item.path ? { url: absoluteUrl(item.path) } : {}),
    })),
  };
}

/** Wrap page nodes as one `@graph`, which is what a route hands to `pageHead`. */
export function jsonLd(nodes: JsonLdNode[]) {
  return { '@context': 'https://schema.org', '@graph': nodes };
}
