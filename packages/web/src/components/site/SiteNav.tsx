import { MusterdChip } from '../../brand/MusterdWord';
import { hasBlog } from '../../content/generated/site-content';
import './site.css';

/**
 * The public-site nav. Daemon-connected surfaces never appear here (ADR 302), and neither does a
 * section with nothing in it — the Blog link appears only once a post exists, so the nav never
 * sends a stranger to an empty page.
 */
export const NAV_LINKS = [
  { label: 'Docs', href: '/docs' },
  ...(hasBlog ? [{ label: 'Blog', href: '/blog' }] : []),
  { label: 'GitHub', href: 'https://github.com/SandRiseStudio/musterd' },
];

// Plain <a> links, not router <Link>s: each public route is its own prerendered document, so a
// full navigation is the correct (and cheapest) transition.
export function SiteNav() {
  return (
    <header className="sitenav shell">
      <a className="sitenav__home mono" href="/" aria-label="musterd home">
        <MusterdChip size={18} className="sitenav__chip" />
        musterd
      </a>
      <nav className="sitenav__links" aria-label="Site">
        {NAV_LINKS.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
