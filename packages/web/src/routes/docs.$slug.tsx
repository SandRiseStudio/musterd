import { createFileRoute, notFound } from '@tanstack/react-router';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import '../components/site/Prose.css';

export const Route = createFileRoute('/docs/$slug')({
  // SSR-only content load (ADR 300) — see blog.$slug.tsx for the pattern's rationale.
  loader: async ({ params }) => {
    if (!import.meta.env.SSR) throw notFound();
    const { docsPages } = await import('../content/generated/site-content');
    const page = docsPages.find((p) => p.slug === params.slug);
    if (!page) throw notFound();
    return page;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.title ?? 'Docs'} — musterd` }] }),
  component: Doc,
});

function Doc() {
  const page = Route.useLoaderData();
  return (
    <main className="site-page">
      <SiteNav />
      <article className="prose">
        <h1>{page.title}</h1>
        {/* Build-time-rendered from the docs manifest — trusted content, no user input. */}
        <div dangerouslySetInnerHTML={{ __html: page.html }} />
      </article>
      <SiteFooter />
    </main>
  );
}
