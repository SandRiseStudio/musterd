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
}

/**
 * Per-page head metadata. Every public route MUST use this rather than inheriting the root's:
 * measured on production 2026-08-21, every page reported og:title "musterd" and og:url
 * "https://musterd.io", so a shared link to any page advertised itself as the homepage.
 */
export function pageMeta({ title, description, path }: PageMeta) {
  const full = pageTitle(title);
  return [
    { title: full },
    { name: 'description', content: description },
    { property: 'og:title', content: full },
    { property: 'og:description', content: description },
    { property: 'og:url', content: absoluteUrl(path) },
  ];
}

/** Crawlers refuse relative og:image. Vite `?url` imports are path-only. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${SITE_ORIGIN}${p}`;
}
