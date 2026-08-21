import { createFileRoute, notFound } from '@tanstack/react-router';
import { pageMeta } from '../brand/siteMeta';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import '../components/site/Prose.css';

export const Route = createFileRoute('/docs/')({
  // SSR-only content load (ADR 302) — see blog.$slug.tsx for the pattern's rationale.
  loader: async () => {
    if (!import.meta.env.SSR) throw notFound();
    const { docsPages } = await import('../content/generated/site-content');
    return docsPages.map(({ slug, title }) => ({ slug, title }));
  },
  head: () => ({
    meta: pageMeta({
      title: 'Docs',
      description: 'Install musterd, learn the concepts a team runs on, and read the protocol spec.',
      path: '/docs',
    }),
  }),
  component: DocsIndex,
});

function DocsIndex() {
  const pages = Route.useLoaderData();
  return (
    <main className="site-page">
      <SiteNav />
      <section className="prose">
        <h1>Docs</h1>
        <ul className="prose__list">
          {pages.map((p) => (
            <li key={p.slug}>
              <a href={`/docs/${p.slug}`}>{p.title}</a>
            </li>
          ))}
        </ul>
      </section>
      <SiteFooter />
    </main>
  );
}
