import { MusterdChip } from '../../brand/MusterdWord';
import './site.css';

/** The public-site nav. Daemon-connected surfaces never appear here (ADR 302). */
export const NAV_LINKS = [
  { label: 'Docs', href: '/docs' },
  { label: 'Blog', href: '/blog' },
  { label: 'Roadmap', href: '/roadmap' },
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
