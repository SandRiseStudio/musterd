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

/** Crawlers refuse relative og:image. Vite `?url` imports are path-only. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${SITE_ORIGIN}${p}`;
}
