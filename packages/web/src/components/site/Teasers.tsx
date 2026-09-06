import { hasBlog } from '../../content/generated/site-content';
import './Teasers.css';

/**
 * Section links only — deliberately no import of the generated blog/docs LISTS: the landing chunk
 * stays free of content data, and the teasers never go stale against it. `hasBlog` is the one
 * exception and is a boolean by design, so the card for a section with no posts can be withheld
 * without pulling every post's HTML into this chunk to discover that.
 */
const TEASERS = [
  {
    title: 'Docs',
    body: 'Install, quickstart, the concepts a team runs on, and the protocol spec.',
    href: '/docs',
    cta: 'Read the docs',
  },
  ...(hasBlog
    ? [
        {
          title: 'Blog',
          body: 'Launch notes and what the team learns building musterd — with musterd.',
          href: '/blog',
          cta: 'Read the blog',
        },
      ]
    : []),
];

export function Teasers() {
  return (
    <section className="tz shell">
      {TEASERS.map((t) => (
        <a key={t.href} className="tz__card" href={t.href}>
          <h3>{t.title}</h3>
          <p>{t.body}</p>
          <span className="tz__cta mono">{t.cta} →</span>
        </a>
      ))}
    </section>
  );
}
